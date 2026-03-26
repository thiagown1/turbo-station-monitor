/**
 * Conversations Routes — Support Copilot
 *
 * GET  /api/support/conversations           — list by brand
 * GET  /api/support/conversations/:id        — get one
 * GET  /api/support/conversations/:id/messages    — list messages
 * GET  /api/support/conversations/:id/suggestions — list suggestions
 * GET  /api/support/conversations/:id/context     — conversation + messages + suggestions
 * POST /api/support/conversations/:id/messages    — send operator message
 * POST /api/support/conversations/:id/takeover    — assign to operator
 * POST /api/support/conversations/:id/release     — unassign
 * POST /api/support/conversations/:id/close       — close conversation
 * PATCH /api/support/conversations/:id/priority   — update priority
 * POST /api/support/conversations/:id/suggestions         — create suggestion
 * PATCH /api/support/conversations/:id/suggestions/:sid   — decide suggestion
 */

const { Router } = require('express');
const { db, stmts, nowIso, randomId } = require('../lib/db');
const { LOG_TAG, EVOLUTION_API_KEY } = require('../lib/constants');
const { sendText, sendMedia } = require('../lib/evolution-client');
const { emitEvent } = require('../lib/sse');
const { generateSuggestion, injectIntoSession, buildContextPreview, compactSession, extractLearnedRule, removeSuggestionFromSession, resetAgentSession } = require('../lib/copilot');

const router = Router();

// ─── Brand → Evolution instance mapping (reverse of EVOLUTION_INSTANCE_BRAND_MAP) ─
const { EVOLUTION_INSTANCE_BRAND_MAP } = require('../lib/constants');
const BRAND_TO_INSTANCE = Object.entries(EVOLUTION_INSTANCE_BRAND_MAP).reduce((map, [inst, brand]) => {
  map[brand] = inst;
  return map;
}, {});

// ─── List conversations by brand ───────────────────────────────────────────
router.get('/', (req, res) => {
  const brandId = req.query.brand_id || req.query.brandId;
  if (!brandId) return res.status(400).json({ error: 'brand_id required' });

  // Channel filter: 'whatsapp' (default, 1:1), 'whatsapp-group' (groups), 'all'
  const channel = req.query.channel || 'whatsapp';

  let rows;
  if (channel === 'all') {
    rows = db.prepare(
      `SELECT c.*,
         (SELECT m.body FROM messages m WHERE m.conversation_id = c.id ORDER BY datetime(m.created_at) DESC LIMIT 1) AS last_message_preview
       FROM conversations c WHERE c.brand_id IN (?, '__test__') ORDER BY datetime(COALESCE(c.last_message_at, c.updated_at)) DESC`
    ).all(brandId);
  } else if (channel === 'whatsapp-group') {
    rows = db.prepare(
      `SELECT c.*,
         (SELECT m.body FROM messages m WHERE m.conversation_id = c.id ORDER BY datetime(m.created_at) DESC LIMIT 1) AS last_message_preview
       FROM conversations c WHERE c.brand_id = ? AND c.channel = 'whatsapp-group' ORDER BY datetime(COALESCE(c.last_message_at, c.updated_at)) DESC`
    ).all(brandId);
  } else {
    // Default: 1:1 whatsapp + test conversations (exclude groups)
    rows = db.prepare(
      `SELECT c.*,
         (SELECT m.body FROM messages m WHERE m.conversation_id = c.id ORDER BY datetime(m.created_at) DESC LIMIT 1) AS last_message_preview
       FROM conversations c WHERE c.brand_id IN (?, '__test__') AND c.channel != 'whatsapp-group' ORDER BY datetime(COALESCE(c.last_message_at, c.updated_at)) DESC`
    ).all(brandId);
  }

  res.json({ conversations: rows, channel });
});

// ─── Bulk reset sessions (on MD changes) ──────────────────────────────────────
// MUST be before /:id routes to avoid Express matching 'reset-sessions' as :id
router.post('/reset-sessions', async (req, res) => {
  const brandId = req.query.brand_id || req.body?.brand_id;
  if (!brandId) return res.status(400).json({ error: 'brand_id required' });

  const rows = db.prepare(
    'SELECT conversation_id FROM session_context WHERE compacted_at IS NULL'
  ).all();

  let resetCount = 0;
  for (const row of rows) {
    try {
      await resetAgentSession(row.conversation_id, brandId);
      resetCount++;
    } catch (err) {
      console.warn(`${LOG_TAG} Reset failed for ${row.conversation_id}:`, err.message);
    }
  }

  console.log(`${LOG_TAG} Bulk session reset: ${resetCount}/${rows.length} sessions`);
  res.json({ ok: true, total: rows.length, reset: resetCount });
});

