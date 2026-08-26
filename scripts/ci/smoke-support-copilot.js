#!/usr/bin/env node
/**
 * Boot smoke test — support-copilot.
 *
 * Starts services/support-copilot/index.js for real, against a throwaway
 * SQLite DB and a free port, and asserts GET /health returns 200. This is
 * the direct regression test for the incident that motivated this CI setup:
 * `node index.js` crashing on startup with `Cannot find module` because a
 * required file existed live on the deploy box but was never committed
 * (see PR #19). check-requires.js catches the static case; this catches
 * anything that only fails at actual runtime (e.g. a migration throwing).
 *
 * Run: node scripts/ci/smoke-support-copilot.js
 */
'use strict';

const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const SERVICE_DIR = path.join(__dirname, '..', '..', 'services', 'support-copilot');
const PORT = 39500 + Math.floor(Math.random() * 500);
const DB_PATH = path.join(os.tmpdir(), `support-copilot-smoke-${process.pid}-${Date.now()}.sqlite`);

// The service runs ~25 SQLite migrations before it listens, so boot time
// scales with the runner's disk speed. 15s was tight enough that a slow
// GitHub Actions runner failed the job on a service that had in fact booted
// (PR #49, run 32147642479 — the captured output showed the "Listening" line;
// the identical commit passed on a re-run, 26s of wall clock vs 52s on the
// failing one). This is a liveness check, not a performance test: give the
// boot generous room. A genuinely broken boot is still reported immediately
// by the "process exited early" race below rather than after the timeout.
const BOOT_TIMEOUT_MS = 60000;

// Printed by services/support-copilot/index.js once the HTTP server is bound.
const LISTENING_MARKER = 'Listening on';

function cleanupDb() {
  // Best-effort: a just-killed child process may still hold the file open
  // for a moment (especially on Windows) — never let cleanup mask the
  // actual pass/fail result of the smoke test.
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.rmSync(`${DB_PATH}${suffix}`, { force: true });
    } catch (err) {
      console.warn(`(cleanup) could not remove ${DB_PATH}${suffix}: ${err.message}`);
    }
  }
}

/**
 * Message for a boot that never answered /health before the deadline.
 *
 * A slow boot and a genuinely broken one used to produce the identical
 * "service never became healthy within the boot timeout" line, which is what
 * made the PR #49 failure take a re-run to diagnose. Whether the child already
 * announced itself as listening separates the two cases.
 */
function describeBootTimeout({ sawListening, timeoutMs, lastError }) {
  const seconds = Math.round(timeoutMs / 1000);
  const tail = lastError ? ` (last connection error: ${lastError})` : '';
  return sawListening
    ? `service printed "${LISTENING_MARKER}" but /health never answered within ${seconds}s — `
      + `the HTTP server bound and then wedged, or it is listening on another port${tail}`
    : `service never printed "${LISTENING_MARKER}" within ${seconds}s — it either crashed `
      + `without exiting or is still running its boot migrations${tail}`;
}

function waitForHealth(deadline, { sawListening = () => false, timeoutMs = BOOT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get({ host: '127.0.0.1', port: PORT, path: '/health', timeout: 1000 }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          if (res.statusCode === 200 && JSON.parse(body).ok === true) {
            resolve();
          } else {
            reject(new Error(`/health returned ${res.statusCode}: ${body}`));
          }
        });
      });
      req.on('error', (err) => {
        if (Date.now() > deadline) {
          reject(new Error(describeBootTimeout({
            sawListening: sawListening(),
            timeoutMs,
            lastError: err.message,
          })));
        } else {
          setTimeout(attempt, 300);
        }
      });
    };
    attempt();
  });
}

function request({ path: requestPath, method = 'GET', headers = {}, body = '' }) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: requestPath, method, headers, timeout: 2000,
    }, (res) => {
      let responseBody = '';
      res.on('data', (chunk) => { responseBody += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: responseBody }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function main() {
  // SUPPORT_COPILOT_PORT, not PORT: services deliberately ignore the generic
  // PORT (see services/lib/service-port.js). PORT is deleted rather than
  // overwritten so the smoke run does not trip the drift warning if the
  // runner's own environment happens to carry one.
  const childEnv = {
    ...process.env,
    SUPPORT_COPILOT_PORT: String(PORT),
    SUPPORT_COPILOT_DB_PATH: DB_PATH,
    SUPPORT_API_SECRET: 'smoke-secret-not-real',
    EVOLUTION_WEBHOOK_SECRET: '',
  };
  delete childEnv.PORT;

  const child = spawn(process.execPath, ['index.js'], {
    cwd: SERVICE_DIR,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout.on('data', (c) => { output += c; });
  child.stderr.on('data', (c) => { output += c; });

  const exitedEarly = new Promise((resolve) => {
    child.on('exit', (code) => resolve(code));
  });

  try {
    await Promise.race([
      waitForHealth(Date.now() + BOOT_TIMEOUT_MS, {
        sawListening: () => output.includes(LISTENING_MARKER),
      }),
      exitedEarly.then((code) => { throw new Error(`process exited early with code ${code}\n${output}`); }),
    ]);
    const webhook = await request({
      path: '/api/support/ingest/evolution',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    if (webhook.status !== 503) throw new Error(`unconfigured Evolution webhook returned ${webhook.status}, expected 503`);

    const media = await request({ path: '/api/support/media/missing.pdf' });
    if (media.status !== 401) throw new Error(`unauthenticated media returned ${media.status}, expected 401`);

    console.log('✓ support-copilot booted, health passed, and inbound/media routes fail closed');
    process.exitCode = 0;
  } catch (err) {
    console.error('✗ support-copilot boot smoke test failed:', err.message);
    console.error('--- process output ---');
    console.error(output);
    process.exitCode = 1;
  } finally {
    child.kill();
    cleanupDb();
  }
}

if (require.main === module) {
  main();
}

// Exported so test/test-smoke-boot-timeout.js can pin the timeout budget and
// the diagnostic split without booting the real service.
module.exports = { BOOT_TIMEOUT_MS, LISTENING_MARKER, PORT, describeBootTimeout, waitForHealth };
