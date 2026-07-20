#!/usr/bin/env node
/**
 * Port-map smoke check.
 *
 * Written after the 2026-07-20 incident, where three services all inherited
 * `PORT=3002`, two of them bound :3002 at once, and the kernel round-robined
 * requests between them. Half of production's Vercel logs were answered with
 * `404 {"error":"Not found"}` by the wrong service — and because Vercel treats
 * 404 as delivered, they were lost. Nothing detected it for hours.
 *
 * Three checks, cheapest first:
 *   1. CONFIG   — no two services in ecosystem.config.js claim the same port.
 *   2. NGINX    — every proxy_pass port in the live vhost belongs to a service.
 *   3. IDENTITY — each port answers IDENTICALLY across repeated probes.
 *
 * Check 3 is the one that catches the actual failure. Two services sharing a
 * socket cannot return the same bytes every time, whatever they serve, so this
 * needs no per-service knowledge and keeps working as services are added.
 *
 * Usage:
 *   node scripts/check-ports.js              # all three checks
 *   node scripts/check-ports.js --no-nginx   # skip the vhost read (no sudo)
 *
 * Exits 0 when clean, 1 on any failure — safe to wire into cron or the
 * alert-engine.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PROBES = 8; // enough that a 50/50 round-robin is missed with p < 0.01
const TIMEOUT_MS = 3000;
const NGINX_VHOST = process.env.NGINX_VHOST ||
    '/etc/nginx/sites-enabled/logs.turbostation.com.br';

/** Service -> env var + default, mirroring ecosystem.config.js. */
const SERVICES = [
    { name: 'vercel-drain', envVar: 'VERCEL_DRAIN_PORT', fallback: 3001 },
    { name: 'github-webhook', envVar: 'GITHUB_WEBHOOK_PORT', fallback: 3002 },
    { name: 'mobile-telemetry', envVar: 'MOBILE_TELEMETRY_PORT', fallback: 3003 },
    { name: 'pagarme-status-webhook', envVar: 'PAGARME_WEBHOOK_PORT', fallback: 3004 },
    { name: 'support-copilot', envVar: 'SUPPORT_COPILOT_PORT', fallback: 3005 },
    { name: 'vercel-deploy-hook', envVar: 'VERCEL_DEPLOY_HOOK_PORT', fallback: 3010 },
];

const failures = [];
const notes = [];

/** Read .env the same way ecosystem.config.js does (no dependency on dotenv). */
function readDotenv() {
    const envPath = path.join(__dirname, '..', '.env');
    const out = {};
    if (!fs.existsSync(envPath)) return out;
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const idx = trimmed.indexOf('=');
        if (idx === -1) continue;
        out[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
    }
    return out;
}

function resolvePorts() {
    const dotenv = readDotenv();
    return SERVICES.map(s => ({
        ...s,
        port: Number(process.env[s.envVar] || dotenv[s.envVar] || s.fallback),
    }));
}

// ─── 1. CONFIG ───────────────────────────────────────────────────────────────

function checkConfig(services) {
    const byPort = new Map();
    for (const s of services) {
        if (!Number.isInteger(s.port) || s.port < 1 || s.port > 65535) {
            failures.push(`CONFIG: ${s.name} has invalid ${s.envVar}=${s.port}`);
            continue;
        }
        if (byPort.has(s.port)) {
            failures.push(
                `CONFIG: ${s.name} and ${byPort.get(s.port)} both claim port ${s.port}`
            );
        }
        byPort.set(s.port, s.name);
    }
    // The fingerprint of the original bug: a generic PORT floating in the env.
    if (process.env.PORT) {
        notes.push(
            `CONFIG: generic PORT=${process.env.PORT} is set in this environment. ` +
            `Services ignore it, but its presence means something restarted with a dirty env.`
        );
    }
    return byPort;
}

// ─── 2. NGINX ────────────────────────────────────────────────────────────────

function checkNginx(byPort) {
    let conf;
    try {
        conf = fs.readFileSync(NGINX_VHOST, 'utf8');
    } catch (err) {
        notes.push(`NGINX: skipped (${NGINX_VHOST}: ${err.code || err.message})`);
        return;
    }
    const seen = new Set();
    for (const m of conf.matchAll(/proxy_pass\s+https?:\/\/127\.0\.0\.1:(\d+)/g)) {
        seen.add(Number(m[1]));
    }
    for (const port of seen) {
        // Ports outside SERVICES (blog-api, ai agent, …) are not ours to judge.
        if (port >= 3001 && port <= 3010 && !byPort.has(port)) {
            failures.push(
                `NGINX: ${NGINX_VHOST} proxies to 127.0.0.1:${port}, which no service claims`
            );
        }
    }
}

// ─── 3. IDENTITY ─────────────────────────────────────────────────────────────

/**
 * Ask :port who it is. Every service stamps `X-Service` on /health precisely so
 * this works — response BODIES cannot identify a service (github-webhook and
 * mobile-telemetry both answer 'OK\n', and the drain's body carries a uptime
 * counter that changes between probes).
 */
function probe(port) {
    return new Promise(resolve => {
        const req = http.get(
            { host: '127.0.0.1', port, path: '/health', timeout: TIMEOUT_MS },
            res => {
                res.resume(); // drain so the socket closes
                res.on('end', () =>
                    resolve(res.headers['x-service'] || `unidentified(status=${res.statusCode})`)
                );
            }
        );
        req.on('timeout', () => { req.destroy(); resolve('TIMEOUT'); });
        req.on('error', err => resolve(`ERROR:${err.code || err.message}`));
    });
}

async function checkIdentity(services) {
    for (const s of services) {
        const seen = new Set();
        for (let i = 0; i < PROBES; i++) seen.add(await probe(s.port));
        const answers = [...seen];

        if (answers.length === 1 && answers[0] === 'ERROR:ECONNREFUSED') {
            failures.push(`IDENTITY: ${s.name} — nothing listening on :${s.port}`);
            continue;
        }
        if (answers.length > 1) {
            // Two processes on one socket. This is the incident.
            failures.push(
                `IDENTITY: :${s.port} answered as ${answers.length} different services across ` +
                `${PROBES} probes (${answers.join(', ')}) — more than one process is bound to it. ` +
                `Expected only ${s.name}.`
            );
            continue;
        }
        if (answers[0] !== s.name) {
            failures.push(
                `IDENTITY: :${s.port} should be ${s.name} but answered as ${answers[0]}`
            );
        }
    }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
    const services = resolvePorts();
    const byPort = checkConfig(services);
    if (!process.argv.includes('--no-nginx')) checkNginx(byPort);
    await checkIdentity(services);

    for (const n of notes) console.log(`[check-ports] NOTE  ${n}`);

    if (failures.length === 0) {
        console.log(
            `[check-ports] OK — ${services.length} services, distinct ports, ` +
            `each socket owned by exactly one process`
        );
        for (const s of services) console.log(`[check-ports]   ${s.name} -> :${s.port}`);
        process.exit(0);
    }

    for (const f of failures) console.error(`[check-ports] FAIL  ${f}`);
    console.error(`[check-ports] ${failures.length} failure(s)`);
    process.exit(1);
}

main().catch(err => {
    console.error('[check-ports] crashed:', err);
    process.exit(1);
});
