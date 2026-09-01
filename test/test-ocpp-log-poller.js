'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createOcppLogPoller,
  parseRetryAfter,
} = require('../services/lib/ocpp-log-poller');

function response(status, body, headers = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => headers[name.toLowerCase()] || null },
    json: async () => body,
  };
}

test('pollOnce coalesces overlapping calls and uses bounded recent endpoint', async () => {
  let resolveFetch;
  const urls = [];
  const fetchFn = (url) => {
    urls.push(url);
    return new Promise((resolve) => { resolveFetch = resolve; });
  };
  const ingested = [];
  const poller = createOcppLogPoller({
    fetchFn,
    baseUrl: 'https://logs.example',
    token: 'test',
    processEntry: (entry) => ingested.push(entry),
    isDuplicate: () => false,
    now: () => Date.parse('2026-09-01T12:00:00Z'),
  });

  const first = poller.pollOnce();
  const second = poller.pollOnce();
  assert.strictEqual(first, second);
  resolveFetch(response(200, { data: { entries: [{
    timestamp: '2026-09-01T11:59:59.000Z', message: 'Heartbeat', level: 'INFO', logger: 'ocpp',
  }] } }));

  await first;
  assert.equal(urls.length, 1);
  assert.match(urls[0], /\/api\/logs\/recent\?/);
  assert.equal(ingested.length, 1);
  assert.equal(poller.getCursor(), '2026-09-01T11:59:59.001Z');
});

test('404 rolls safely to history during a staged deployment', async () => {
  const urls = [];
  const poller = createOcppLogPoller({
    fetchFn: async (url) => {
      urls.push(url);
      return urls.length === 1
        ? response(404, {})
        : response(200, { data: { entries: [] } });
    },
    baseUrl: 'https://logs.example', token: 'test',
    processEntry: () => {}, isDuplicate: () => false,
  });

  await poller.pollOnce();
  assert.match(urls[0], /\/recent\?/);
  assert.match(urls[1], /\/history\?/);
});

test('truncated recovery records the gap, consumes the page, and keeps draining', async () => {
  const processed = [];
  const errors = [];
  const poller = createOcppLogPoller({
    fetchFn: async () => response(200, { data: {
      truncated: true,
      has_more: true,
      next_cursor: 'bounded-page-2',
      resume_from: '2026-09-01T12:00:05Z',
      entries: [{ timestamp: '2026-09-01T12:00:00Z', message: 'x' }],
    } }),
    baseUrl: 'https://logs.example', token: 'test',
    processEntry: (entry) => { processed.push(entry); }, isDuplicate: () => false,
    logger: { log: () => {}, error: (...args) => errors.push(args.join(' ')) },
  });

  const result = await poller.pollOnce();
  assert.equal(result.continuityLost, true);
  assert.equal(result.nextDelayMs, 0);
  assert.equal(processed.length, 1);
  assert.equal(poller.getCursor(), null);
  assert.match(errors[0], /continuity gap/);
});

test('an empty truncated page reanchors at resume_from instead of looping forever', async () => {
  const poller = createOcppLogPoller({
    fetchFn: async () => response(200, { data: {
      truncated: true,
      has_more: false,
      resume_from: '2026-09-01T12:00:05Z',
      entries: [],
    } }),
    baseUrl: 'https://logs.example', token: 'test',
    processEntry: () => {}, isDuplicate: () => false,
    logger: { log: () => {}, error: () => {} },
  });

  await poller.pollOnce();
  assert.equal(poller.getCursor(), '2026-09-01T12:00:05.001Z');
});

test('bounded pages use the opaque cursor without skipping equal timestamps', async () => {
  const urls = [];
  let call = 0;
  const poller = createOcppLogPoller({
    fetchFn: async (url) => {
      urls.push(url);
      call += 1;
      return call === 1
        ? response(200, { data: {
          has_more: true,
          next_cursor: 'opaque-page-2',
          entries: [{ timestamp: '2026-09-01T12:00:00Z', message: 'first' }],
        } })
        : response(200, { data: {
          has_more: false,
          resume_from: '2026-09-01T12:00:00Z',
          entries: [{ timestamp: '2026-09-01T12:00:00Z', message: 'second' }],
        } });
    },
    baseUrl: 'https://logs.example', token: 'test',
    processEntry: () => {}, isDuplicate: () => false,
    now: () => Date.parse('2026-09-01T12:00:45Z'),
  });

  await poller.pollOnce();
  await poller.pollOnce();

  const first = new URL(urls[0]);
  const second = new URL(urls[1]);
  assert.equal(second.searchParams.get('cursor'), 'opaque-page-2');
  assert.equal(second.searchParams.get('start_time'), first.searchParams.get('start_time'));
  assert.equal(poller.getCursor(), '2026-09-01T12:00:00.001Z');
});

