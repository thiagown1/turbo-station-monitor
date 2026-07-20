#!/usr/bin/env node
/**
 * Regression test for the 2026-07-20 port-collision incident.
 *
 * Root cause: vercel-drain, github-webhook and mobile-telemetry each read the
 * generic `process.env.PORT`. All three ended up running with `PORT=3002`, so
 * two of them bound :3002 simultaneously and the kernel round-robined incoming
 * connections between them. Roughly half of every production Vercel log batch
 * hit mobile-telemetry's Express 404 handler, and because Vercel treats 404 as
 * "delivered" it never retried — those production logs are gone. Nothing was
 * left on :3003, so the mobile ingest returned 502 for every event.
 *
 * The fix: each service resolves its port from its OWN env var and never reads
 * the generic PORT. These tests pin that behaviour, including the exact
 * scenario that failed (a stray PORT shared by every service).
 *
 * Run: node --test test/test-service-port.js
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');

const MODULE_PATH = path.join(__dirname, '..', 'services', 'lib', 'service-port.js');

/** Re-require the module with a fresh env so module-load-time constants re-evaluate. */
function loadWithEnv(env) {
    const saved = { ...process.env };
    for (const key of ['PORT', 'BIND_HOST', 'VERCEL_DRAIN_PORT', 'GITHUB_WEBHOOK_PORT', 'MOBILE_TELEMETRY_PORT']) {
        delete process.env[key];
    }
    Object.assign(process.env, env);
    delete require.cache[require.resolve(MODULE_PATH)];
    try {
        return require(MODULE_PATH);
    } finally {
        for (const key of Object.keys(process.env)) delete process.env[key];
        Object.assign(process.env, saved);
    }
}

test('uses the service-specific env var', () => {
    const { resolveServicePort } = loadWithEnv({});
    process.env.VERCEL_DRAIN_PORT = '3999';
    try {
        assert.strictEqual(resolveServicePort('VERCEL_DRAIN_PORT', 3001, '[t]'), 3999);
    } finally {
        delete process.env.VERCEL_DRAIN_PORT;
    }
});

test('falls back to the literal default when its var is unset', () => {
    const { resolveServicePort } = loadWithEnv({});
    assert.strictEqual(resolveServicePort('VERCEL_DRAIN_PORT', 3001, '[t]'), 3001);
});

test('THE INCIDENT: a stray generic PORT never wins', () => {
    const { resolveServicePort } = loadWithEnv({});
    // Exactly the broken box state: every service inherited PORT=3002.
    process.env.PORT = '3002';
    try {
        assert.strictEqual(resolveServicePort('VERCEL_DRAIN_PORT', 3001, '[drain]'), 3001);
        assert.strictEqual(resolveServicePort('GITHUB_WEBHOOK_PORT', 3002, '[gh]'), 3002);
        assert.strictEqual(resolveServicePort('MOBILE_TELEMETRY_PORT', 3003, '[mt]'), 3003);
    } finally {
        delete process.env.PORT;
    }
});

/** Grab `count` free loopback ports so the test never fights real services on this box. */
async function freePorts(count) {
    const probes = [];
    for (let i = 0; i < count; i++) {
        const s = http.createServer();
        await new Promise((resolve, reject) => {
            s.once('error', reject);
            s.listen(0, '127.0.0.1', resolve);
        });
        probes.push(s);
    }
    const ports = probes.map(s => s.address().port);
    await Promise.all(probes.map(s => new Promise(r => s.close(r))));
    return ports;
}

test('THE INCIDENT: three services under one stray PORT still bind three distinct sockets', async () => {
    const { resolveServicePort, BIND_HOST } = loadWithEnv({});
    const bodies = ['drain', 'gh', 'mt'];
    const assigned = await freePorts(3);

    // Exactly the broken box state: one shared PORT inherited by everyone. Under
    // the old code all three resolved to it and fought over a single socket.
    process.env.PORT = String(assigned[1]);
    assigned.forEach((p, i) => { process.env[`SVC_${i}_PORT`] = String(p); });

    const servers = [];
    try {
        const resolved = bodies.map((name, i) =>
            resolveServicePort(`SVC_${i}_PORT`, 9000 + i, `[${name}]`)
        );
        assert.deepStrictEqual(resolved, assigned, 'dedicated var must win over the stray PORT');
        assert.strictEqual(new Set(resolved).size, 3, 'each service must own a distinct port');

        // Every service binds cleanly — no EADDRINUSE, no shared socket.
        for (const [i, name] of bodies.entries()) {
            const server = http.createServer((_req, res) => res.end(name));
            await new Promise((resolve, reject) => {
                server.once('error', reject);
                server.listen(resolved[i], BIND_HOST, resolve);
            });
            servers.push(server);
        }

        // And each port answers only for its own service (no round-robin).
        for (const [i, port] of resolved.entries()) {
            const body = await new Promise((resolve, reject) => {
                http.get({ host: '127.0.0.1', port, path: '/' }, res => {
                    let out = '';
                    res.on('data', c => (out += c));
                    res.on('end', () => resolve(out));
                }).on('error', reject);
            });
            assert.strictEqual(body, bodies[i], `port ${port} must serve only ${bodies[i]}`);
        }
    } finally {
        delete process.env.PORT;
        assigned.forEach((_, i) => delete process.env[`SVC_${i}_PORT`]);
        await Promise.all(servers.map(s => new Promise(r => s.close(r))));
    }
});

test('rejects a non-numeric or out-of-range port instead of silently defaulting', () => {
    const { resolveServicePort } = loadWithEnv({});
    for (const bad of ['not-a-port', '0.5', '70000', '-1']) {
        process.env.BAD_PORT = bad;
        assert.throws(
            () => resolveServicePort('BAD_PORT', 3001, '[t]'),
            /Invalid BAD_PORT/,
            `expected ${bad} to be rejected`
        );
    }
    delete process.env.BAD_PORT;
});

test('warns when a generic PORT is present, so the drift is visible in the logs', () => {
    const { resolveServicePort } = loadWithEnv({});
    process.env.PORT = '3002';
    const warnings = [];
    const original = console.warn;
    console.warn = msg => warnings.push(msg);
    try {
        resolveServicePort('VERCEL_DRAIN_PORT', 3001, '[drain]');
    } finally {
        console.warn = original;
        delete process.env.PORT;
    }
    assert.strictEqual(warnings.length, 1);
    assert.match(warnings[0], /Ignoring generic PORT=3002/);
    assert.match(warnings[0], /check-ports/);
});

test('no warning when the environment is clean', () => {
    const { resolveServicePort } = loadWithEnv({});
    const warnings = [];
    const original = console.warn;
    console.warn = msg => warnings.push(msg);
    try {
        resolveServicePort('VERCEL_DRAIN_PORT', 3001, '[drain]');
    } finally {
        console.warn = original;
    }
    assert.deepStrictEqual(warnings, []);
});

test('BIND_HOST defaults to loopback and is overridable', () => {
    assert.strictEqual(loadWithEnv({}).BIND_HOST, '127.0.0.1');
    assert.strictEqual(loadWithEnv({ BIND_HOST: '0.0.0.0' }).BIND_HOST, '0.0.0.0');
});
