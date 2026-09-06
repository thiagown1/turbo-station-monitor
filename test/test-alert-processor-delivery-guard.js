'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const {
  advanceDelivery,
  createSupportApiTransport,
  resolveActivation,
} = require('../services/lib/alert-delivery-guard');
const {
  applyQueueDecisions,
  enqueueAlert,
  queueId,
  readAlertQueue,
} = require('../services/lib/alert-queue');

function response(status, json) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => json,
  };
}

function readyActivation() {
  return resolveActivation({
    OCPP_ALERTS_ENABLED: '1',
    ALERT_WHATSAPP_CONV: 'conv_test',
    ALERT_WHATSAPP_BRAND: 'turbo_station',
    SUPPORT_API_SECRET: 'test-secret',
    SUPPORT_API_URL: 'https://support.test',
  });
}

function alert(suffix, timestamp = '2026-09-02T21:00:00.000Z') {
  return {
    type: `charger_faulted_${suffix}`,
    severity: 'critical',
    chargerId: 'TEST123',
    timestamp,
    message: `fault ${suffix}`,
  };
}

test('activation is fail-closed until the explicit switch and every route setting exist', () => {
  assert.deepEqual(resolveActivation({}), {
    enabled: false,
    ready: false,
    reason: 'kill_switch_disabled',
  });
  const incomplete = resolveActivation({ OCPP_ALERTS_ENABLED: '1' });
  assert.equal(incomplete.enabled, true);
  assert.equal(incomplete.ready, false);
  assert.match(incomplete.reason, /ALERT_WHATSAPP_CONV/);
  assert.match(incomplete.reason, /SUPPORT_API_SECRET/);
  assert.match(incomplete.reason, /SUPPORT_API_URL/);
  assert.equal(readyActivation().ready, true);
});

test('a support API 2xx is not an ACK; delivery is accepted only after status=sent', async () => {
  const calls = [];
  const transport = createSupportApiTransport({
    activation: readyActivation(),
    pollScheduleMs: [0],
    sleep: async () => {},
    fetchImpl: async (_url, options = {}) => {
      calls.push(options.method || 'GET');
      if (options.method === 'POST') return response(200, { id: 'msg_1' });
      return response(200, { messages: [{ id: 'msg_1', delivery_status: 'sent' }] });
    },
  });

  const result = await transport.send('alert');
  assert.deepEqual(result, { outcome: 'delivered', messageId: 'msg_1', status: 'sent' });
  assert.deepEqual(calls, ['POST', 'GET']);
});

test('an unconfirmed accepted message is retained and late-confirmed without a duplicate POST', async () => {
  let posts = 0;
  let currentStatus = 'pending';
  const transport = createSupportApiTransport({
    activation: readyActivation(),
    pollScheduleMs: [0],
    sleep: async () => {},
    fetchImpl: async (_url, options = {}) => {
      if (options.method === 'POST') {
        posts += 1;
        return response(200, { id: 'msg_pending' });
      }
      return response(200, { messages: [{ id: 'msg_pending', delivery_status: currentStatus }] });
    },
  });

  const first = await advanceDelivery({}, 'alert', transport, { now: 1_000 });
  assert.equal(first.delivered, false);
  assert.equal(first.patch._deliveryMessageId, 'msg_pending');
  assert.equal(posts, 1);

  currentStatus = 'sent';
  const second = await advanceDelivery(first.patch, 'alert', transport, { now: 2_000 });
  assert.equal(second.delivered, true);
  assert.equal(second.reason, 'late_confirmed');
  assert.equal(posts, 1, 'late confirmation must not enqueue a duplicate message');
});