test('scheduler waits for completion and honors Retry-After without overlap', async () => {
  const scheduled = [];
  let resolveFetch;
  let fetches = 0;
  const poller = createOcppLogPoller({
    fetchFn: async () => {
      fetches += 1;
      return new Promise((resolve) => { resolveFetch = resolve; });
    },
    baseUrl: 'https://logs.example', token: 'test',
    processEntry: () => {}, isDuplicate: () => false,
    intervalMs: 5000,
    setTimeoutFn: (fn, delay) => {
      scheduled.push({ fn, delay });
      return scheduled.length;
    },
    clearTimeoutFn: () => {},
  });

  poller.start();
  assert.equal(scheduled.shift().delay, 0);

  // Run the first timer, but leave its HTTP request pending. No next timer is
  // installed until that request settles.
  const activeTick = poller.pollOnce();
  assert.equal(fetches, 1);
  assert.equal(scheduled.length, 0);
  resolveFetch(response(503, {}, { 'retry-after': '12' }));
  await assert.rejects(activeTick, /REST 503/);

  // Exercise the scheduler path itself on a second attempt.
  poller.stop();
  poller.start();
  const tick = scheduled.shift();
  const tickPromise = tick.fn();
  assert.equal(scheduled.length, 0);
  resolveFetch(response(503, {}, { 'retry-after': '12' }));
  await tickPromise;
  assert.equal(scheduled.at(-1).delay, 12_000);
  poller.stop();
});

test('Retry-After is not shortened by the local exponential-backoff cap', async () => {
  const scheduled = [];
  const poller = createOcppLogPoller({
    fetchFn: async () => response(429, {}, { 'retry-after': '300' }),
    baseUrl: 'https://logs.example', token: 'test',
    processEntry: () => {}, isDuplicate: () => false,
    intervalMs: 5000,
    maxBackoffMs: 60_000,
    setTimeoutFn: (fn, delay) => {
      scheduled.push({ fn, delay });
      return scheduled.length;
    },
    clearTimeoutFn: () => {},
    logger: { log: () => {}, error: () => {} },
  });

  poller.start();
  await scheduled.shift().fn();

  assert.equal(scheduled.at(-1).delay, 300_000);
  poller.stop();
});

test('a stopped scheduler generation cannot reschedule after restart', async () => {
  const scheduled = [];
  let resolveFetch;
  const poller = createOcppLogPoller({
    fetchFn: async () => new Promise((resolve) => { resolveFetch = resolve; }),
    baseUrl: 'https://logs.example', token: 'test',
    processEntry: () => {}, isDuplicate: () => false,
    intervalMs: 5000,
    setTimeoutFn: (fn, delay) => {
      scheduled.push({ fn, delay });
      return scheduled.length;
    },
    clearTimeoutFn: () => {},
  });

  poller.start();
  const staleTick = scheduled.shift().fn();
  poller.stop();
  poller.start();
  const currentTick = scheduled.shift().fn();

  resolveFetch(response(200, { data: { entries: [] } }));
  await Promise.all([staleTick, currentTick]);

  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delay, 5000);
  poller.stop();
});

test('Retry-After supports seconds and HTTP dates', () => {
  const now = Date.parse('2026-09-01T12:00:00Z');
  assert.equal(parseRetryAfter('2', now), 2000);
  assert.equal(parseRetryAfter('Tue, 01 Sep 2026 12:00:03 GMT', now), 3000);
  assert.equal(parseRetryAfter('invalid', now), null);
});

test('a stalled recovery request aborts at its deadline', async () => {
  const requestTimers = [];
  let seenSignal;
  const poller = createOcppLogPoller({
    fetchFn: async (url, options) => {
      seenSignal = options.signal;
      return new Promise(() => {});
    },
    baseUrl: 'https://logs.example', token: 'test',
    processEntry: () => {}, isDuplicate: () => false,
    requestTimeoutMs: 10_000,
    setRequestTimeoutFn: (fn, delay) => {
      requestTimers.push({ fn, delay });
      return requestTimers.length;
    },
    clearRequestTimeoutFn: () => {},
  });

  const pending = poller.pollOnce();
  assert.equal(requestTimers[0].delay, 10_000);
  requestTimers[0].fn();

  await assert.rejects(pending, /timed out/);
  assert.equal(seenSignal.aborted, true);
});

test('the request deadline remains active while the JSON body is stalled', async () => {
  const requestTimers = [];
  let seenSignal;
  const poller = createOcppLogPoller({
    fetchFn: async (url, options) => {
      seenSignal = options.signal;
      return {
        status: 200,
        ok: true,
        headers: { get: () => null },
        json: async () => new Promise(() => {}),
      };
    },
    baseUrl: 'https://logs.example', token: 'test',
    processEntry: () => {}, isDuplicate: () => false,
    requestTimeoutMs: 10_000,
    setRequestTimeoutFn: (fn, delay) => {
      requestTimers.push({ fn, delay });
      return requestTimers.length;
    },
    clearRequestTimeoutFn: () => {},
  });

  const pending = poller.pollOnce();
  await Promise.resolve();
  assert.equal(requestTimers[0].delay, 10_000);
  requestTimers[0].fn();

  await assert.rejects(pending, /timed out/);
  assert.equal(seenSignal.aborted, true);
});