// ─── Get conversation ──────────────────────────────────────────────────────
router.get('/:id', (req, res) => {
  const row = stmts.getConversation.get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

// ─── Messages ──────────────────────────────────────────────────────────────
router.get('/:id/messages', (req, res) => {
  const conv = stmts.getConversation.get(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Conversation not found' });

  const limit = Math.min(parseInt(req.query.limit || '50', 10) || 50, 500);
  const offset = parseInt(req.query.offset || '0', 10) || 0;
  const { total } = stmts.countMessages.get(req.params.id);

  let messages;
  if (offset === 0 && !req.query.limit) {
    // Default: last N messages (paginated from end)
    messages = stmts.listMessagesPaginated.all(req.params.id, limit, offset);
  } else {
    messages = stmts.listMessagesPaginated.all(req.params.id, limit, offset);
  }

  // Include session info (compaction summary) for the dashboard
  let sessionSummary = null;
  try {
    const sessionCtx = stmts.getSessionContext.get(req.params.id);
    if (sessionCtx?.compaction_summary) {
      sessionSummary = {
        summary: sessionCtx.compaction_summary,
        compactedAt: sessionCtx.compacted_at,
      };
    }
  } catch { /* ignore */ }

  res.json({
    messages,
    total,
    limit,
    offset,
    hasMore: offset + messages.length < total,
    sessionSummary,
  });
});

router.post('/:id/messages', async (req, res) => {
  const conv = stmts.getConversation.get(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Conversation not found' });

  const { body: msgBody, author_id, source } = req.body;
  if (!msgBody) return res.status(400).json({ error: 'body required' });

  const now = nowIso();
  const id = randomId('msg');

  db.transaction(() => {
    db.prepare(`
      INSERT INTO messages (id, conversation_id, brand_id, direction, source, body, author_id, external_message_id, delivery_status, created_at)
      VALUES (?, ?, ?, 'outbound', ?, ?, ?, NULL, 'pending', ?)
    `).run(id, conv.id, conv.brand_id, source || 'operator', msgBody, author_id || null, now);

    db.prepare(`
      UPDATE conversations SET last_message_at = ?, last_outbound_at = ?, unread_count = 0, updated_at = ? WHERE id = ?
    `).run(now, now, now, conv.id);
  })();

  // Audit log
  db.prepare(`INSERT INTO audit_log (id, brand_id, conversation_id, action, actor_user_id, metadata_json, created_at) VALUES (?,?,?,?,?,?,?)`)
    .run(randomId('audit'), conv.brand_id, conv.id, 'support.message.sent', author_id || null, null, now);

  console.log(`${LOG_TAG} Message sent in conv ${conv.id}`);

  // Send to WhatsApp via Evolution API (1:1 or group)
  let deliveryStatus = 'sent';
  if (conv.customer_phone && (conv.channel === 'whatsapp' || conv.channel === 'whatsapp-group')) {
    const instance = BRAND_TO_INSTANCE[conv.brand_id] || conv.brand_id;
    sendText(instance, conv.customer_phone, msgBody)
      .then(() => {
        db.prepare('UPDATE messages SET delivery_status = ? WHERE id = ?').run('sent', id);
        emitEvent({ type: 'delivery_update', conversationId: conv.id, brandId: conv.brand_id, messageId: id, deliveryStatus: 'sent' });
      })
      .catch(err => {
        console.error(`${LOG_TAG} Failed to send via Evolution API (msg ${id}):`, err.message);
        db.prepare('UPDATE messages SET delivery_status = ? WHERE id = ?').run('failed', id);
        emitEvent({ type: 'delivery_update', conversationId: conv.id, brandId: conv.brand_id, messageId: id, deliveryStatus: 'failed' });
        deliveryStatus = 'failed';
      });
  } else {
    db.prepare('UPDATE messages SET delivery_status = ? WHERE id = ?').run('sent', id);
  }

  // Inject outbound message into agent session (fire-and-forget)
  // So the agent sees what was actually sent to the customer
  injectIntoSession(conv.id, `[Operador enviou ao cliente]: ${msgBody}`, conv.brand_id).catch(() => {});

  // SSE: notify connected dashboards (with full message payload + conversation metadata for in-place sidebar update)
  const updatedConv = stmts.getConversation.get(conv.id);
  emitEvent({
    type: 'message',
    conversationId: conv.id,
    direction: 'outbound',
    brandId: conv.brand_id,
    message: {
      id,
      conversation_id: conv.id,
      brand_id: conv.brand_id,
      direction: 'outbound',
      source: source || 'operator',
      body: msgBody,
      author_id: author_id || null,
      media_json: null,
      delivery_status: 'pending',
      created_at: now,
    },
    conversation: updatedConv ? {
      id: updatedConv.id,
      status: updatedConv.status,
      customerName: updatedConv.customer_name,
      customerPhone: updatedConv.customer_phone,
      lastMessageAt: updatedConv.last_message_at,
      unreadCount: updatedConv.unread_count,
      lastMessagePreview: msgBody,
      profilePicUrl: updatedConv.profile_pic_url,
      tags: updatedConv.tags ? updatedConv.tags.split(',').filter(Boolean) : [],
    } : null,
  });

  res.status(201).json({ id, createdAt: now, deliveryStatus: 'pending' });
});

// ─── Send media message ─────────────────────────────────────────────────────
router.post('/:id/media', async (req, res) => {
  const conv = stmts.getConversation.get(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Conversation not found' });

  const { base64, mimetype, caption, fileName, mediaType, author_id } = req.body;
  if (!base64 || !mimetype) return res.status(400).json({ error: 'base64 and mimetype required' });

  // Determine media type from mimetype if not provided
  const type = mediaType || (mimetype.startsWith('image/') ? 'image'
    : mimetype.startsWith('video/') ? 'video'
    : mimetype.startsWith('audio/') ? 'audio'
    : 'document');

  // Save file locally
  const fs = require('fs');
  const path = require('path');
  const ext = mimetype.split('/')[1]?.split(';')[0] || 'bin';
  const mediaId = randomId('media').replace(/^media_/, '');
  const localFileName = `${mediaId}.${ext}`;
  const mediaDir = path.join(path.dirname(require('../lib/constants').DB_PATH), 'media');
  fs.mkdirSync(mediaDir, { recursive: true });
  const filePath = path.join(mediaDir, localFileName);
  fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));

  const localUrl = `/api/support/media/${localFileName}`;
  const mediaJson = JSON.stringify({
    media_type: type,
    mimetype,
    url: localUrl,
    filename: fileName || localFileName,
    caption: caption || null,
  });

  const now = nowIso();
  const id = randomId('msg');

  db.transaction(() => {
    db.prepare(`
      INSERT INTO messages (id, conversation_id, brand_id, direction, source, body, media_json, author_id, delivery_status, created_at)
      VALUES (?, ?, ?, 'outbound', 'operator', ?, ?, ?, 'pending', ?)
    `).run(id, conv.id, conv.brand_id, caption || '', mediaJson, author_id || null, now);

    db.prepare(`
      UPDATE conversations SET last_message_at = ?, last_outbound_at = ?, unread_count = 0, updated_at = ? WHERE id = ?
    `).run(now, now, now, conv.id);
  })();

  console.log(`${LOG_TAG} Media message (${type}) sent in conv ${conv.id}`);

  // Send to WhatsApp via Evolution API (1:1 or group)
  if (conv.customer_phone && (conv.channel === 'whatsapp' || conv.channel === 'whatsapp-group')) {
    const instance = BRAND_TO_INSTANCE[conv.brand_id] || conv.brand_id;
    // Send base64 directly to Evolution API
    const base64WithPrefix = `data:${mimetype};base64,${base64}`;
    sendMedia(instance, conv.customer_phone, type, base64WithPrefix, caption || '', fileName || localFileName, mimetype)
      .then(() => {
        db.prepare('UPDATE messages SET delivery_status = ? WHERE id = ?').run('sent', id);
      })
      .catch(err => {
        console.error(`${LOG_TAG} Failed to send media via Evolution API (msg ${id}):`, err.message);
        db.prepare('UPDATE messages SET delivery_status = ? WHERE id = ?').run('failed', id);
      });
  } else {
    db.prepare('UPDATE messages SET delivery_status = ? WHERE id = ?').run('sent', id);
  }

  res.status(201).json({ id, createdAt: now, deliveryStatus: 'pending' });
});

// ─── Context (conversation + messages + suggestions) ───────────────────────
router.get('/:id/context', (req, res) => {
  const conv = stmts.getConversation.get(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Conversation not found' });
  res.json({
    conversation: conv,
    messages: stmts.listMessages.all(req.params.id),
    suggestions: stmts.listSuggestions.all(req.params.id),
    auditLog: stmts.listAuditLog.all(req.params.id),
  });
});

// ─── Takeover ──────────────────────────────────────────────────────────────
router.post('/:id/takeover', (req, res) => {
  const conv = stmts.getConversation.get(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Not found' });
  const { agent_id } = req.body;
  const now = nowIso();
  db.prepare(`UPDATE conversations SET assigned_agent_id = ?, status = 'assigned', updated_at = ? WHERE id = ?`)
    .run(agent_id || 'operator', now, conv.id);
  db.prepare(`INSERT INTO audit_log (id, brand_id, conversation_id, action, actor_user_id, metadata_json, created_at) VALUES (?,?,?,?,?,?,?)`)
    .run(randomId('audit'), conv.brand_id, conv.id, 'support.takeover', agent_id || null, null, now);
  res.json({ ok: true });
});

// ─── Release ───────────────────────────────────────────────────────────────
router.post('/:id/release', (req, res) => {
  const conv = stmts.getConversation.get(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Not found' });
  const now = nowIso();
  db.prepare(`UPDATE conversations SET assigned_agent_id = NULL, status = 'open', updated_at = ? WHERE id = ?`)
    .run(now, conv.id);
  db.prepare(`INSERT INTO audit_log (id, brand_id, conversation_id, action, actor_user_id, metadata_json, created_at) VALUES (?,?,?,?,?,?,?)`)
    .run(randomId('audit'), conv.brand_id, conv.id, 'support.release', null, null, now);
  res.json({ ok: true });
});

// ─── Mark as read ──────────────────────────────────────────────────────────
router.post('/:id/read', (req, res) => {
  const conv = stmts.getConversation.get(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Not found' });
  const now = nowIso();
  db.prepare('UPDATE conversations SET unread_count = 0, updated_at = ? WHERE id = ?')
    .run(now, conv.id);
  res.json({ ok: true });
});

// ─── Tags ───────────────────────────────────────────────────────────────────
router.patch('/:id/tags', (req, res) => {
  const conv = stmts.getConversation.get(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Not found' });

  const { tags } = req.body; // string[]
  if (!Array.isArray(tags)) return res.status(400).json({ error: 'tags must be an array' });

  const now = nowIso();
  const tagsStr = tags.filter(Boolean).join(',') || null;
  db.prepare('UPDATE conversations SET tags = ?, updated_at = ? WHERE id = ?')
    .run(tagsStr, now, conv.id);

  console.log(`${LOG_TAG} Tags updated for conv ${conv.id}: ${tagsStr}`);
  res.json({ ok: true, tags: tags.filter(Boolean) });
});

// ─── Close ─────────────────────────────────────────────────────────────────
router.post('/:id/close', (req, res) => {
  const conv = stmts.getConversation.get(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Not found' });
  const now = nowIso();
  db.prepare(`UPDATE conversations SET status = 'closed', updated_at = ? WHERE id = ?`)
    .run(now, conv.id);
  db.prepare(`INSERT INTO audit_log (id, brand_id, conversation_id, action, actor_user_id, metadata_json, created_at) VALUES (?,?,?,?,?,?,?)`)
    .run(randomId('audit'), conv.brand_id, conv.id, 'support.close', null, null, now);

  // Fire-and-forget: compact the OpenClaw session to summarize & free memory
  compactSession(conv.id, conv.brand_id).catch(err => {
    console.error(`${LOG_TAG} compactSession error (non-blocking):`, err.message);
  });

  res.json({ ok: true });
});

// ─── Priority ──────────────────────────────────────────────────────────────
router.patch('/:id/priority', (req, res) => {
  const conv = stmts.getConversation.get(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Not found' });
  const { priority } = req.body;
  if (!priority) return res.status(400).json({ error: 'priority required' });
  const now = nowIso();
  db.prepare(`UPDATE conversations SET priority = ?, updated_at = ? WHERE id = ?`)
    .run(priority, now, conv.id);
  res.json({ ok: true });
});

// ─── Staff toggle ──────────────────────────────────────────────────────────
router.patch('/:id/staff', (req, res) => {
  const conv = stmts.getConversation.get(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Not found' });
  const { is_staff } = req.body;
  const now = nowIso();
  db.prepare('UPDATE conversations SET is_staff = ?, updated_at = ? WHERE id = ?')
    .run(is_staff ? 1 : 0, now, conv.id);
  console.log(`${LOG_TAG} Staff flag set to ${is_staff ? 1 : 0} for conv ${conv.id}`);
  emitEvent({ type: 'conversation_update', conversationId: conv.id, brandId: conv.brand_id });
  res.json({ ok: true, is_staff: is_staff ? 1 : 0 });
});

// ─── Escalation ────────────────────────────────────────────────────────────
router.post('/:id/escalate', (req, res) => {
  const conv = stmts.getConversation.get(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Not found' });
  const { escalated_to } = req.body;
  const now = nowIso();
  db.prepare('UPDATE conversations SET escalated_at = ?, escalated_to = ?, status = ?, updated_at = ? WHERE id = ?')
    .run(now, escalated_to || 'team', 'escalated', now, conv.id);
  db.prepare(`INSERT INTO audit_log (id, brand_id, conversation_id, action, actor_user_id, metadata_json, created_at) VALUES (?,?,?,?,?,?,?)`)
    .run(randomId('audit'), conv.brand_id, conv.id, 'support.escalate', null, JSON.stringify({ escalated_to: escalated_to || 'team' }), now);
  console.log(`${LOG_TAG} Conv ${conv.id} escalated to ${escalated_to || 'team'}`);
  emitEvent({ type: 'conversation_update', conversationId: conv.id, brandId: conv.brand_id });
  res.json({ ok: true });
});

// ─── Merge conversations ──────────────────────────────────────────────────
router.post('/:id/merge', (req, res) => {
  const { merge_from } = req.body;
  if (!merge_from) return res.status(400).json({ error: 'merge_from required' });

  const target = stmts.getConversation.get(req.params.id);
  const source = stmts.getConversation.get(merge_from);
  if (!target) return res.status(404).json({ error: 'Target conversation not found' });
  if (!source) return res.status(404).json({ error: 'Source conversation not found' });

  const now = nowIso();
  db.transaction(() => {
    // Move messages
    db.prepare('UPDATE messages SET conversation_id = ? WHERE conversation_id = ?')
      .run(target.id, source.id);
    // Move suggestions
    db.prepare('UPDATE suggestions SET conversation_id = ? WHERE conversation_id = ?')
      .run(target.id, source.id);
    // Move audit log
    db.prepare('UPDATE audit_log SET conversation_id = ? WHERE conversation_id = ?')
      .run(target.id, source.id);
    // Merge phone info
    if (source.customer_phone && !target.customer_phone) {
      db.prepare('UPDATE conversations SET customer_phone = ? WHERE id = ?')
        .run(source.customer_phone, target.id);
    }
    if (source.customer_name && !target.customer_name) {
      db.prepare('UPDATE conversations SET customer_name = ? WHERE id = ?')
        .run(source.customer_name, target.id);
    }
    // Merge aliases
    const allAliases = new Set();
    if (target.phone_aliases) target.phone_aliases.split(',').forEach(a => allAliases.add(a));
    if (source.phone_aliases) source.phone_aliases.split(',').forEach(a => allAliases.add(a));
    if (source.customer_phone) allAliases.add(source.customer_phone);
    const mergedAliases = [...allAliases].filter(Boolean).join(',') || null;
    db.prepare('UPDATE conversations SET phone_aliases = ?, updated_at = ? WHERE id = ?')
      .run(mergedAliases, now, target.id);
    // Delete source conversation
    db.prepare('DELETE FROM conversations WHERE id = ?').run(source.id);
    // Audit
    db.prepare(`INSERT INTO audit_log (id, brand_id, conversation_id, action, actor_user_id, metadata_json, created_at) VALUES (?,?,?,?,?,?,?)`)
      .run(randomId('audit'), target.brand_id, target.id, 'support.merge', null, JSON.stringify({ merged_from: source.id }), now);
  })();

  console.log(`${LOG_TAG} Merged conv ${source.id} into ${target.id}`);
  emitEvent({ type: 'conversation_update', conversationId: target.id, brandId: target.brand_id });
  res.json({ ok: true, merged_from: source.id, into: target.id });
});

// ─── Context Preview (actual agent context for debugging) ─────────────────
router.post('/:id/context-preview', (req, res) => {
  const conv = stmts.getConversation.get(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Not found' });

  const messages = stmts.listMessages.all(req.params.id);
  const { userData } = req.body || {};
  const tags = conv.tags ? conv.tags.split(',').filter(Boolean) : [];

  try {
    const preview = buildContextPreview(conv, messages, { userData, tags });

    // Also read the actual session JSONL to show what OpenClaw has in-memory
    const { sessionIdFromConversation, agentForBrand } = require('../lib/copilot');
    const sessionId = sessionIdFromConversation(conv.id);
    const agentId = agentForBrand(conv.brand_id);
    const OPENCLAW_HOME = process.env.OPENCLAW_HOME || '/home/openclaw/.openclaw';
    const sessionPath = require('path').join(OPENCLAW_HOME, 'agents', agentId, 'sessions', `${sessionId}.jsonl`);

    let sessionEntries = [];
    try {
      if (require('fs').existsSync(sessionPath)) {
        const content = require('fs').readFileSync(sessionPath, 'utf8');
        const lines = content.split('\n').filter(l => l.trim());
        sessionEntries = lines.map((line, i) => {
          try {
            const entry = JSON.parse(line);
            // Summarize large content to avoid sending megabytes
            if (entry.message?.content && entry.message.content.length > 500) {
              return {
                ...entry,
                message: {
                  ...entry.message,
                  content: entry.message.content.substring(0, 500) + `... [${entry.message.content.length} chars total]`,
                },
              };
            }
            return entry;
          } catch {
            return { raw: line.substring(0, 200), line: i };
          }
        });
      }
    } catch (err) {
      console.warn(`${LOG_TAG} Could not read session JSONL:`, err.message);
    }

    // Include session context DB state
    const sessionCtx = stmts.getSessionContext.get(conv.id);

    res.json({
      ...preview,
      sessionJSONL: {
        path: sessionPath,
        entryCount: sessionEntries.length,
        entries: sessionEntries,
      },
      sessionDB: sessionCtx || null,
    });
  } catch (err) {
    console.error(`${LOG_TAG} Context preview failed:`, err.message);
    res.status(500).json({ error: 'Failed to build context preview' });
  }
});

// ─── Session Info (compaction summary + state) ────────────────────────────
router.get('/:id/session-info', (req, res) => {
  const conv = stmts.getConversation.get(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Not found' });

  const sessionCtx = stmts.getSessionContext.get(req.params.id);
  const { sessionIdFromConversation, agentForBrand } = require('../lib/copilot');
  const sessionId = sessionIdFromConversation(conv.id);
  const agentId = agentForBrand(conv.brand_id);

  // Check if session JSONL file exists
  const OPENCLAW_HOME = process.env.OPENCLAW_HOME || '/home/openclaw/.openclaw';
  const sessionPath = require('path').join(OPENCLAW_HOME, 'agents', agentId, 'sessions', `${sessionId}.jsonl`);
  let sessionFileExists = false;
  let sessionLineCount = 0;
  try {
    if (require('fs').existsSync(sessionPath)) {
      sessionFileExists = true;
      sessionLineCount = require('fs').readFileSync(sessionPath, 'utf8').split('\n').filter(l => l.trim()).length;
    }
  } catch { /* ignore */ }

  res.json({
    sessionId,
    agentId,
    sessionFileExists,
    sessionLineCount,
    compactedAt: sessionCtx?.compacted_at || null,
    compactionSummary: sessionCtx?.compaction_summary || null,
    lastMsgIndex: sessionCtx?.last_msg_index || 0,
    contextHash: sessionCtx?.context_hash || null,
    lastSentAt: sessionCtx?.last_sent_at || null,
    fullContextSent: !!sessionCtx?.full_context_sent,
  });
});

// ─── Copilot Suggest ───────────────────────────────────────────────────────
router.post('/:id/suggest', async (req, res) => {
  const conv = stmts.getConversation.get(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Not found' });

  // Skip copilot for staff conversations
  if (conv.is_staff) {
    return res.json({ skipped: true, reason: 'staff_conversation' });
  }

  const messages = stmts.listMessages.all(req.params.id);
  if (messages.length === 0) {
    return res.status(400).json({ error: 'No messages to generate suggestion from' });
  }

  const { userData } = req.body || {};
  const tags = conv.tags ? conv.tags.split(',').filter(Boolean) : [];

  try {
    const result = await generateSuggestion(conv, messages, { userData, tags });

    // If copilot says no suggestion is needed (operator sent last msg, waiting for client)
    if (result.waiting) {
      console.log(`${LOG_TAG} No suggestion needed for conv ${conv.id} — waiting for client`);
      return res.status(200).json({
        id: null,
        suggestion: null,
        model: 'waiting',
        waiting: true,
        message: 'Aguardando resposta do cliente',
      });
    }

    const now = nowIso();
    const id = randomId('sug');

    db.prepare(`
      INSERT INTO suggestions (id, conversation_id, brand_id, status, suggestion_text, model_name, created_at, updated_at, decided_by, decided_at)
      VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, NULL, NULL)
    `).run(id, conv.id, conv.brand_id, result.text, result.model, now, now);

    db.prepare(`INSERT INTO audit_log (id, brand_id, conversation_id, action, actor_user_id, metadata_json, created_at) VALUES (?,?,?,?,?,?,?)`)
      .run(randomId('audit'), conv.brand_id, conv.id, 'copilot.suggest', null, JSON.stringify({ model: result.model }), now);

    console.log(`${LOG_TAG} Copilot suggestion for conv ${conv.id} (model: ${result.model})`);

    res.status(201).json({
      id,
      suggestion: result.text,
      model: result.model,
      createdAt: now,
    });
  } catch (err) {
    console.error(`${LOG_TAG} Copilot suggestion failed:`, err.message);
    res.status(500).json({ error: 'Failed to generate suggestion' });
  }
});

// ─── Suggestions ───────────────────────────────────────────────────────────
router.get('/:id/suggestions', (req, res) => {
  const conv = stmts.getConversation.get(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Not found' });
  res.json({ suggestions: stmts.listSuggestions.all(req.params.id) });
});

router.post('/:id/suggestions', (req, res) => {
  const conv = stmts.getConversation.get(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Not found' });
  const { suggestion_text, model_name } = req.body;
  if (!suggestion_text) return res.status(400).json({ error: 'suggestion_text required' });
  const now = nowIso();
  const id = randomId('sug');
  db.prepare(`
    INSERT INTO suggestions (id, conversation_id, brand_id, status, suggestion_text, model_name, created_at, updated_at, decided_by, decided_at)
    VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, NULL, NULL)
  `).run(id, conv.id, conv.brand_id, suggestion_text, model_name || null, now, now);
  res.status(201).json({ id, createdAt: now });
});

router.patch('/:id/suggestions/:sid', (req, res) => {
  const sug = stmts.getSuggestion.get(req.params.sid);
  if (!sug) return res.status(404).json({ error: 'Suggestion not found' });
  const { status, decided_by, edited_text } = req.body;
  if (!['accepted', 'edited', 'rejected', 'dismissed'].includes(status)) {
    return res.status(400).json({ error: 'status must be accepted|edited|rejected|dismissed' });
  }
  const now = nowIso();
  if (status === 'edited' && edited_text) {
    db.prepare(`UPDATE suggestions SET status = ?, edited_text = ?, decided_by = ?, decided_at = ?, updated_at = ? WHERE id = ?`)
      .run(status, edited_text, decided_by || null, now, now, sug.id);

    // Extract a learned rule from the edit (async — non-blocking)
    const conv = db.prepare('SELECT brand_id FROM conversations WHERE id = ?').get(sug.conversation_id);
    if (conv) {
      extractLearnedRule(conv.brand_id, sug.id, sug.suggestion_text, edited_text, sug.conversation_id)
        .catch(err => console.warn(`${LOG_TAG} Rule extraction fire-and-forget error:`, err.message));
    }
  } else {
    db.prepare(`UPDATE suggestions SET status = ?, decided_by = ?, decided_at = ?, updated_at = ? WHERE id = ?`)
      .run(status, decided_by || null, now, now, sug.id);
  }

  // When rejected/dismissed, remove the suggestion from the agent session
  // so it doesn't pollute future context
  if (status === 'rejected' || status === 'dismissed') {
    const conv = db.prepare('SELECT brand_id FROM conversations WHERE id = ?').get(sug.conversation_id);
    if (conv) {
      removeSuggestionFromSession(sug.conversation_id, conv.brand_id)
        .catch(err => console.warn(`${LOG_TAG} Session cleanup on reject (non-blocking):`, err.message));
    }
  }

  res.json({ ok: true });
});

// ─── Process media on demand ───────────────────────────────────────────────
router.post('/:id/messages/:msgId/process-media', (req, res) => {
  const msg = db.prepare('SELECT * FROM messages WHERE id = ? AND conversation_id = ?')
    .get(req.params.msgId, req.params.id);
  if (!msg) return res.status(404).json({ error: 'Message not found' });

  // Check if message has media
  if (!msg.media_json) return res.status(400).json({ error: 'No media on this message' });

  let media;
  try { media = JSON.parse(msg.media_json); } catch { return res.status(400).json({ error: 'Invalid media_json' }); }

  // Check if already processed
  const body = msg.body || '';
  if (body.includes('[Transcrição do áudio]') || body.includes('[Descrição da imagem]') || body.includes('[Descrição do vídeo]')) {
    return res.json({ ok: true, already_processed: true, body });
  }

  // Process in background
  const path = require('path');
  const MEDIA_DIR = path.join(__dirname, '..', '..', '..', 'db', 'media');
  const { processMedia } = require('../lib/media-processor');
  const mediaFilePath = path.join(MEDIA_DIR, path.basename(media.url || ''));

  res.json({ ok: true, processing: true });

  processMedia(mediaFilePath, media.media_type).then(description => {
    if (description) {
      const enrichedBody = `${body} ${description}`;
      db.prepare('UPDATE messages SET body = ? WHERE id = ?').run(enrichedBody, msg.id);
      console.log(`${LOG_TAG} Media processed on demand: msg ${msg.id} → ${description.substring(0, 80)}...`);
      emitEvent({ type: 'message_update', conversationId: req.params.id, messageId: msg.id, brandId: msg.brand_id });
    }
  }).catch(err => {
    console.warn(`${LOG_TAG} On-demand media processing failed for msg ${msg.id}:`, err.message);
  });
});

// ─── Reset session context ────────────────────────────────────────────────────
router.delete('/:id/session', async (req, res) => {
  const conv = db.prepare('SELECT id, brand_id FROM conversations WHERE id = ?').get(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Conversation not found' });

  try {
    await resetAgentSession(conv.id, conv.brand_id);
    console.log(`${LOG_TAG} Agent session reset for conversation: ${conv.id}`);
    res.json({ ok: true, message: 'Agent session reset with /new. Next suggestion will do a full context send.' });
  } catch (err) {
    console.error(`${LOG_TAG} Failed to reset session:`, err.message);
    res.status(500).json({ error: 'Failed to reset session' });
  }
});

// ─── Nuke all data (pre-production deploy) ────────────────────────────────────
// Wipes all conversations, messages, suggestions, audit logs, sessions, and
// agent JSONL files. Use before switching WhatsApp accounts or going to prod.
router.post('/nuke', async (req, res) => {
  const confirm = req.body?.confirm;
  const brandId = req.body?.brand_id || req.query.brand_id;

  if (confirm !== 'NUKE') {
    return res.status(400).json({ error: 'Send { "confirm": "NUKE", "brand_id": "..." } to wipe all data.' });
  }
  if (!brandId) {
    return res.status(400).json({ error: 'brand_id required (to determine agent sessions to clean)' });
  }

  console.log(`${LOG_TAG} ⚠️ NUKE initiated for brand ${brandId}`);

  const MEDIA_DIR = path.join(__dirname, '..', '..', '..', 'db', 'media');
  const counts = {};

  // 1. Wipe DB tables
  try {
    counts.messages = db.prepare('DELETE FROM messages').run().changes;
    counts.suggestions = db.prepare('DELETE FROM suggestions').run().changes;
    counts.audit_log = db.prepare('DELETE FROM audit_log').run().changes;
    counts.session_context = db.prepare('DELETE FROM session_context').run().changes;
    counts.conversations = db.prepare('DELETE FROM conversations').run().changes;
    try { counts.learned_rules = db.prepare('DELETE FROM copilot_learned_rules').run().changes; } catch { counts.learned_rules = 0; }
    console.log(`${LOG_TAG} DB wiped:`, counts);
  } catch (err) {
    console.error(`${LOG_TAG} DB wipe failed:`, err.message);
    return res.status(500).json({ error: 'DB wipe failed', details: err.message });
  }

  // 2. Wipe agent session JSONL files
  const { agentForBrand } = require('../lib/copilot');
  const agentId = agentForBrand(brandId);
  const OPENCLAW_HOME = process.env.OPENCLAW_HOME || '/home/openclaw/.openclaw';
  const sessionsDir = path.join(OPENCLAW_HOME, 'agents', agentId, 'sessions');

  let sessionFilesDeleted = 0;
  try {
    if (fs.existsSync(sessionsDir)) {
      const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.jsonl'));
      for (const file of files) {
        try {
          fs.unlinkSync(path.join(sessionsDir, file));
          sessionFilesDeleted++;
        } catch (err) {
          console.warn(`${LOG_TAG} Could not delete ${file}:`, err.message);
        }
      }
    }
    counts.session_files = sessionFilesDeleted;
    console.log(`${LOG_TAG} Session files deleted: ${sessionFilesDeleted} from ${sessionsDir}`);
  } catch (err) {
    console.warn(`${LOG_TAG} Session files cleanup error:`, err.message);
    counts.session_files = 0;
  }

  // 3. Wipe saved media files
  let mediaFilesDeleted = 0;
  try {
    if (fs.existsSync(MEDIA_DIR)) {
      const mediaFiles = fs.readdirSync(MEDIA_DIR);
      for (const file of mediaFiles) {
        try {
          fs.unlinkSync(path.join(MEDIA_DIR, file));
          mediaFilesDeleted++;
        } catch {}
      }
    }
    counts.media_files = mediaFilesDeleted;
    console.log(`${LOG_TAG} Media files deleted: ${mediaFilesDeleted}`);
  } catch (err) {
    counts.media_files = 0;
  }

  console.log(`${LOG_TAG} ✅ NUKE complete:`, counts);
  res.json({ ok: true, nuked: counts });
});

module.exports = router;
