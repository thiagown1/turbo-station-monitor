/**
 * Evolution API Webhook Adapter — Support Copilot
 *
 * POST /api/support/ingest/evolution — receives webhooks from Evolution API,
 * transforms the payload and feeds into the existing ingest logic.
 *
 * Supported events:
 *   - messages.upsert (incoming text, image, audio, video, document, sticker)
 *
 * Ignored:
 *   - fromMe = true (outbound echoes)
 *   - status events, group messages, etc.
 *
 * Example Evolution API webhook payload (messages.upsert):
 * {
 *   "event": "messages.upsert",
 *   "instance": "turbostation",
 *   "data": {
 *     "key": { "remoteJid": "5521999991234@s.whatsapp.net", "fromMe": false, "id": "3EB0XXX" },
 *     "pushName": "João Silva",
 *     "message": { "conversation": "Não consigo carregar" },
 *     "messageType": "conversation",
 *     "messageTimestamp": 1710862800
 *   }
 * }
 */

const { Router } = require('express');
const fs = require('fs');
const path = require('path');
const { db, stmts, nowIso, randomId, normalizePhone } = require('../lib/db');
const { LOG_TAG, EVOLUTION_INSTANCE_BRAND_MAP } = require('../lib/constants');
const { emitEvent } = require('../lib/sse');

const router = Router();
const MEDIA_DIR = path.join(__dirname, '..', '..', '..', 'db', 'media');
// Ensure media directory exists
if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Extract phone number from remoteJid.
 * Formats: "5521999991234@s.whatsapp.net" or "5521999991234@lid"
 */
function phoneFromJid(remoteJid) {
  if (!remoteJid) return null;
  return remoteJid.split('@')[0];
}

/**
 * Check if the message is from a group (not individual chat).
 * Group JIDs end with @g.us
 */
function isGroupMessage(remoteJid) {
  return remoteJid && remoteJid.endsWith('@g.us');
}

/**
 * Extract text body from Evolution API message object.
 * Handles multiple message types:
 *  - conversation (plain text)
 *  - extendedTextMessage (text with link preview, etc.)
 *  - imageMessage (caption)
 *  - videoMessage (caption)
 *  - audioMessage (transcription note)
 *  - documentMessage (caption or filename)
 *  - stickerMessage
 */
function extractBody(message, messageType) {
  if (!message) return null;

  // Plain text
  if (message.conversation) return message.conversation;

  // Extended text (link previews, quotes, etc.)
  if (message.extendedTextMessage?.text) return message.extendedTextMessage.text;

  // Image with caption
  if (message.imageMessage?.caption) return message.imageMessage.caption;
  if (message.imageMessage) return '[📷 Imagem]';

  // Video with caption
  if (message.videoMessage?.caption) return message.videoMessage.caption;
  if (message.videoMessage) return '[🎥 Vídeo]';

  // Audio
  if (message.audioMessage) return '[🎤 Áudio]';

  // Document
  if (message.documentMessage?.fileName) return `[📎 ${message.documentMessage.fileName}]`;
  if (message.documentMessage) return '[📎 Documento]';

  // Sticker
  if (message.stickerMessage) return '[🎨 Sticker]';

  // Location
  if (message.locationMessage) {
    const lat = message.locationMessage.degreesLatitude;
    const lng = message.locationMessage.degreesLongitude;
    return `[📍 Localização: ${lat}, ${lng}]`;
  }

  // Contact card
  if (message.contactMessage) return `[👤 Contato: ${message.contactMessage.displayName || 'N/A'}]`;

  // Template message (from business accounts like banks, stores, etc.)
  if (message.templateMessage) {
    const tmpl = message.templateMessage;
    // hydratedTemplate has the actual rendered content
    const hydrated = tmpl.hydratedTemplate || tmpl.hydratedFourRowTemplate || {};
    const parts = [];
    if (hydrated.hydratedTitleText) parts.push(hydrated.hydratedTitleText);
    if (hydrated.hydratedContentText) parts.push(hydrated.hydratedContentText);
    if (parts.length > 0) return parts.join('\n');
    // Fallback: try other template fields
    if (tmpl.contentText) return tmpl.contentText;
    return '[📋 Mensagem de template]';
  }

  // List message (interactive list selection)
  if (message.listMessage) {
    return message.listMessage.description || message.listMessage.title || '[📋 Lista]';
  }

  // Button response
  if (message.buttonsResponseMessage) {
    return message.buttonsResponseMessage.selectedDisplayText || '[🔘 Botão selecionado]';
  }

  // Interactive message (buttons, lists, products)
  if (message.interactiveMessage) {
    const body = message.interactiveMessage.body?.text;
    const header = message.interactiveMessage.header?.title;
    if (body) return header ? `${header}\n${body}` : body;
    if (header) return header;
    return '[📋 Mensagem interativa]';
  }

  // Fallback
  return `[${messageType || 'unknown'}]`;
}

