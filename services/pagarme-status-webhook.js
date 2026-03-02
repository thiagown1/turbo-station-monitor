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
const { exec } = require('child_process');

const PORT = parseInt(process.env.PORT || '3004', 10);
const TELEGRAM_TARGET = process.env.PAGARME_STATUS_TELEGRAM_TARGET || 'telegram:-5250194812';

// Security model: only allow this exact URL path; no token required.


const MAX_PAYLOAD_SIZE = 2 * 1024 * 1024;

function sendTelegram(text) {
  const escaped = String(text).replace(/"/g, '\\"').replace(/`/g, '\\`').replace(/\$/g, '\\$');
  exec(
    `openclaw message send --channel telegram --target ${TELEGRAM_TARGET} -m "${escaped}"`,
    { timeout: 10000 },
    (err) => {
      if (err) console.error(`[pagarme-status] telegram send failed: ${err.message}`);
      else console.log('[pagarme-status] telegram sent');
    }
  );
}

function ok(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function summarize(payload) {
  // statuspage fields vary; handle common ones
  const incident = payload.incident || payload;
  const name = incident.name || payload.name || 'Pagar.me Status';
  const status = incident.status || payload.status || payload.event_type || 'update';
  const impact = incident.impact || payload.impact || '';
  const url = incident.shortlink || incident.html_url || payload.url || '';

  // prefer latest update body
  let body = '';
  if (Array.isArray(incident.incident_updates) && incident.incident_updates.length) {
    const u = incident.incident_updates[0];
    body = u.body || u.status || '';
  } else if (incident.body) {
    body = incident.body;
  }

  body = String(body || '').trim().replace(/\s+/g, ' ');
  if (body.length > 240) body = body.slice(0, 240) + '...';

  const lines = [];
  lines.push(`🚦 Pagar.me Status: ${name}`);
  lines.push(`Status: ${status}${impact ? ` | Impacto: ${impact}` : ''}`);
  if (body) lines.push(body);
  if (url) lines.push(url);
  return lines.join('\n');
}

function handler(req, res) {
  if (req.method === 'GET' && (req.url === '/health' || req.url === '/ping')) {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
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

http.createServer(handler).listen(PORT, () => {
  console.log(`[pagarme-status] listening on ${PORT}`);
});
