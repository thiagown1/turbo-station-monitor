#!/usr/bin/env node
/**
 * Session compaction CLI tests — Support Copilot (regression for issue #48)
 *
 * Compaction was triggered by sending the literal `/compact` as an agent
 * message. OpenClaw 2026.7.1-2 rejects that path outright:
 *
 *   Slash commands cannot be executed via --message from the CLI.
 *   Use: openclaw sessions compact <key>
 *
 * On the VPS the last successful compaction was 2026-08-14 23:12:22, the gateway
 * restarted onto 2026.7.1-2 at 23:58:07, and the first rejection came at
 * 2026-08-15 00:20:27 — after which every compaction failed (102 rejections,
 * zero successes over four days) while the DB happily recorded 212 of them.
 *
 * These tests pin the two things that made that outage invisible:
 *   1. the argv actually handed to the CLI, and
 *   2. that a reported failure is surfaced as a failure rather than swallowed.
 *
 * They drive `compactSessionViaCli`'s injected `exec` rather than spawning a
 * real process — the argv is the whole subject of the test, and a fake binary
 * would add a cross-platform spawn problem (`execFile` of a `.cmd` is EINVAL on
 * Windows) for no extra coverage.
 *
 * Run: node services/support-copilot/__tests__/session-compact.test.js
 */
'use strict';

const assert = require('node:assert/strict');

const {
  sessionKey,
  compactSessionViaCli,
  compactSessionWithFallback,
} = require('../lib/session-compact');

let passed = 0;
let failed = 0;
const pending = [];

function test(name, fn) {
  pending.push({ name, fn });
}

async function run() {
  console.log('\n🧪 session-compact (issue #48 — compaction actually runs)\n');
  for (const { name, fn } of pending) {
    try {
      await fn();
      passed++;
      console.log(`  ✓ ${name}`);
    } catch (err) {
      failed++;
      console.error(`  ✗ ${name}`);
      console.error(`    ${err.message}`);
    }
  }
  console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

// ─── Fake exec ───────────────────────────────────────────────────────────────

/**
 * Build an `execFile` stand-in that records every invocation and replies with a
 * scripted result.
 *
 * @param {Array<{stdout?: string, stderr?: string, error?: Error}>|object} script
 *   One reply reused for every call, or a queue consumed in order.
 */
function fakeExec(script) {
  const queue = Array.isArray(script) ? [...script] : null;
  const calls = [];
  const fn = (bin, args, options, cb) => {
    calls.push({ bin, args, options });
    const reply = (queue ? queue.shift() : script) || {};
    // Real execFile is async; resolving on a later tick keeps the seam honest.
    setImmediate(() => cb(reply.error || null, reply.stdout || '', reply.stderr || ''));
  };
  fn.calls = calls;
  return fn;
}

const AGENT = 'support_turbo_station';
const SESSION = 'support-copilot-conv_x';
const okJson = { stdout: JSON.stringify({ ok: true }) };

// ─── sessionKey ──────────────────────────────────────────────────────────────

test('sessionKey builds the explicit-session key the CLI expects', () => {
  assert.equal(
    sessionKey(AGENT, 'support-copilot-conv_abc123'),
    'agent:support_turbo_station:explicit:support-copilot-conv_abc123'
  );
});

test('REGRESSION: sessionKey targets the explicit session, never the shared :main pointer', () => {
  // `agent:<id>:main` also resolves, but points at whichever session was last
  // made "main" — compacting that would truncate an unrelated conversation.
  const key = sessionKey(AGENT, 'support-copilot-conv_abc123');
  assert.ok(key.includes(':explicit:'), `key must be explicit-scoped, got ${key}`);
  assert.ok(!/:main$/.test(key), `key must not target the main pointer, got ${key}`);
});

// ─── The actual command ──────────────────────────────────────────────────────

test('REGRESSION: compaction calls `sessions compact`, never `--message /compact`', async () => {
  const exec = fakeExec(okJson);
  const res = await compactSessionViaCli(SESSION, AGENT, { exec });
  assert.equal(res.ok, true);

  assert.equal(exec.calls.length, 1, 'the CLI was never invoked');
  const { args } = exec.calls[0];
  assert.deepEqual(args.slice(0, 3), ['sessions', 'compact', `agent:${AGENT}:explicit:${SESSION}`]);

  // The exact shape OpenClaw 2026.7.1-2 refuses.
  assert.ok(!args.includes('--message'), `must not use --message, got: ${args.join(' ')}`);
  assert.ok(!args.includes('/compact'), `must not pass /compact as a message, got: ${args.join(' ')}`);
  assert.ok(args.includes('--agent'), 'must scope the call to the owning agent');
  assert.ok(args.includes('--json'), 'must request JSON so failures are machine-readable');
});

test('the call carries an explicit RPC timeout and a child deadline above it', async () => {
  const exec = fakeExec(okJson);
  await compactSessionViaCli(SESSION, AGENT, { exec, timeoutMs: 60_000 });

  const { args, options } = exec.calls[0];
  assert.equal(args[args.indexOf('--timeout') + 1], '60000');
  assert.ok(
    options.timeout > 60_000,
    `child deadline (${options.timeout}) must exceed the RPC timeout so the CLI can report a structured error`
  );
});

test('summarizing mode does not pass --max-lines', async () => {
  const exec = fakeExec(okJson);
  const res = await compactSessionViaCli(SESSION, AGENT, { exec });
  assert.equal(res.mode, 'summarize');
  assert.ok(!exec.calls[0].args.includes('--max-lines'));
});

test('truncation mode passes --max-lines', async () => {
  const exec = fakeExec(okJson);
  const res = await compactSessionViaCli(SESSION, AGENT, { exec, maxLines: 250 });
  assert.equal(res.mode, 'truncate');
  const { args } = exec.calls[0];
  assert.equal(args[args.indexOf('--max-lines') + 1], '250');
});

// ─── Failure reporting ───────────────────────────────────────────────────────

test('REGRESSION: `{"ok":false}` with no process error is reported as a failure', async () => {
  // This is the exact payload the real CLI returned on the gateway timeout, and
  // it came back without a non-zero exit — so a check on the exit code alone
  // reports a phantom success. That is the class of mistake that hid the outage.
  const exec = fakeExec({ stdout: JSON.stringify({ ok: false, error: 'gateway timeout after 10000ms' }) });
  const res = await compactSessionViaCli(SESSION, AGENT, { exec });

  assert.equal(res.ok, false, 'ok:false without a process error must not count as success');
  assert.match(res.error, /gateway timeout/);
});

test('the slash-command rejection is reported as a failure with its reason', async () => {
  const exec = fakeExec({
    error: Object.assign(new Error('Command failed'), { code: 1 }),
    stdout: 'Slash commands cannot be executed via --message from the CLI. Use: openclaw sessions compact <key>',
  });
  const res = await compactSessionViaCli(SESSION, AGENT, { exec });

  assert.equal(res.ok, false);
  assert.ok(res.error && res.error.length > 0, 'a failure must carry a diagnosable reason');
});

test('a spawn error resolves to a failure instead of throwing', async () => {
  const exec = fakeExec({ error: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) });
  const res = await compactSessionViaCli(SESSION, AGENT, { exec });
  assert.equal(res.ok, false);
  assert.match(res.error, /ENOENT/);
});

