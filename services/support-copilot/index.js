/**
 * Support Copilot Service — Entry Point
 *
 * Express app with SQLite backend for support conversations.
 *
 * Routes:
 *   GET  /health                                → liveness probe
 *   GET  /api/support/conversations             → list by brand
 *   GET  /api/support/conversations/:id         → detail
 *   GET  /api/support/conversations/:id/context → full context
 *   POST /api/support/conversations/:id/messages → send message
 *   POST /api/support/ingest/whatsapp           → inbound WhatsApp
 *   ... (see routes/conversations.js for full list)
 */

const express = require('express');
const { PORT, LOG_TAG, MAX_PAYLOAD_BYTES, EVOLUTION_WEBHOOK_SECRET } = require('./lib/constants');
require('./lib/db'); // ensure DB is initialised before routes

const app = express();

// ─── Middleware ───────────────────────────────────────────────────────────────
const { requireSecret } = require('./middleware/auth');
app.use(express.json({ limit: MAX_PAYLOAD_BYTES }));

// ─── Health ──────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true, service: 'support-copilot' }));
app.get('/ping', (_req, res) => res.send('pong'));

// ─── Routes ──────────────────────────────────────────────────────────────────
// SSE real-time events (replaces frontend polling)
const { sseRouter } = require('./lib/sse');
app.use('/api/support', requireSecret, sseRouter);

app.use('/api/support/conversations', requireSecret, require('./routes/conversations'));
app.use('/api/support/settings', requireSecret, require('./routes/settings'));
app.use('/api/support/actions', requireSecret, require('./routes/actions'));
app.use('/api/support/test-runner', requireSecret, require('./routes/test-runner'));
app.use('/api/support/ingest/whatsapp', requireSecret, require('./routes/ingest'));

// Evolution API webhook — uses its own secret (separate from dashboard auth)
const evolutionAuth = (req, res, next) => {
  if (!EVOLUTION_WEBHOOK_SECRET) return next(); // no secret = open (dev)
  const header = req.headers['x-webhook-secret'] || req.headers['apikey'];
  if (header === EVOLUTION_WEBHOOK_SECRET) return next();
  console.warn(`${LOG_TAG} Evolution webhook auth failed from ${req.ip}`);
  return res.status(401).json({ error: 'Unauthorized' });
};
app.use('/api/support/ingest/evolution', evolutionAuth, require('./routes/ingest-evolution'));

// WhatsApp management routes — dashboard can connect/disconnect WhatsApp accounts
app.use('/api/support/whatsapp', requireSecret, require('./routes/whatsapp'));

// Static media files (no auth — files have random names)
const path = require('path');
app.use('/api/support/media', require('express').static(path.join(__dirname, '..', '..', 'db', 'media')));

// ─── Start ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`${LOG_TAG} Listening on port ${PORT}`);

  // Start auto-close worker (closes stale conversations + compacts sessions)
  const { startAutoClose } = require('./lib/auto-close');
  startAutoClose();
});
