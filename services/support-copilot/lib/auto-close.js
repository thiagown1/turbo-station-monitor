/**
 * Auto-close Worker — Support Copilot
 *
 * Periodically checks for stale conversations and auto-closes them.
 * When a conversation is closed, triggers OpenClaw session compaction
 * to summarize the history and free context memory.
 *
 * Staleness criteria:
 *  - No messages for INACTIVITY_HOURS (default: 24h)
 *  - Conversation status is 'open'
 *
 * @module lib/auto-close
 */

const { db, stmts, nowIso, randomId } = require('./db');
const { LOG_TAG } = require('./constants');
const { compactSession } = require('./copilot');
const { emitEvent } = require('./sse');

// ─── Configuration ────────────────────────────────────────────────────────────

/** Minutes of inactivity before auto-closing. Override via env. */
const INACTIVITY_MINUTES = parseInt(process.env.AUTO_CLOSE_INACTIVITY_MINUTES || '30', 10);

/** How often to run the check (minutes). Override via env. */
const CHECK_INTERVAL_MINUTES = parseInt(process.env.AUTO_CLOSE_CHECK_MINUTES || '5', 10);

/** Enable/disable auto-close. Override via env. */
const AUTO_CLOSE_ENABLED = process.env.AUTO_CLOSE_ENABLED !== 'false'; // enabled by default

// ─── Stale conversation detection ─────────────────────────────────────────────

/**
 * Find open conversations with no messages for N hours.
 * Uses last_message_at (or updated_at as fallback).
 */
function findStaleConversations() {
  const cutoff = new Date(Date.now() - INACTIVITY_MINUTES * 60 * 1000).toISOString();

  return db.prepare(`
    SELECT id, brand_id, customer_name, customer_phone, last_message_at, updated_at
    FROM conversations
    WHERE status = 'open'
      AND datetime(COALESCE(last_message_at, updated_at)) < datetime(?)
    ORDER BY datetime(COALESCE(last_message_at, updated_at)) ASC
  `).all(cutoff);
}

// ─── Auto-close logic ─────────────────────────────────────────────────────────

async function runAutoClose() {
  const stale = findStaleConversations();
  if (stale.length === 0) return;

  console.log(`${LOG_TAG} [auto-close] Found ${stale.length} stale conversation(s) (>${INACTIVITY_MINUTES}min inactive)`);

  for (const conv of stale) {
    try {
      const now = nowIso();
      const lastActivity = conv.last_message_at || conv.updated_at;
      const minsInactive = ((Date.now() - new Date(lastActivity).getTime()) / (1000 * 60)).toFixed(0);

      // Close the conversation
      db.prepare(`UPDATE conversations SET status = 'closed', updated_at = ? WHERE id = ?`)
        .run(now, conv.id);

      // Audit log
      db.prepare(`INSERT INTO audit_log (id, brand_id, conversation_id, action, actor_user_id, metadata_json, created_at) VALUES (?,?,?,?,?,?,?)`)
        .run(
          randomId('audit'),
          conv.brand_id,
          conv.id,
          'support.auto_close',
          null,
          JSON.stringify({ reason: 'inactivity', minutesInactive: minsInactive, threshold: INACTIVITY_MINUTES }),
          now
        );

      console.log(`${LOG_TAG} [auto-close] Closed ${conv.id} (${conv.customer_name || 'unknown'}) — ${minsInactive}min inactive`);

      // Emit SSE event so dashboard updates in real-time
      emitEvent({ type: 'conversation_update', conversationId: conv.id, brandId: conv.brand_id });

      // Compact the session (fire-and-forget, non-blocking)
      compactSession(conv.id, conv.brand_id).catch(err => {
        console.warn(`${LOG_TAG} [auto-close] Compact failed for ${conv.id}:`, err.message);
      });

    } catch (err) {
      console.error(`${LOG_TAG} [auto-close] Error closing ${conv.id}:`, err.message);
    }
  }
}

// ─── Scheduler ────────────────────────────────────────────────────────────────

let intervalId = null;

function startAutoClose() {
  if (!AUTO_CLOSE_ENABLED) {
    console.log(`${LOG_TAG} [auto-close] Disabled (AUTO_CLOSE_ENABLED=false)`);
    return;
  }

  const intervalMs = CHECK_INTERVAL_MINUTES * 60 * 1000;
  console.log(`${LOG_TAG} [auto-close] Started — checking every ${CHECK_INTERVAL_MINUTES}min, closing after ${INACTIVITY_MINUTES}min inactivity`);

  // Run once on startup (after a small delay to let things initialize)
  setTimeout(() => runAutoClose().catch(err => {
    console.error(`${LOG_TAG} [auto-close] Initial run failed:`, err.message);
  }), 10_000);

  // Then run periodically
  intervalId = setInterval(() => {
    runAutoClose().catch(err => {
      console.error(`${LOG_TAG} [auto-close] Periodic run failed:`, err.message);
    });
  }, intervalMs);
}

function stopAutoClose() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    console.log(`${LOG_TAG} [auto-close] Stopped`);
  }
}

module.exports = { startAutoClose, stopAutoClose, runAutoClose, findStaleConversations };
