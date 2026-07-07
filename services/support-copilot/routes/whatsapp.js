/**
 * WhatsApp Management Routes — Support Copilot
 *
 * Proxies WhatsApp gateway management API for the dashboard.
 * All routes require the SUPPORT_API_SECRET auth.
 *
 * GET    /api/support/whatsapp/instances               — list all instances
 * POST   /api/support/whatsapp/connect                 — create instance + start pairing
 * GET    /api/support/whatsapp/:name/qr                — get QR code for scanning
 * GET    /api/support/whatsapp/:name/status             — connection status
 * POST   /api/support/whatsapp/:name/disconnect         — logout + clear session
 * DELETE /api/support/whatsapp/:name                    — remove instance entirely
 */

const { Router } = require('express');
const { EVOLUTION_API_URL, EVOLUTION_API_KEY, LOG_TAG } = require('../lib/constants');
const http = require('http');

const router = Router();

// ─── Proxy helper ──────────────────────────────────────────────────────────

function proxyToGateway(method, gatewayPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(gatewayPath, EVOLUTION_API_URL);

    const data = body ? JSON.stringify(body) : null;

    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        ...(EVOLUTION_API_KEY ? { apikey: EVOLUTION_API_KEY } : {}),
      },
    };

    const req = http.request(options, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(buf) });
        } catch {
          resolve({ status: res.statusCode, body: buf });
        }
      });
    });

    req.on('error', (err) => {
      reject(new Error(`Gateway connection failed: ${err.message}`));
    });

    if (data) req.write(data);
    req.end();
  });
}

// ─── List all instances ────────────────────────────────────────────────────

router.get('/instances', async (_req, res) => {
  try {
    const result = await proxyToGateway('GET', '/instances');
    res.status(result.status).json(result.body);
  } catch (err) {
    console.error(`${LOG_TAG} Gateway proxy error:`, err.message);
    res.status(502).json({ error: 'WhatsApp gateway unavailable', detail: err.message });
  }
});

// ─── Connect (create instance + start pairing) ────────────────────────────

router.post('/connect', async (req, res) => {
  const { name } = req.body;
  if (!name) {
    return res.status(400).json({ error: 'name required (will be used as instance identifier)' });
  }

  try {
    const result = await proxyToGateway('POST', '/instance/create', { name });
    res.status(result.status).json(result.body);
  } catch (err) {
    console.error(`${LOG_TAG} Gateway proxy error:`, err.message);
    res.status(502).json({ error: 'WhatsApp gateway unavailable', detail: err.message });
  }
});

// ─── Get QR code ───────────────────────────────────────────────────────────

router.get('/:name/qr', async (req, res) => {
  try {
    const format = req.query.format || '';
    const queryStr = format ? `?format=${format}` : '';
    const result = await proxyToGateway('GET', `/instance/${req.params.name}/qr${queryStr}`);

    // If text format, pass through as text
    if (format === 'text' && typeof result.body === 'string') {
      return res.type('text/plain').send(result.body);
    }

    res.status(result.status).json(result.body);
  } catch (err) {
    console.error(`${LOG_TAG} Gateway proxy error:`, err.message);
    res.status(502).json({ error: 'WhatsApp gateway unavailable', detail: err.message });
  }
});

// ─── Status ────────────────────────────────────────────────────────────────

router.get('/:name/status', async (req, res) => {
  try {
    const result = await proxyToGateway('GET', `/instance/${req.params.name}/status`);
    res.status(result.status).json(result.body);
  } catch (err) {
    console.error(`${LOG_TAG} Gateway proxy error:`, err.message);
    res.status(502).json({ error: 'WhatsApp gateway unavailable', detail: err.message });
  }
});

// ─── Disconnect (logout + clear session) ───────────────────────────────────

router.post('/:name/disconnect', async (req, res) => {
  try {
    const result = await proxyToGateway('POST', `/instance/${req.params.name}/disconnect`);
    res.status(result.status).json(result.body);
  } catch (err) {
    console.error(`${LOG_TAG} Gateway proxy error:`, err.message);
    res.status(502).json({ error: 'WhatsApp gateway unavailable', detail: err.message });
  }
});

// ─── Delete instance entirely ──────────────────────────────────────────────

router.delete('/:name', async (req, res) => {
  try {
    const result = await proxyToGateway('DELETE', `/instance/${req.params.name}`);
    res.status(result.status).json(result.body);
  } catch (err) {
    console.error(`${LOG_TAG} Gateway proxy error:`, err.message);
    res.status(502).json({ error: 'WhatsApp gateway unavailable', detail: err.message });
  }
});

module.exports = router;
