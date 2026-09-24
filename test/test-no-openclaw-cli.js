#!/usr/bin/env node
/**
 * The monitor services must not depend on the OpenClaw harness (`openclaw
 * agent` / `openclaw message send`) so the gateway can be switched off.
 *
 *  - alert-engine: Telegram path removed; a leftover ALERT_TELEGRAM_GROUP must
 *    not spawn anything, and the alert still goes to WhatsApp.
 *  - deploy-health-check: notices go through the operational WhatsApp relay
 *    and report accepted / skipped / failed without spawning.
 *  - static guard: no shipped runtime file shells out to `openclaw`, except the
 *    documented consumers that still need the gateway (see ALLOWED below).
 *
 * Run: node --test test/test-no-openclaw-cli.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');

const ROOT = path.join(__dirname, '..');

// Record (and block) every child-process entry point before loading services.
const spawned = [];
for (const fn of ['exec', 'execFile', 'spawn', 'fork', 'execSync', 'execFileSync', 'spawnSync']) {
  const original = childProcess[fn];
  childProcess[fn] = (...args) => {
    spawned.push([fn, String(args[0])]);
    if (String(args[0]).includes('openclaw')) throw new Error(`openclaw spawn blocked: ${fn}`);
    return original(...args);
  };
}

process.env.ALERT_TELEGRAM_GROUP = 'telegram:-100'; // stale .env value must be ignored
process.env.SUPPORT_API_SECRET = 'test-secret';
process.env.WHATSAPP_DELIVERY_POLL_MS = '1';

const AlertEngine = require('../services/alert-engine');
const { notify } = require('../services/deploy-health-check');

function openclawSpawns() {
  return spawned.filter(([, cmd]) => cmd.includes('openclaw'));
}

function stubWhatsapp({ postStatus = 200, deliveryStatus = 'sent' } = {}) {
  global.fetch = async (url, opts = {}) => {
    const method = (opts.method || 'GET').toUpperCase();
    if (method === 'POST') {
      return { ok: postStatus < 300, status: postStatus, json: async () => ({ id: 'msg_1' }) };
    }
    return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'msg_1', delivery_status: deliveryStatus }] }) };
  };
}

test('alert-engine delivers over WhatsApp only, even with ALERT_TELEGRAM_GROUP set', async () => {
  stubWhatsapp();
  const engine = Object.create(AlertEngine.prototype);
  assert.equal(typeof engine.sendTelegramAlert, 'undefined');
  const result = await engine.dispatchAlert('alerta de teste');
  assert.deepEqual(result, { sent: true, waMessageId: 'msg_1' });
  assert.deepEqual(openclawSpawns(), []);
});

test('alert-engine reports unsent when WhatsApp fails, with no fallback channel', async () => {
  stubWhatsapp({ postStatus: 503 });
  const engine = Object.create(AlertEngine.prototype);
  const result = await engine.dispatchAlert('alerta de teste');
  assert.equal(result.sent, false);
  assert.deepEqual(openclawSpawns(), []);
});

test('deploy-health-check notice is accepted through the operational relay', async () => {
  const calls = [];
  const ok = await notify('deploy ok', {
    send: async (body, source) => { calls.push({ body, source }); return { status: 'accepted', messageId: 'm' }; },
  });
  assert.equal(ok, true);
  assert.deepEqual(calls, [{ body: 'deploy ok', source: 'deploy-health-check' }]);
  assert.deepEqual(openclawSpawns(), []);
});

test('deploy-health-check notice is not counted as sent when skipped or failing', async () => {
  assert.equal(await notify('x', { send: async () => ({ status: 'skipped_disabled' }) }), false);
  assert.equal(await notify('x', { send: async () => ({ status: 'failed', reason: 'http_500' }) }), false);
  assert.equal(await notify('x', { send: async () => { throw new Error('boom'); } }), false);
  // Real relay with the default (inert) configuration: skipped, no network, no spawn.
  const saved = process.env.OPERATIONAL_WHATSAPP_ENABLED;
  delete process.env.OPERATIONAL_WHATSAPP_ENABLED;
  try {
    assert.equal(await notify('x'), false);
  } finally {
    if (saved !== undefined) process.env.OPERATIONAL_WHATSAPP_ENABLED = saved;
  }
  assert.deepEqual(openclawSpawns(), []);
});

// Runtime consumers that still invoke OpenClaw on purpose. Each is reported in
// the PR/docs; removing one from here must come with its migration.
const ALLOWED = new Set([
  'services/alert-processor.js', // ocpp-alerts — moved off the CLI in PR #75
  'services/sweep-orchestrator.js', // white-label sweep loop drives OpenClaw scout/coder agents + cron
  'services/budget-guardian.js', // gateway admin tooling (`openclaw gateway restart`)
  'services/support-copilot/lib/contador-runtime.js', // Contador primary model
  'services/support-copilot/lib/contador-model-runner.js',
  'services/ai-subscription-gateway/index.js', // ai-openclaw-agent (pm2)
  'services/ai-subscription-gateway/openclaw-gateway-runner.mjs',
]);
const EXCLUDED_DIRS = new Set(['node_modules', '__tests__', 'test', 'tests', '.git', 'docs']);
const CLI_PATTERNS = [
  /openclaw\s+(message|agent|sessions|gateway)\b/,
  /\(\s*['"`]openclaw['"`]\s*,/,
  /\(\s*OPENCLAW_BIN\b/,
  /bin:\s*openClawBin\b|openClawBin\s*[,)]/,
];

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUDED_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(c|m)?js$/.test(entry.name)) out.push(full);
  }
  return out;
}

test('no shipped runtime file shells out to openclaw outside the allowlist', () => {
  const offenders = [];
  for (const file of [...walk(path.join(ROOT, 'services')), ...walk(path.join(ROOT, 'scripts'))]) {
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    if (ALLOWED.has(rel)) continue;
    const code = fs.readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
    if (CLI_PATTERNS.some((re) => re.test(code))) offenders.push(rel);
  }
  assert.deepEqual(offenders, []);
});