/**
 * Extract media metadata if present.
 */
function extractMedia(message) {
  const mediaTypes = ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'];

  for (const type of mediaTypes) {
    if (message[type]) {
      return {
        media_type: type.replace('Message', ''),
        mimetype: message[type].mimetype || null,
        url: message[type].url || null,
        filename: message[type].fileName || null,
        caption: message[type].caption || null,
      };
    }
  }
  return null;
}

// ─── Main webhook handler ───────────────────────────────────────────────────

router.post('/', (req, res) => {
  const { event, instance, data } = req.body;

  // Only process messages.upsert events
  if (event !== 'messages.upsert') {
    return res.json({ ok: true, skipped: true, reason: `event ${event} not handled` });
  }

  if (!data || !data.key) {
    return res.status(400).json({ error: 'Invalid payload: missing data.key' });
  }

  const { key, pushName, message, messageType, messageTimestamp } = data;

  // Determine message direction: fromMe = outbound (operator replied from WhatsApp)
  const direction = key.fromMe ? 'outbound' : 'inbound';

  // Skip protocol/system messages (read receipts, key distribution, reactions, etc.)
  const skipTypes = ['protocolMessage', 'senderKeyDistributionMessage', 'reactionMessage', 'messageContextInfo'];
  if (messageType && skipTypes.includes(messageType)) {
    return res.json({ ok: true, skipped: true, reason: `messageType ${messageType} filtered` });
  }
  if (message && message.protocolMessage) {
    return res.json({ ok: true, skipped: true, reason: 'protocolMessage detected' });
  }

  // Skip group messages (only handle 1:1 support chats)
  if (isGroupMessage(key.remoteJid)) {
    return res.json({ ok: true, skipped: true, reason: 'group message' });
  }

  // Extract phone from JID
  const phone = phoneFromJid(key.remoteJid);
  if (!phone) {
    return res.status(400).json({ error: 'Could not extract phone from remoteJid' });
  }

  // Map Evolution API instance name → brand_id
  const brandId = EVOLUTION_INSTANCE_BRAND_MAP[instance] || instance;

  // Extract text body
  const body = extractBody(message, messageType);
  if (!body) {
    return res.json({ ok: true, skipped: true, reason: 'no extractable body' });
  }

  // Extract media info (if any)
  const media = extractMedia(message || {});

  // Save media file if base64 data was included by gateway
  const { mediaBase64, mediaMimetype } = data;
  if (media && mediaBase64) {
    try {
      const extMap = { 'audio/ogg': 'ogg', 'audio/ogg; codecs=opus': 'ogg', 'audio/mpeg': 'mp3', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'video/mp4': 'mp4', 'application/pdf': 'pdf' };
      const ext = extMap[(mediaMimetype || '').toLowerCase()] || 'bin';
      const filename = `${key.id}.${ext}`;
      const filepath = path.join(MEDIA_DIR, filename);
      fs.writeFileSync(filepath, Buffer.from(mediaBase64, 'base64'));
      media.url = `/api/support/media/${filename}`;
      media.mimetype = mediaMimetype || media.mimetype;
      console.log(`${LOG_TAG} Saved media: ${filename} (${Buffer.from(mediaBase64, 'base64').length} bytes)`);
    } catch (err) {
      console.error(`${LOG_TAG} Failed to save media:`, err.message);
    }
  }

  const normalizedPhone = normalizePhone(phone);
  const externalMessageId = key.id;

  // Detect LID format (WhatsApp internal ID, not a real phone number — typically > 13 digits)
  const isLid = normalizedPhone.length > 13;

  // ─── Upsert conversation ───────────────────────────────────────────────
  // Unified lookup: check both customer_phone AND phone_aliases in one query.
  // This fixes the LID ↔ phone dedup gap where a LID-created conv (phone=null)
  // would not be found when outbound messages arrive with the real phone number.
  let existing = stmts.findConvByPhoneOrAlias.get(brandId, normalizedPhone, normalizedPhone);

  const now = nowIso();
  let conversationId;
  let created = false;

  // Only update customer_name from inbound messages (pushName from fromMe = our own name)
  const customerName = direction === 'inbound' ? (pushName || null) : null;

  if (existing) {
    conversationId = existing.id;

    // Reopen closed conversations on new inbound message (new atendimento)
    if (existing.status === 'closed' && direction === 'inbound') {
      db.prepare(`UPDATE conversations SET status = 'open', updated_at = ? WHERE id = ?`)
        .run(now, existing.id);
      console.log(`${LOG_TAG} Reopened closed conv ${existing.id} — new atendimento`);

      // Reset compact flag so this new atendimento can be compacted when it closes
      try {
        db.prepare(`UPDATE session_context SET compacted_at = NULL, full_context_sent = 0, last_msg_index = 0 WHERE conversation_id = ?`)
          .run(existing.id);
      } catch (_) { /* session_context may not exist yet */ }

      // Audit log
      db.prepare(`INSERT INTO audit_log (id, brand_id, conversation_id, action, actor_user_id, metadata_json, created_at) VALUES (?,?,?,?,?,?,?)`)
        .run(randomId('audit'), brandId, existing.id, 'support.reopen', null, JSON.stringify({ reason: 'new_inbound_message' }), now);

      emitEvent({ type: 'conversation_update', conversationId: existing.id, brandId });
    }

    // Backfill: if conv was created from LID (no customer_phone) and we now
    // have the real phone from an outbound or inbound message, set it.
    if (!existing.customer_phone && !isLid) {
      db.prepare(`
        UPDATE conversations SET customer_phone = ?, updated_at = ? WHERE id = ?
      `).run(normalizedPhone, now, existing.id);
      console.log(`${LOG_TAG} Backfilled customer_phone=${normalizedPhone} on conv ${existing.id}`);
    }

    // Cross-link: if conv has a real phone but this message came via LID,
    // add the LID to aliases if not already there.
    if (isLid && existing.customer_phone) {
      const aliases = existing.phone_aliases || '';
      if (!aliases.split(',').includes(normalizedPhone)) {
        const newAliases = aliases ? `${aliases},${normalizedPhone}` : normalizedPhone;
        db.prepare(`
          UPDATE conversations SET phone_aliases = ?, updated_at = ? WHERE id = ?
        `).run(newAliases, now, existing.id);
        console.log(`${LOG_TAG} Added LID ${normalizedPhone} as alias on conv ${existing.id}`);
      }
    }

    if (customerName) {
      db.prepare(`
        UPDATE conversations SET customer_name = ?, updated_at = ? WHERE id = ?
      `).run(customerName, now, existing.id);
    } else {
      db.prepare(`
        UPDATE conversations SET updated_at = ? WHERE id = ?
      `).run(now, existing.id);
    }
  } else if (direction === 'outbound' && isLid) {
    // fromMe + LID = likely a contact already tracked by real phone — skip to avoid ghost convos
    console.log(`${LOG_TAG} Skipping fromMe + LID (${normalizedPhone}), no existing conversation found`);
    return res.json({ ok: true, skipped: true, reason: 'fromMe with LID, no matching conversation' });
  } else {
    conversationId = randomId('conv');
    created = true;
    if (isLid) {
      // LID: store it as alias, not as the primary phone (it's not a real number)
      db.prepare(`
        INSERT INTO conversations (id, brand_id, channel, external_user_id, external_conversation_id,
          customer_phone, customer_name, phone_aliases, status, assigned_agent_id, priority,
          last_message_at, last_inbound_at, last_outbound_at, unread_count, created_at, updated_at)
        VALUES (?, ?, 'whatsapp', NULL, NULL, NULL, ?, ?, 'open', NULL, 'normal', NULL, NULL, NULL, 0, ?, ?)
      `).run(conversationId, brandId, customerName || null, normalizedPhone, now, now);
      console.log(`${LOG_TAG} Created conv ${conversationId} with LID ${normalizedPhone} as alias (no real phone yet)`);
    } else {
      db.prepare(`
        INSERT INTO conversations (id, brand_id, channel, external_user_id, external_conversation_id,
          customer_phone, customer_name, status, assigned_agent_id, priority,
          last_message_at, last_inbound_at, last_outbound_at, unread_count, created_at, updated_at)
        VALUES (?, ?, 'whatsapp', NULL, NULL, ?, ?, 'open', NULL, 'normal', NULL, NULL, NULL, 0, ?, ?)
      `).run(conversationId, brandId, normalizedPhone, customerName || null, now, now);
    }
  }

  // ─── Dedup by external_message_id ─────────────────────────────────────
  if (externalMessageId) {
    const dup = stmts.findMsgByExternalId.get(conversationId, brandId, externalMessageId);
    if (dup) {
      return res.json({ id: dup.id, conversationId, duplicate: true });
    }
  }

  // ─── Insert message ───────────────────────────────────────────────────
  const msgId = randomId('msg');
  const mediaJson = media ? JSON.stringify(media) : null;

  db.transaction(() => {
    db.prepare(`
      INSERT INTO messages (id, conversation_id, brand_id, direction, source, body, author_id, external_message_id, media_json, delivery_status, created_at)
      VALUES (?, ?, ?, ?, 'evolution', ?, NULL, ?, ?, ?, ?)
    `).run(msgId, conversationId, brandId, direction, body, externalMessageId || null, mediaJson, direction === 'outbound' ? 'sent' : null, now);

    if (direction === 'inbound') {
      db.prepare(`
        UPDATE conversations SET last_message_at = ?, last_inbound_at = ?, unread_count = unread_count + 1, updated_at = ? WHERE id = ?
      `).run(now, now, now, conversationId);
    } else {
      db.prepare(`
        UPDATE conversations SET last_message_at = ?, last_outbound_at = ?, updated_at = ? WHERE id = ?
      `).run(now, now, now, conversationId);
    }
  })();

  console.log(`${LOG_TAG} Evolution ingest: ${created ? 'new' : 'existing'} conv ${conversationId}, msg ${msgId}, from ${normalizedPhone} (${pushName || 'unknown'})`);

  // ── Fetch profile picture (fire-and-forget for new conversations) ────
  if (created && normalizedPhone && !isLid) {
    const instanceName = Object.entries(EVOLUTION_INSTANCE_BRAND_MAP)
      .find(([, brand]) => brand === brandId)?.[0] || brandId;
    const { fetchProfilePic } = require('../lib/evolution-client');
    fetchProfilePic(instanceName, normalizedPhone).then(picUrl => {
      if (picUrl) {
        db.prepare('UPDATE conversations SET profile_pic_url = ? WHERE id = ?')
          .run(picUrl, conversationId);
        console.log(`${LOG_TAG} Profile pic saved for ${conversationId}: ${picUrl.substring(0, 80)}...`);
      }
    }).catch(err => {
      console.warn(`${LOG_TAG} Profile pic fetch failed for ${normalizedPhone}:`, err.message);
    });
  }

  // Push SSE event to connected dashboards (with full message + conversation metadata for in-place sidebar update)
  const updatedConv = stmts.getConversation.get(conversationId);
  emitEvent({
    type: created ? 'conversation_created' : 'message',
    conversationId,
    direction,
    brandId,
    message: {
      id: msgId,
      conversation_id: conversationId,
      brand_id: brandId,
      direction,
      source: 'evolution',
      body,
      author_id: null,
      media_json: mediaJson,
      delivery_status: direction === 'outbound' ? 'sent' : null,
      created_at: now,
    },
    // Conversation metadata for in-place sidebar update (avoids full refetch)
    conversation: updatedConv ? {
      id: updatedConv.id,
      status: updatedConv.status,
      customerName: updatedConv.customer_name,
      customerPhone: updatedConv.customer_phone,
      lastMessageAt: updatedConv.last_message_at,
      unreadCount: updatedConv.unread_count,
      lastMessagePreview: body,
      profilePicUrl: updatedConv.profile_pic_url,
      tags: updatedConv.tags_json ? JSON.parse(updatedConv.tags_json) : [],
    } : null,
  });

  // NOTE: We no longer inject every message into the agent session here.
  // The incremental prompt system in generateSuggestion() handles sending
  // all pending messages when the operator clicks Copilot. This avoids
  // wasting tokens on messages the operator may not need help with.

  // Process media in background (transcribe audio, describe images/video)
  if (media && media.url && direction === 'inbound') {
    const { processMedia } = require('../lib/media-processor');
    const mediaFilePath = path.join(MEDIA_DIR, path.basename(media.url));
    const mediaType = media.media_type; // audio, image, video, document, sticker

    // Build recent conversation context for the media describer
    let conversationContext = '';
    try {
      const recentMsgs = db.prepare(
        'SELECT direction, body FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 5'
      ).all(conversationId);
      if (recentMsgs.length > 0) {
        conversationContext = recentMsgs.reverse().map(m => {
          const role = m.direction === 'inbound' ? 'Cliente' : 'Operador';
          return `[${role}]: ${m.body}`;
        }).join('\n');
      }
    } catch { /* ignore */ }

    // Fire-and-forget: process and update message body
    processMedia(mediaFilePath, mediaType, { conversationContext }).then(description => {
      if (description) {
        const enrichedBody = `${body} ${description}`;
        db.prepare('UPDATE messages SET body = ? WHERE id = ?').run(enrichedBody, msgId);
        console.log(`${LOG_TAG} Media enriched msg ${msgId}: ${description.substring(0, 80)}...`);

        // Notify dashboard (agent context will be updated on next Copilot click)
        emitEvent({ type: 'message_update', conversationId, messageId: msgId, brandId });
      }
    }).catch(err => {
      console.warn(`${LOG_TAG} Media processing failed for msg ${msgId}:`, err.message);
    });
  }

  res.status(201).json({
    id: msgId,
    conversationId,
    created,
    duplicate: false,
    source: 'evolution',
  });

  // ─── Auto-suggest / auto-respond (debounced — waits for user to stop typing) ─
  if (direction === 'inbound') {
    try {
      const settings = db.prepare(
        'SELECT auto_suggest, auto_respond FROM copilot_settings WHERE brand_id = ?'
      ).get(brandId);

      if (settings?.auto_suggest) {
        // Debounce: wait for user to stop sending messages before generating suggestion.
        // If another message arrives within DEBOUNCE_MS, the previous timer is cancelled.
        const DEBOUNCE_MS = media ? 12000 : 5000; // Longer for media (transcription delay)
        
        // Use conversationId as debounce key
        if (global._copilotDebounceTimers) {
          clearTimeout(global._copilotDebounceTimers[conversationId]);
        } else {
          global._copilotDebounceTimers = {};
        }

        global._copilotDebounceTimers[conversationId] = setTimeout(async () => {
          delete global._copilotDebounceTimers[conversationId];
          try {
            const { generateSuggestion } = require('../lib/copilot');
            const conv = stmts.getConversation.get(conversationId);
            if (!conv || conv.status === 'closed' || conv.is_staff) return;

            const allMsgs = db.prepare(
              'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC'
            ).all(conversationId);

            // Skip if last message is outbound (operator already replied)
            const lastMsg = allMsgs[allMsgs.length - 1];
            if (lastMsg?.direction === 'outbound') return;

            const result = await generateSuggestion(conv, allMsgs);
            // generateSuggestion returns { text, model, waiting?, noReply?, tags? }
            if (!result?.text || result.waiting || result.noReply) return;

            console.log(`${LOG_TAG} [auto-suggest] ${conversationId}: "${result.text.substring(0, 60)}..."`);

            // Save suggestion to DB
            const sugId = randomId('sug');
            const sugNow = nowIso();
            db.prepare(`
              INSERT INTO suggestions (id, conversation_id, brand_id, status, suggestion_text, model_name, created_at, updated_at, decided_by, decided_at)
              VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, NULL, NULL)
            `).run(sugId, conversationId, brandId, result.text, result.model, sugNow, sugNow);

            // Notify dashboard of the new suggestion
            emitEvent({
              type: 'auto_suggestion',
              conversationId,
              brandId,
              suggestion: result.text,
              suggestionId: sugId,
              model: result.model,
            });

            // Auto-respond if enabled
            if (settings.auto_respond && result.model !== 'template-fallback') {
              const { sendText } = require('../lib/evolution-client');
              const customerPhone = conv.customer_phone;
              if (customerPhone) {
                // Resolve the Evolution API instance name for this brand
                const instanceName = Object.entries(EVOLUTION_INSTANCE_BRAND_MAP)
                  .find(([, brand]) => brand === brandId)?.[0] || brandId;
                await sendText(instanceName, customerPhone, result.text);

                // Save outbound message
                const outMsgId = randomId('msg');
                const outNow = nowIso();
                db.prepare(`
                  INSERT INTO messages (id, conversation_id, brand_id, direction, source, body, author_id, external_message_id, delivery_status, created_at)
                  VALUES (?, ?, ?, 'outbound', 'auto-respond', ?, NULL, NULL, 'sent', ?)
                `).run(outMsgId, conversationId, brandId, result.text, outNow);

                db.prepare('UPDATE conversations SET last_message_at = ?, last_outbound_at = ?, updated_at = ? WHERE id = ?')
                  .run(outNow, outNow, outNow, conversationId);

                // Mark suggestion as accepted
                db.prepare('UPDATE suggestions SET status = ?, decided_by = ?, decided_at = ?, updated_at = ? WHERE id = ?')
                  .run('accepted', 'auto-respond', outNow, outNow, sugId);

                const autoConv = stmts.getConversation.get(conversationId);
                emitEvent({
                  type: 'message',
                  conversationId,
                  direction: 'outbound',
                  brandId,
                  message: {
                    id: outMsgId,
                    conversation_id: conversationId,
                    brand_id: brandId,
                    direction: 'outbound',
                    source: 'auto-respond',
                    body: result.text,
                    author_id: null,
                    media_json: null,
                    delivery_status: 'sent',
                    created_at: outNow,
                  },
                  conversation: autoConv ? {
                    id: autoConv.id,
                    status: autoConv.status,
                    customerName: autoConv.customer_name,
                    customerPhone: autoConv.customer_phone,
                    lastMessageAt: autoConv.last_message_at,
                    unreadCount: autoConv.unread_count,
                    lastMessagePreview: result.text,
                    profilePicUrl: autoConv.profile_pic_url,
                    tags: autoConv.tags_json ? JSON.parse(autoConv.tags_json) : [],
                  } : null,
                });
                console.log(`${LOG_TAG} [auto-respond] Sent to ${customerPhone} via ${instanceName}: "${result.text.substring(0, 60)}..."`);
              }
            }
          } catch (err) {
            console.warn(`${LOG_TAG} [auto-suggest] Failed for ${conversationId}:`, err.message);
          }
        }, DEBOUNCE_MS);
      }
    } catch (err) {
      // Non-blocking — log and continue
      console.warn(`${LOG_TAG} [auto-suggest] Settings check failed:`, err.message);
    }
  }
});

module.exports = router;
