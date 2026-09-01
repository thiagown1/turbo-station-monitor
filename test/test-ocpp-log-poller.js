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

test('truncated recovery never advances the cursor', async () => {
  let processed = 0;
  const poller = createOcppLogPoller({
    fetchFn: async () => response(200, { data: {
      truncated: true,
      entries: [{ timestamp: '2026-09-01T12:00:00Z', message: 'x' }],
    } }),
    baseUrl: 'https://logs.example', token: 'test',
    processEntry: () => { processed += 1; }, isDuplicate: () => false,
  });

  await assert.rejects(poller.pollOnce(), /truncated/);
  assert.equal(poller.getCursor(), null);
  assert.equal(processed, 0);
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

test('Retry-After supports seconds and HTTP dates', () => {
  const now = Date.parse('2026-09-01T12:00:00Z');
  assert.equal(parseRetryAfter('2', now), 2000);
  assert.equal(parseRetryAfter('Tue, 01 Sep 2026 12:00:03 GMT', now), 3000);
  assert.equal(parseRetryAfter('invalid', now), null);
});