test('an ambiguous POST is retained for operator review and is never retried blindly', async () => {
  let posts = 0;
  const transport = createSupportApiTransport({
    activation: readyActivation(),
    pollScheduleMs: [0],
    sleep: async () => {},
    logger: { error() {} },
    fetchImpl: async (_url, options = {}) => {
      if (options.method === 'POST') {
        posts += 1;
        throw new Error('connection reset after request');
      }
      return response(503, null);
    },
  });

  const first = await advanceDelivery({}, 'alert', transport, { now: 1_000 });
  assert.equal(first.delivered, false);
  assert.equal(first.patch._deliveryAmbiguous, true);
  assert.equal(first.reason, 'ambiguous');

  const second = await advanceDelivery(first.patch, 'alert', transport, { now: 120_000 });
  assert.equal(second.delivered, false);
  assert.equal(second.reason, 'ambiguous_requires_operator');
  assert.equal(posts, 1, 'ambiguous acceptance must block automatic replacement');
});

test('an explicitly failed message waits for backoff before a replacement POST', async () => {
  let posts = 0;
  const transport = {
    status: async () => 'failed',
    send: async () => {
      posts += 1;
      return { outcome: 'delivered', messageId: 'msg_replacement', status: 'sent' };
    },
  };
  const item = { _deliveryMessageId: 'msg_failed', _deliveryAttemptAt: 100_000 };

  const early = await advanceDelivery(item, 'alert', transport, { now: 120_000, retryMs: 60_000 });
  assert.equal(early.delivered, false);
  assert.equal(early.reason, 'retry_backoff');
  assert.equal(posts, 0);

  const later = await advanceDelivery(item, 'alert', transport, { now: 170_000, retryMs: 60_000 });
  assert.equal(later.delivered, true);
  assert.equal(posts, 1);
});

test('queue ACK removes only the acknowledged snapshot item and preserves a concurrent append', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alert-queue-test-'));
  const file = path.join(dir, 'pending.json');
  try {
    const first = enqueueAlert(file, alert('one'));
    const snapshot = first.queue;
    enqueueAlert(file, alert('two'));

    applyQueueDecisions(file, new Map([
      [queueId(snapshot[0]), { remove: true }],
    ]));

    const remaining = readAlertQueue(file);
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].message, 'fault two');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('collector restart reads the durable queue and deduplicates the same recent alert', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alert-queue-restart-'));
  const file = path.join(dir, 'pending.json');
  try {
    const queued = alert('restart');
    assert.equal(enqueueAlert(file, queued).added, true);
    assert.equal(readAlertQueue(file).length, 1);
    assert.equal(enqueueAlert(file, queued, new Date(queued.timestamp).getTime() + 1_000).added, false);
    assert.equal(readAlertQueue(file).length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a corrupt queue fails closed instead of being overwritten as empty', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alert-queue-corrupt-'));
  const file = path.join(dir, 'pending.json');
  try {
    fs.writeFileSync(file, '{not-json');
    assert.throws(() => enqueueAlert(file, alert('new')), /JSON/);
    assert.equal(fs.readFileSync(file, 'utf8'), '{not-json');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the executable refuses to run when the kill switch is absent', () => {
  const env = { ...process.env };
  delete env.OCPP_ALERTS_ENABLED;
  delete env.ALERT_WHATSAPP_CONV;
  delete env.SUPPORT_API_SECRET;
  delete env.MONITOR_API_SECRET;
  delete env.SUPPORT_API_URL;
  const run = spawnSync(process.execPath, ['services/alert-processor.js'], {
    cwd: path.join(__dirname, '..'),
    env,
    encoding: 'utf8',
    timeout: 5_000,
  });
  assert.notEqual(run.status, 0);
  assert.match(`${run.stdout}\n${run.stderr}`, /OCPP alerts are disabled/);
});

test('PM2 bounds activation failures instead of entering a tight restart loop', () => {
  const ecosystem = require('../ecosystem.config');
  const app = ecosystem.apps.find((candidate) => candidate.name === 'ocpp-alerts');
  assert.ok(app);
  assert.equal(app.max_restarts, 3);
  assert.equal(app.min_uptime, '30s');
  assert.ok(app.restart_delay >= 5_000);
});
