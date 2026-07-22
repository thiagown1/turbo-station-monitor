#!/usr/bin/env node
/**
 * End-to-end test for the (a)+(b) patch, against the REAL payload shape Vercel
 * sends (deployment.promoted with NO `target` field — the shape the old code
 * misread as "preview" and never opened a watch for).
 *
 * Runs the real hook process on a spare loopback port with a MOCK Next.js in
 * place of production, so nothing is written to prod and nothing is sent to
 * WhatsApp (DRY_WHATSAPP=1). Asserts:
 *   1. promoted + no target  -> POSTs /api/deploy-watch/start with the real sha
 *   2. succeeded + production -> does NOT post (would double-open the window)
 *   3. promoted + preview     -> does NOT post
 *   4. promoted + junk sha    -> does NOT post (the phantom-watch guard)
 */
'use strict';
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

const SECRET = 'test-secret-not-real';
const HOOK_PORT = 3111;
const MOCK_PORT = 3112;
const SHA = 'c37681429f6f066954a05ab86316bc3e9635844d';
const PROJECT = 'prj_dptfUFsPBJ9yg0xVC9Ga05I0eU5m';

const received = [];
const mock = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
        received.push({ url: req.url, secret: req.headers['x-api-secret'], body: JSON.parse(body || '{}') });
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, id: 'mock', status: 'watching' }));
    });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function payload(type, target, sha) {
    const p = {
        id: 'evt_test', type, createdAt: Date.now(),
        payload: {
            project: { id: PROJECT },
            deployment: { id: 'dpl_test', meta: { githubCommitSha: sha, githubCommitRef: 'master' } },
        },
    };
    if (target !== undefined) p.payload.target = target;
    return JSON.stringify(p);
}

function post(raw) {
    const sig = crypto.createHmac('sha1', SECRET).update(raw).digest('hex');
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1', port: HOOK_PORT, path: '/vercel-deploy-hook', method: 'POST',
            headers: { 'content-type': 'application/json', 'x-vercel-signature': sig, 'content-length': Buffer.byteLength(raw) },
        }, (res) => {
            let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b }));
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
    await new Promise((r) => mock.listen(MOCK_PORT, '127.0.0.1', r));

    const hook = spawn('node', ['services/vercel-deploy-hook.js'], {
        env: {
            ...process.env,
            VERCEL_DEPLOY_HOOK_PORT: String(HOOK_PORT),
            VERCEL_WEBHOOK_SECRET: SECRET,
            DASHBOARD_URL: `http://127.0.0.1:${MOCK_PORT}`,
            MONITOR_API_SECRET: 'test-monitor-secret',
            DRY_WHATSAPP: '1',
            DEPLOY_HOOK_SMOKE: '0',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out = [];
    hook.stdout.on('data', (d) => out.push(d.toString()));
    hook.stderr.on('data', (d) => out.push(d.toString()));
    await sleep(1200);

    console.log('\n1) deployment.promoted, target AUSENTE (a forma real da Vercel)');
    await post(payload('deployment.promoted', undefined, SHA));
    await sleep(1200);
    check('abriu o deploy-watch', received.length === 1, `recebeu ${received.length}`);
    check('rota correta', received[0] && received[0].url === '/api/deploy-watch/start', received[0] && received[0].url);
    check('sha git completo no body', received[0] && received[0].body.sha === SHA, received[0] && received[0].body.sha);
    check('environment=production', received[0] && received[0].body.environment === 'production', received[0] && received[0].body.environment);
    check('mandou o x-api-secret', received[0] && received[0].secret === 'test-monitor-secret', 'ausente');
    check('rotulou como produção (nao "preview")', out.join('').includes('Deploy em produção'), 'texto: ' + out.join('').slice(-200));

    console.log('\n2) deployment.succeeded, target=production (nao deve reabrir)');
    received.length = 0;
    await post(payload('deployment.succeeded', 'production', SHA));
    await sleep(1200);
    check('nao abriu watch', received.length === 0, `recebeu ${received.length}`);

    console.log('\n3) deployment.promoted, target=preview');
    received.length = 0;
    await post(payload('deployment.promoted', 'preview', SHA));
    await sleep(1200);
    check('nao abriu watch', received.length === 0, `recebeu ${received.length}`);

    console.log('\n4) deployment.promoted com sha invalido (guarda anti-fantasma)');
    received.length = 0;
    await post(payload('deployment.promoted', undefined, '7ncz8-1784622352485-f2df2ef2f245'));
    await sleep(1200);
    check('nao abriu watch', received.length === 0, `recebeu ${received.length}`);

    hook.kill();
    mock.close();
    console.log(`\n${failures === 0 ? 'TODOS OS TESTES PASSARAM' : failures + ' FALHA(S)'}`);
    process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('harness error', e); process.exit(1); });
