/**
 * Group → partner link routes — /api/support/groups
 *
 * Stores the links between a WhatsApp group conversation and one or MORE
 * Turbo Station partners (e.g. a group shared by two partners), plus the
 * per-link tool allow-list. Also exposes the captured group participants
 * (phone + name) so the dashboard can resolve a partner from a participant's
 * phone (via the Next.js /api/support/groups/resolve-partner).
 *
 * All routes are mounted behind requireSecret (dashboard → support service).
 * @module routes/groups
 */
const { Router } = require('express');
const { db, nowIso } = require('../lib/db');

const router = Router();
const LOG_TAG = '[support-copilot]';

/** Resolve a conversation id → its group conversation row (or null). */
function groupConv(convId, req) {
  const c = db
    .prepare('SELECT id, customer_phone, brand_id, channel FROM conversations WHERE id = ?')
    .get(convId);
  if (!c || c.channel !== 'whatsapp-group') return null;
  // Tenant guard: the dashboard proxy forwards x-brand-id. Reject cross-brand
  // access as 404 (no existence leak) so a brand admin cannot read or mutate
  // another brand's group link/participants.
  const reqBrand = req && req.headers ? (req.headers['x-brand-id'] || '') : '';
  if (reqBrand && c.brand_id && c.brand_id !== reqBrand) return null;
  return c;
}

function formatLink(r) {
  if (!r) return null;
  let tools = [];
  try { tools = JSON.parse(r.allowed_tools || '[]'); } catch {}
  return {
    groupJid: r.group_jid,
    conversationId: r.conversation_id,
    brandId: r.brand_id,
    partnerId: r.partner_id,
    partnerUserId: r.partner_user_id,
    partnerName: r.partner_name,
    allowedTools: tools,
    enabled: !!r.enabled,
    linkedBy: r.linked_by,
    linkedAt: r.linked_at,
    updatedAt: r.updated_at,
  };
}

function listLinks(groupJid) {
  return db
    .prepare('SELECT * FROM group_partner_links WHERE group_jid = ? ORDER BY linked_at ASC')
    .all(groupJid)
    .map(formatLink);
}

// GET the group a partner is linked to (used by the Next.js whatsapp-notifier
// to deliver the weekly partner report). Registered BEFORE /:convId routes so
// "by-partner" is not swallowed by the convId param.
router.get('/by-partner', (req, res) => {
  const { partnerId, brandId } = req.query || {};
  if (!partnerId) return res.status(400).json({ error: 'partnerId is required' });
  const row = brandId
    ? db.prepare('SELECT conversation_id, enabled FROM group_partner_links WHERE partner_id = ? AND brand_id = ? ORDER BY updated_at DESC LIMIT 1').get(partnerId, brandId)
    : db.prepare('SELECT conversation_id, enabled FROM group_partner_links WHERE partner_id = ? ORDER BY updated_at DESC LIMIT 1').get(partnerId);
  if (!row) return res.status(404).json({ error: 'no linked group for partner' });
  res.json({ conversationId: row.conversation_id, enabled: !!row.enabled });
});

// GET participants captured for a group
router.get('/:convId/participants', (req, res) => {
  const conv = groupConv(req.params.convId, req);
  if (!conv) return res.status(404).json({ error: 'group conversation not found' });
  const rows = db
    .prepare('SELECT phone, name, msg_count, last_seen_at FROM group_participants WHERE group_jid = ? ORDER BY last_seen_at DESC')
    .all(conv.customer_phone);
  res.json({ conversationId: conv.id, groupJid: conv.customer_phone, participants: rows });
});

// GET the partner links for a group. `links` is the canonical shape; `link`
// (first link or null) is kept for backward compatibility with older clients.
router.get('/:convId/link', (req, res) => {
  const conv = groupConv(req.params.convId, req);
  if (!conv) return res.status(404).json({ error: 'group conversation not found' });
  const links = listLinks(conv.customer_phone);
  res.json({ conversationId: conv.id, groupJid: conv.customer_phone, links, link: links[0] || null });
});

// PUT (upsert) ONE partner link for a group — adds/updates that partner
// without touching the group's other linked partners.
router.put('/:convId/link', (req, res) => {
  const conv = groupConv(req.params.convId, req);
  if (!conv) return res.status(404).json({ error: 'group conversation not found' });
  const { partnerId, partnerUserId, partnerName, allowedTools, brandId, linkedBy } = req.body || {};
  if (!partnerId) {
    return res.status(400).json({ error: 'partnerId is required' });
  }
  const now = nowIso();
  const tools = JSON.stringify(Array.isArray(allowedTools) ? allowedTools : []);
  db.prepare(`
    INSERT INTO group_partner_links
      (group_jid, conversation_id, brand_id, partner_id, partner_user_id, partner_name, allowed_tools, enabled, linked_by, linked_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
    ON CONFLICT(group_jid, partner_id) DO UPDATE SET
      conversation_id = excluded.conversation_id,
      brand_id        = excluded.brand_id,
      partner_user_id = excluded.partner_user_id,
      partner_name    = excluded.partner_name,
      allowed_tools   = excluded.allowed_tools,
      enabled         = 1,
      linked_by       = excluded.linked_by,
      updated_at      = excluded.updated_at
  `).run(
    conv.customer_phone, conv.id, brandId || conv.brand_id,
    partnerId, partnerUserId || '', partnerName || partnerId, tools,
    linkedBy || null, now, now,
  );
  const links = listLinks(conv.customer_phone);
  console.log(`${LOG_TAG} Group ${conv.customer_phone} linked to partner ${partnerId} by ${linkedBy || '?'} (${links.length} link(s))`);
  res.json({ ok: true, links, link: links[0] || null });
});

// DELETE (unlink) — with ?partnerId= removes only that partner's link;
// without it, removes ALL links for the group (legacy "unlink everything").
router.delete('/:convId/link', (req, res) => {
  const conv = groupConv(req.params.convId, req);
  if (!conv) return res.status(404).json({ error: 'group conversation not found' });
  const partnerId = (req.query && req.query.partnerId) || (req.body && req.body.partnerId) || null;
  const r = partnerId
    ? db.prepare('DELETE FROM group_partner_links WHERE group_jid = ? AND partner_id = ?').run(conv.customer_phone, partnerId)
    : db.prepare('DELETE FROM group_partner_links WHERE group_jid = ?').run(conv.customer_phone);
  console.log(`${LOG_TAG} Group ${conv.customer_phone} unlinked ${partnerId || 'ALL'} (${r.changes} row)`);
  res.json({ ok: true, removed: r.changes, links: listLinks(conv.customer_phone) });
});

module.exports = router;
