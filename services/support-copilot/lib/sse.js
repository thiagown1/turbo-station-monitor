/**
 * SSE Event Bus — Support Copilot
 *
 * Lightweight pub/sub for pushing real-time updates to connected dashboard clients.
 * Replaces the polling approach (conversations/15s + messages/8s).
 *
 * Usage:
 *   const { sseRouter, emitEvent } = require('./sse');
 *   app.use('/api/support', sseRouter);
 *   emitEvent({ type: 'message', conversationId: 'conv_xxx' });
 */

const { Router } = require('express');
const { LOG_TAG } = require('./constants');

const router = Router();

// Connected SSE clients
const clients = new Set();

// ─── SSE endpoint ────────────────────────────────────────────────────────────

router.get('/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // nginx compatibility
  });

  // Send initial connection event
  res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);

  clients.add(res);
  console.log(`${LOG_TAG} SSE client connected (total: ${clients.size})`);

  // Heartbeat every 30s to keep connection alive
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 30000);

  req.on('close', () => {
    clients.delete(res);
    clearInterval(heartbeat);
    console.log(`${LOG_TAG} SSE client disconnected (total: ${clients.size})`);
  });
});

// ─── Emit to all connected clients ──────────────────────────────────────────

/**
 * Broadcast an event to all connected SSE clients.
 * @param {{ type: string, conversationId?: string, [key: string]: any }} event
 */
function emitEvent(event) {
  if (clients.size === 0) return;

  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of clients) {
    try {
      client.write(data);
    } catch {
      clients.delete(client);
    }
  }
}

module.exports = { sseRouter: router, emitEvent };
