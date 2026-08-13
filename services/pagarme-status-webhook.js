#!/usr/bin/env node
/**
 * Pagar.me Status Page Webhook Ingress
 *
 * Endpoint: /api/pagarme/status-webhook
 *
 * Receives statuspage.io style webhook events for incidents/components.
 * Sends concise notification to Telegram group.
 */

const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { resolveServicePort, BIND_HOST } = require('./lib/service-port');

const PORT = resolveServicePort('PAGARME_WEBHOOK_PORT', 3004, '[pagarme-status-webhook]');
const TELEGRAM_TARGET = process.env.PAGARME_STATUS_TELEGRAM_TARGET || 'telegram:-5250194812';
const WEBHOOK_SECRET = process.env.PAGARME_WEBHOOK_SECRET || '';
const OPENCLAW_CLI = process.env.OPENCLAW_CLI || '/home/openclaw/.npm-global/bin/openclaw';
const MAX_PAYLOAD_SIZE = 64 * 1024;

function sendTelegram(text) {
  const child = spawn(
    OPENCLAW_CLI,
    ['message', 'send', '--channel', 'telegram', '--target', TELEGRAM_TARGET, '--message', String(text)],
    { shell: false, timeout: 10000, stdio: 'ignore' }
  );
  child.on('error', (err) => console.error(`[pagarme-status] telegram send failed: ${err.message}`));
  child.on('close', (code) => {
    if (code === 0) console.log('[pagarme-status] telegram sent');
    else console.error(`[pagarme-status] telegram exited with code ${code}`);
  });
}

function safeText(value, max) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

function secretOk(header) {
  if (!WEBHOOK_SECRET || !header) return false;
  const provided = Buffer.from(String(header));
  const expected = Buffer.from(WEBHOOK_SECRET);
  return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
}

function ok(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function summarize(payload) {
  // statuspage fields vary; handle common ones
  const incident = payload.incident || payload;
  const name = safeText(incident.name || payload.name || 'Pagar.me Status', 160);
  const status = safeText(incident.status || payload.status || payload.event_type || 'update', 80);
  const impact = safeText(incident.impact || payload.impact || '', 80);
  const url = safeText(incident.shortlink || incident.html_url || payload.url || '', 300);

  // prefer latest update body
  let body = '';
  if (Array.isArray(incident.incident_updates) && incident.incident_updates.length) {
    const u = incident.incident_updates[0];
    body = u.body || u.status || '';
  } else if (incident.body) {
    body = incident.body;
  }

  body = safeText(body, 240).replace(/\s+/g, ' ');

  const lines = [];
  lines.push(`🚦 Pagar.me Status: ${name}`);
  lines.push(`Status: ${status}${impact ? ` | Impacto: ${impact}` : ''}`);
  if (body) lines.push(body);
  if (url) lines.push(url);
  return lines.join('\n');
}

function handler(req, res) {
  if (req.method === 'GET' && (req.url === '/health' || req.url === '/ping')) {
    // X-Service lets scripts/check-ports.js tell WHICH process owns this socket.
    res.writeHead(200, { 'Content-Type': 'text/plain', 'X-Service': 'pagarme-status-webhook' });
    res.end('OK\n');
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  // Only accept the exact configured webhook URL, no other paths and no extra segments.
  if (url.pathname !== '/api/pagarme/status-webhook' || url.search) {
    ok(res, 404, { error: 'not_found' });
    return;
  }

  if (req.method !== 'POST') {
    ok(res, 405, { error: 'method_not_allowed' });
    return;
  }

  if (!WEBHOOK_SECRET) {
    ok(res, 503, { error: 'webhook_unavailable' });
    return;
  }
  if (!secretOk(req.headers['x-webhook-secret'])) {
    ok(res, 401, { error: 'unauthorized' });
    return;
  }

  let body = '';
  let size = 0;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_PAYLOAD_SIZE) {
      ok(res, 413, { error: 'payload_too_large' });
      req.destroy();
      return;
    }
    body += chunk.toString();
  });

  req.on('end', () => {
    try {
      const payload = JSON.parse(body || '{}');
      const msg = summarize(payload);

      // Add minimal delivery metadata for debugging (do not include sensitive headers)
      const meta = `source_ip=${req.socket.remoteAddress || ''}`;
      sendTelegram(msg + "\n" + meta);

      ok(res, 200, { ok: true });
    } catch (e) {
      console.error('[pagarme-status] parse error:', e.message);
      ok(res, 400, { error: 'bad_json' });
    }
  });
}

if (require.main === module) {
  http.createServer(handler).listen(PORT, BIND_HOST, () => {
    console.log(`[pagarme-status] listening on ${BIND_HOST}:${PORT}`);
  });
}

module.exports = { handler, summarize, safeText, secretOk };
