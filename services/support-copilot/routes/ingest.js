/**
 * WhatsApp Ingest Route — Support Copilot
 *
 * POST /api/support/ingest/whatsapp — receives incoming WhatsApp messages,
 * upserts conversation, inserts message with dedup.
 */

const { Router } = require('express');
const { db, stmts, nowIso, randomId, normalizePhone } = require('../lib/db');
const { LOG_TAG } = require('../lib/constants');

const router = Router();

router.post('/', (req, res) => {
  const { brand_id, phone, customer_name, body, external_message_id, external_conversation_id } = req.body;

  if (!brand_id || !phone || !body) {
    return res.status(400).json({ error: 'brand_id, phone, and body are required' });
  }

  const normalizedPhone = normalizePhone(phone);

  // Upsert conversation (phone lookup is brand-agnostic — see lib/db.js findConvByPhone)
  const existing = stmts.findConvByPhone.get(normalizedPhone);
  const now = nowIso();
  let conversationId;
  let created = false;

  if (existing) {
    conversationId = existing.id;
    db.prepare(`
      UPDATE conversations SET customer_name = COALESCE(?, customer_name),
        external_conversation_id = COALESCE(?, external_conversation_id), updated_at = ? WHERE id = ?
    `).run(customer_name || null, external_conversation_id || null, now, existing.id);
  } else {
    conversationId = randomId('conv');
    created = true;
    db.prepare(`
      INSERT INTO conversations (id, brand_id, channel, external_user_id, external_conversation_id,
        customer_phone, customer_name, status, assigned_agent_id, priority,
        last_message_at, last_inbound_at, last_outbound_at, unread_count, created_at, updated_at)
      VALUES (?, ?, 'whatsapp', NULL, ?, ?, ?, 'open', NULL, 'normal', NULL, NULL, NULL, 0, ?, ?)
    `).run(conversationId, brand_id, external_conversation_id || null, normalizedPhone, customer_name || null, now, now);
  }

  // Dedup by external_message_id
  if (external_message_id) {
    const dup = stmts.findMsgByExternalId.get(conversationId, brand_id, external_message_id);
    if (dup) {
      return res.json({ id: dup.id, conversationId, duplicate: true });
    }
  }

  // Insert message
  const msgId = randomId('msg');
  db.transaction(() => {
    db.prepare(`
      INSERT INTO messages (id, conversation_id, brand_id, direction, source, body, author_id, external_message_id, created_at)
      VALUES (?, ?, ?, 'inbound', 'whatsapp', ?, NULL, ?, ?)
    `).run(msgId, conversationId, brand_id, body, external_message_id || null, now);

    db.prepare(`
      UPDATE conversations SET last_message_at = ?, last_inbound_at = ?, unread_count = unread_count + 1, updated_at = ? WHERE id = ?
    `).run(now, now, now, conversationId);
  })();

  console.log(`${LOG_TAG} Ingest: ${created ? 'new' : 'existing'} conv ${conversationId}, msg ${msgId}`);
  res.status(201).json({ id: msgId, conversationId, created, duplicate: false });
});

module.exports = router;
