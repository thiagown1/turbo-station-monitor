#!/usr/bin/env node
/**
 * Regression test for the flaky "support-copilot boot smoke test" CI job.
 *
 * Root cause: scripts/ci/smoke-support-copilot.js allowed 15s for the service
 * to answer /health, but the service runs ~25 SQLite migrations before it
 * listens, so boot time tracks the runner's disk speed. On PR #49 (run
 * 32147642479) a slow runner blew the budget on a service that had in fact
 * booted — the captured output carried the "Listening on 127.0.0.1:39548"
 * line. Re-running the identical commit passed (26s wall clock vs 52s).
 *
 * Two things are pinned here:
 *   1. the timeout budget stays generous — it is a liveness check, not a
 *      performance test;
 *   2. a slow boot and a broken boot no longer produce the same message.
 *      They used to be byte-identical, which is what cost a re-run to
 *      diagnose in the first place.
 *
 * Run: node --test test/test-smoke-boot-timeout.js
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');

const {
    BOOT_TIMEOUT_MS,
    LISTENING_MARKER,
    PORT,
    describeBootTimeout,
    waitForHealth,
} = require(path.join(__dirname, '..', 'scripts', 'ci', 'smoke-support-copilot.js'));

test('boot timeout leaves room for a slow runner', () => {
    // 15s is the value that failed on a service that had already booted.
    assert.ok(
        BOOT_TIMEOUT_MS >= 60000,
        `BOOT_TIMEOUT_MS is ${BOOT_TIMEOUT_MS}ms — too tight for a cold GitHub Actions runner`
    );
});

test('a slow boot and a broken boot report differently', () => {
    const common = { timeoutMs: BOOT_TIMEOUT_MS };
    const bound = describeBootTimeout({ ...common, sawListening: true });
    const silent = describeBootTimeout({ ...common, sawListening: false });

    // The whole point: these two were byte-identical before.
    assert.notStrictEqual(bound, silent);

    // The service announced itself, so point at the HTTP server / port.
    assert.match(bound, new RegExp(LISTENING_MARKER));
    assert.match(bound, /wedged|another port/);
    assert.doesNotMatch(bound, /never printed/);

    // Nothing was announced, so point at the boot itself.
    assert.match(silent, /never printed/);
    assert.match(silent, /crashed|migrations/);

    // Both name the budget they blew, in seconds.
    assert.match(bound, /60s/);
    assert.match(silent, /60s/);
});

test('the underlying connection error is surfaced when there is one', () => {
    const withError = describeBootTimeout({
        sawListening: false,
        timeoutMs: BOOT_TIMEOUT_MS,
        lastError: 'connect ECONNREFUSED 127.0.0.1:39548',
    });
    assert.match(withError, /last connection error: connect ECONNREFUSED 127\.0\.0\.1:39548/);

    const withoutError = describeBootTimeout({ sawListening: false, timeoutMs: BOOT_TIMEOUT_MS });
    assert.doesNotMatch(withoutError, /last connection error/);
});

test('waitForHealth resolves once /health answers ok', async () => {
    const server = http.createServer((req, res) => {
        if (req.url === '/health') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
        } else {
            res.writeHead(404).end();
        }
    });
    await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
    try {
        await waitForHealth(Date.now() + 5000);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});

test('waitForHealth rejects with the diagnostic message it was given', async () => {
    // Nothing is listening on PORT and the deadline has already passed, so the
    // first failed connection rejects immediately — this pins the wiring
    // between waitForHealth and describeBootTimeout, not just the pure helper.
    await assert.rejects(
        () => waitForHealth(Date.now() - 1, { sawListening: () => true, timeoutMs: BOOT_TIMEOUT_MS }),
        (err) => {
            assert.match(err.message, new RegExp(LISTENING_MARKER));
            assert.match(err.message, /last connection error/);
            return true;
        }
    );

    await assert.rejects(
        () => waitForHealth(Date.now() - 1, { sawListening: () => false, timeoutMs: BOOT_TIMEOUT_MS }),
        /never printed/
    );
});