test('unparseable stdout is a failure, not a silent success', async () => {
  const exec = fakeExec({ stdout: 'some banner text that is not json' });
  const res = await compactSessionViaCli(SESSION, AGENT, { exec });
  assert.equal(res.ok, false);
  assert.ok(res.error);
});

test('empty output is a failure', async () => {
  const exec = fakeExec({ stdout: '' });
  const res = await compactSessionViaCli(SESSION, AGENT, { exec });
  assert.equal(res.ok, false);
});

// ─── Fallback ────────────────────────────────────────────────────────────────

test('REGRESSION: summarization failure falls back to truncation', async () => {
  // An overgrown session is exactly the one that cannot be summarized (the real
  // 39MB transcript timed out even at a 4-minute deadline), so without this
  // fallback the session that most needs compacting never gets it.
  const exec = fakeExec([
    { stdout: JSON.stringify({ ok: false, error: 'gateway timeout after 240000ms' }) },
    { stdout: JSON.stringify({ ok: true }) },
  ]);
  const res = await compactSessionWithFallback(SESSION, AGENT, { exec });

  assert.equal(exec.calls.length, 2, `expected a summarize attempt then a truncate attempt, got ${exec.calls.length}`);
  assert.ok(!exec.calls[0].args.includes('--max-lines'), 'first attempt should summarize');
  assert.ok(exec.calls[1].args.includes('--max-lines'), 'second attempt should truncate');
  assert.equal(res.ok, true);
  assert.equal(res.mode, 'truncate');
});

test('a fallback that also fails still reports failure', async () => {
  const exec = fakeExec({ stdout: JSON.stringify({ ok: false, error: 'gateway timeout' }) });
  const res = await compactSessionWithFallback(SESSION, AGENT, { exec });
  assert.equal(exec.calls.length, 2);
  assert.equal(res.ok, false, 'both attempts failed, so the caller must not stamp compacted_at');
});

test('forceTruncate skips the summarize attempt entirely', async () => {
  const exec = fakeExec(okJson);
  const res = await compactSessionWithFallback(SESSION, AGENT, { exec, forceTruncate: true });

  assert.equal(exec.calls.length, 1, 'oversized sessions should not waste an attempt on summarization');
  assert.ok(exec.calls[0].args.includes('--max-lines'));
  assert.equal(res.ok, true);
  assert.equal(res.mode, 'truncate');
});

test('a successful summarization does not attempt truncation', async () => {
  const exec = fakeExec(okJson);
  const res = await compactSessionWithFallback(SESSION, AGENT, { exec });

  assert.equal(exec.calls.length, 1, 'no fallback should run when summarization works');
  assert.equal(res.ok, true);
  assert.equal(res.mode, 'summarize');
});

test('the fallback default keeps a bounded, non-zero number of lines', async () => {
  const exec = fakeExec(okJson);
  await compactSessionWithFallback(SESSION, AGENT, { exec, forceTruncate: true });

  const { args } = exec.calls[0];
  const n = parseInt(args[args.indexOf('--max-lines') + 1], 10);
  assert.ok(Number.isInteger(n) && n > 0, `--max-lines must be a positive integer, got ${n}`);
  assert.ok(n <= 5000, `--max-lines default (${n}) should stay small enough to actually shrink a session`);
});

run();
