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
const BOOT_TIMEOUT_MS = 15000;

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

function waitForHealth(deadline) {
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
      req.on('error', () => {
        if (Date.now() > deadline) {
          reject(new Error('service never became healthy within the boot timeout'));
        } else {
          setTimeout(attempt, 300);
        }
      });
    };
    attempt();
  });
}

(async () => {
  // SUPPORT_COPILOT_PORT, not PORT: services deliberately ignore the generic
  // PORT (see services/lib/service-port.js). PORT is deleted rather than
  // overwritten so the smoke run does not trip the drift warning if the
  // runner's own environment happens to carry one.
  const childEnv = { ...process.env, SUPPORT_COPILOT_PORT: String(PORT), SUPPORT_COPILOT_DB_PATH: DB_PATH };
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
      waitForHealth(Date.now() + BOOT_TIMEOUT_MS),
      exitedEarly.then((code) => { throw new Error(`process exited early with code ${code}\n${output}`); }),
    ]);
    console.log('✓ support-copilot booted and GET /health returned 200');
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
})();
