/**
 * Group auto-suggest scheduler — Support Copilot
 *
 * Pre-generates a copilot reply suggestion for WhatsApp GROUP conversations
 * so the suggestion is already waiting in the dashboard when the operator
 * opens the chat. Debounced per-conversation: if more messages arrive within
 * the window the timer resets, so only the latest state is used.
 *
 * Phase 1 is SUGGEST-ONLY for groups — it NEVER sends to WhatsApp. The 1:1
 * auto-suggest / auto-respond path lives inline in ingest-evolution.js and is
 * intentionally left untouched here.
 *
 * Gated by copilot_settings.auto_suggest_groups (default ON). Skips closed
 * conversations, staff conversations, and turns where the last message is
 * outbound (operator already replied).
 *
 * @module lib/auto-suggest
 */

const { db, stmts, nowIso, randomId } = require('./db');
const { LOG_TAG } = require('./constants');
const { emitEvent } = require('./sse');

/**
 * Schedule a debounced, pre-generated copilot suggestion for a group convo.
 * @param {string} conversationId
 * @param {string} brandId
 * @param {{ media?: boolean }} opts
 */
function scheduleGroupSuggestion(conversationId, brandId, { media = false } = {}) {
  // Longer debounce for media (transcription / vision pre-pass takes time).
  const DEBOUNCE_MS = media ? 12000 : 5000;

  if (global._copilotDebounceTimers) {
    clearTimeout(global._copilotDebounceTimers[conversationId]);
  } else {
    global._copilotDebounceTimers = {};
  }

  global._copilotDebounceTimers[conversationId] = setTimeout(async () => {
    delete global._copilotDebounceTimers[conversationId];
    try {
      const conv = stmts.getConversation.get(conversationId);
      if (!conv || conv.channel !== 'whatsapp-group') return;
      if (conv.status === 'closed' || conv.is_staff) return;

      const settings = db.prepare(
        'SELECT auto_suggest_groups FROM copilot_settings WHERE brand_id = ?'
      ).get(brandId);
      // Default ON: a missing row or NULL column means groups get suggestions.
      const enabled = settings
        ? (settings.auto_suggest_groups == null ? 1 : settings.auto_suggest_groups)
        : 1;
      if (!enabled) return;

      const allMsgs = db.prepare(
        'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC'
      ).all(conversationId);

      // Skip if the operator already replied (last message outbound).
      const lastMsg = allMsgs[allMsgs.length - 1];
      if (!lastMsg || lastMsg.direction === 'outbound') return;

      emitEvent({ type: 'copilot_started', conversationId, brandId });

      const { generateSuggestion } = require('./copilot');
      const result = await generateSuggestion(conv, allMsgs);
      // generateSuggestion → { text, model, waiting?, noReply?, tags? }
      if (!result || !result.text || result.waiting || result.noReply) return;

      const sugId = randomId('sug');
      const sugNow = nowIso();
      db.prepare(`
        INSERT INTO suggestions (id, conversation_id, brand_id, status, suggestion_text, model_name, created_at, updated_at, decided_by, decided_at)
        VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, NULL, NULL)
      `).run(sugId, conversationId, brandId, result.text, result.model, sugNow, sugNow);

      console.log(`${LOG_TAG} [group-suggest] ${conversationId}: "${result.text.substring(0, 60)}..."`);

      emitEvent({
        type: 'auto_suggestion',
        conversationId,
        brandId,
        suggestion: result.text,
        suggestionId: sugId,
        model: result.model,
      });
    } catch (err) {
      console.warn(`${LOG_TAG} [group-suggest] failed for ${conversationId}:`, err.message);
    }
  }, DEBOUNCE_MS);
}

module.exports = { scheduleGroupSuggestion };
