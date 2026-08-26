#!/usr/bin/env node
'use strict';

/**
 * mosim-logtail — a tiny SSE sidecar that streams the MicroOcppSimulator's
 * own stdout (the pm2 `mosim` process log) to the OCPP Simulator dashboard
 * panel.
 *
 * Why this exists: the `mo_simulator` binary has no log endpoint of its own —
 * its `[MO] Send/Recv` frames go to stdout, which pm2 captures into
 * ~/.pm2/logs/mosim-out.log. The dashboard (Next.js, off-box) can only reach
 * the simulator through the public nginx, so we expose the log file as an SSE
 * stream that nginx fronts at /sim-logs (gated by the same X-API-Key as /sim).
 *
 * Endpoints (loopback only — nginx is the public edge):
 *   GET /health          → { ok: true, files, clients }
 *   GET /stream          → text/event-stream
 *        event: log      data: { line, seq, stream: "out"|"err", t }
 *        event: ping     data: { t }
 *
 * Auth: if LOGTAIL_API_KEY is set, /stream requires a matching X-API-Key
 * header (defense-in-depth behind nginx, which already enforces it).
 *
 * No external dependencies — Node core only — so it drops straight into the
 * existing pm2 fleet without an npm install.
 *
 * Env:
 *   LOGTAIL_HOST        bind address          (default 127.0.0.1)
 *   LOGTAIL_PORT        listen port           (default 8090)
 *   LOGTAIL_OUT_FILE    stdout log path       (default ~/.pm2/logs/mosim-out.log)
 *   LOGTAIL_ERR_FILE    stderr log path       (default ~/.pm2/logs/mosim-error.log)
 *   LOGTAIL_TAIL_LINES  backlog on connect    (default 200)
 *   LOGTAIL_API_KEY     optional shared key   (default '' = no local check)
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOST = process.env.LOGTAIL_HOST || '127.0.0.1';
const PORT = parseInt(process.env.LOGTAIL_PORT || '8090', 10);
const PM2_LOGS = path.join(os.homedir(), '.pm2', 'logs');
const OUT_FILE = process.env.LOGTAIL_OUT_FILE || path.join(PM2_LOGS, 'mosim-out.log');
const ERR_FILE = process.env.LOGTAIL_ERR_FILE || path.join(PM2_LOGS, 'mosim-error.log');
const TAIL_LINES = parseInt(process.env.LOGTAIL_TAIL_LINES || '200', 10);
const API_KEY = process.env.LOGTAIL_API_KEY || '';
const PING_MS = 20_000;
const POLL_MS = 500;
const READ_CHUNK = 64 * 1024; // bytes read per poll tick / initial-tail window

let seq = 0;
const clients = new Set(); // Set<{ res, ping }>

function broadcast(event, data) {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of clients) {
        try { c.res.write(frame); } catch { /* dropped; cleaned up on 'close' */ }
    }
}

/** Read roughly the last `maxBytes` of a file and return its trailing lines. */
function readTailLines(file, maxLines) {
    try {
        const { size } = fs.statSync(file);
        const start = Math.max(0, size - READ_CHUNK);
        const fd = fs.openSync(file, 'r');
        try {
            const len = size - start;
            const buf = Buffer.alloc(len);
            fs.readSync(fd, buf, 0, len, start);
            const text = buf.toString('utf8');
            // Drop a partial first line when we started mid-file.
            const lines = text.split('\n');
            if (start > 0) lines.shift();
            return lines.filter(l => l.length > 0).slice(-maxLines);
        } finally {
            fs.closeSync(fd);
        }
    } catch {
        return [];
    }
}

/**
 * Follow a file: emit each newly-appended line via onLine(line). Handles
 * truncation/rotation (size shrank → reset to 0) and files that don't exist
 * yet (waits for them to appear). Uses fs.watchFile polling for portability
 * and rotation-safety.
 */
function followFile(file, streamLabel, onLine) {
    let pos = 0;
    let carry = '';
    try { pos = fs.statSync(file).size; } catch { pos = 0; }

    const drain = () => {
        let stat;
        try { stat = fs.statSync(file); } catch { return; }
        if (stat.size < pos) { pos = 0; carry = ''; } // truncated or rotated
        if (stat.size === pos) return;
        const fd = fs.openSync(file, 'r');
        try {
            while (pos < stat.size) {
                const len = Math.min(READ_CHUNK, stat.size - pos);
                const buf = Buffer.alloc(len);
                const n = fs.readSync(fd, buf, 0, len, pos);
                if (n <= 0) break;
                pos += n;
                carry += buf.toString('utf8', 0, n);
                const parts = carry.split('\n');
                carry = parts.pop(); // keep the trailing partial line
                for (const line of parts) {
                    if (line.length > 0) onLine(line, streamLabel);
                }
            }
        } finally {
            fs.closeSync(fd);
        }
    };

    fs.watchFile(file, { interval: POLL_MS }, drain);
    return () => fs.unwatchFile(file, drain);
}

// Start following both files immediately so we stream to whoever connects.
followFile(OUT_FILE, 'out', (line, stream) => broadcast('log', { line, seq: ++seq, stream, t: Date.now() }));
followFile(ERR_FILE, 'err', (line, stream) => broadcast('log', { line, seq: ++seq, stream, t: Date.now() }));

const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, files: { out: OUT_FILE, err: ERR_FILE }, clients: clients.size }));
        return;
    }

    if (url.pathname === '/stream') {
        if (API_KEY && req.headers['x-api-key'] !== API_KEY) {
            res.writeHead(401, { 'Content-Type': 'text/plain' });
            res.end('Unauthorized');
            return;
        }
        res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
        });
        // Replay the recent backlog so the panel isn't blank on connect.
        for (const line of readTailLines(OUT_FILE, TAIL_LINES)) {
            res.write(`event: log\ndata: ${JSON.stringify({ line, seq: ++seq, stream: 'out', t: Date.now() })}\n\n`);
        }
        const ping = setInterval(() => {
            try { res.write(`event: ping\ndata: ${JSON.stringify({ t: Date.now() })}\n\n`); } catch { /* closed */ }
        }, PING_MS);
        const client = { res, ping };
        clients.add(client);
        req.on('close', () => { clearInterval(ping); clients.delete(client); });
        return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
});

server.listen(PORT, HOST, () => {
    console.log(`[mosim-logtail] listening on http://${HOST}:${PORT} — tailing ${OUT_FILE}`);
});
