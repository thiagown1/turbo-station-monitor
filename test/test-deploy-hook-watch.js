#!/usr/bin/env node
/**
 * End-to-end test for vercel-deploy-hook's production-promotion handling,
 * against the REAL payload shape Vercel sends: `deployment.promoted` with NO
 * `target` field. That shape is what the old code misread as "preview" — it
 * never opened a deploy-watch window, never built the smoke checklist, and
 * announced every production promotion to the team as "Deploy em preview".
 *
 * Runs the real service on an ephemeral loopback port with a MOCK Next.js in
 * place of production, so nothing is written to prod and nothing is sent to
 * WhatsApp (DRY_WHATSAPP=1). Ports are allocated dynamically — this suite runs
 * on the same box as the live services, so it must never squat a fixed port.
 *
 * Asserts:
 *   1. promoted + no target   -> POSTs /api/deploy-watch/start with the real sha
 *   2. succeeded + production -> does NOT post (would double-open the window)
 *   3. promoted + preview     -> does NOT post
 *   4. promoted + junk sha    -> does NOT post (the 2026-07-21 phantom-watch guard)
 */
'use strict';
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');

const SECRET = 'test-secret-not-real';
const SHA = 'c37681429f6f066954a05ab86316bc3e9635844d';
const PROJECT = 'prj_dptfUFsPBJ9yg0xVC9Ga05I0eU5m';
const SERVICE = path.join(__dirname, '..', 'services', 'vercel-deploy-hook.js');

/** An OS-assigned free loopback port (never a fixed one — shared box). */
function freePort() {
    return new Promise((resolve, reject) => {
        const s = net.createServer();
        s.on('error', reject);
        s.listen(0, '127.0.0.1', () => {
            const { port } = s.address();
            s.close(() => resolve(port));
        });
    });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function payload(type, target, sha) {
    const p = {
        id: 'evt_test', type, createdAt: Date.now(),
        payload: {
            project: { id: PROJECT },
            deployment: { id: 'dpl_test', meta: { githubCommitSha: sha, githubCommitRef: 'master' } },
        },
    };
    // `undefined` means "field absent", which is the real promoted shape.
    if (target !== undefined) p.payload.target = target;
    return JSON.stringify(p);
}

function post(port, raw) {
    const sig = crypto.createHmac('sha1', SECRET).update(raw).digest('hex');
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1', port, path: '/vercel-deploy-hook', method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-vercel-signature': sig,
                'content-length': Buffer.byteLength(raw),
            },
        }, (res) => {
            let b = '';
            res.on('data', (c) => { b += c; });
            res.on('end', () => resolve({ status: res.statusCode, body: b }));
        });
        req.on('error', reject);
        req.end(raw);
    });
}

let failures = 0;
function check(name, cond, detail) {
    console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ' -> ' + detail}`);
    if (!cond) failures += 1;
}

(async () => {
    const received = [];
    const mockPort = await freePort();
    const mock = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            received.push({
                url: req.url,
                secret: req.headers['x-api-secret'],
                body: JSON.parse(body || '{}'),
            });
            res.writeHead(201, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, id: 'mock', status: 'watching' }));
        });
    });
    await new Promise((r) => mock.listen(mockPort, '127.0.0.1', r));

    const hookPort = await freePort();
    const hook = spawn(process.execPath, [SERVICE], {
        env: {
            ...process.env,
            VERCEL_DEPLOY_HOOK_PORT: String(hookPort),
            VERCEL_WEBHOOK_SECRET: SECRET,
            DASHBOARD_URL: `http://127.0.0.1:${mockPort}`,
            MONITOR_API_SECRET: 'test-monitor-secret',
            DRY_WHATSAPP: '1',
            DEPLOY_HOOK_SMOKE: '0',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out = [];
    hook.stdout.on('data', (d) => out.push(d.toString()));
    hook.stderr.on('data', (d) => out.push(d.toString()));
    await sleep(1500);

    console.log('\n1) deployment.promoted, target AUSENTE (a forma real da Vercel)');
    await post(hookPort, payload('deployment.promoted', undefined, SHA));
    await sleep(1500);
    check('abriu o deploy-watch', received.length === 1, `recebeu ${received.length}`);
    check('rota correta', received[0] && received[0].url === '/api/deploy-watch/start', received[0] && received[0].url);
    check('sha git completo no body', received[0] && received[0].body.sha === SHA, received[0] && received[0].body.sha);
    check('environment=production', received[0] && received[0].body.environment === 'production', received[0] && received[0].body.environment);
    check('mandou o x-api-secret', received[0] && received[0].secret === 'test-monitor-secret', 'ausente');
    check('rotulou como produção (nao "preview")', out.join('').includes('Deploy em produção'), 'texto: ' + out.join('').slice(-200));

    console.log('\n2) deployment.succeeded, target=production (nao deve reabrir)');
    received.length = 0;
    await post(hookPort, payload('deployment.succeeded', 'production', SHA));
    await sleep(1500);
    check('nao abriu watch', received.length === 0, `recebeu ${received.length}`);

    console.log('\n3) deployment.promoted, target=preview');
    received.length = 0;
    await post(hookPort, payload('deployment.promoted', 'preview', SHA));
    await sleep(1500);
    check('nao abriu watch', received.length === 0, `recebeu ${received.length}`);

    console.log('\n4) deployment.promoted com sha invalido (guarda anti-fantasma)');
    received.length = 0;
    await post(hookPort, payload('deployment.promoted', undefined, '7ncz8-1784622352485-f2df2ef2f245'));
    await sleep(1500);
    check('nao abriu watch', received.length === 0, `recebeu ${received.length}`);

    hook.kill();
    await new Promise((r) => mock.close(r));
    console.log(`\n${failures === 0 ? 'TODOS OS TESTES PASSARAM' : failures + ' FALHA(S)'}`);
    process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('harness error', e); process.exit(1); });
