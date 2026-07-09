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
const path = require('path');
const { db, nowIso } = require('../lib/db');
const { extractReceipt, MEDIA_DIR } = require('../lib/receipt-extractor');

const router = Router();
const LOG_TAG = '[support-copilot]';

// GET /receipts tuning. The Next.js client (partner-receipts.ts) aborts at 30s,
// so a single request extracts at most RECEIPTS_MAX_EXTRACTIONS new files inside
// a hard time budget; anything left over is picked up by the next call (the
// confirm cron runs daily and the dashboard button can be clicked again).
const RECEIPTS_DEFAULT_SINCE_HOURS = 24 * 7;
const RECEIPTS_MAX_SINCE_HOURS = 24 * 30;
const RECEIPTS_MAX_CANDIDATES = 60;
const RECEIPTS_MAX_EXTRACTIONS = 12;
const RECEIPTS_TIME_BUDGET_MS = 20_000;
const RECEIPTS_MAX_ERROR_ATTEMPTS = 3;

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

// GET recent PIX receipts posted in the partner's linked group(s). Consumed by
// the Next.js confirm-partner-payments cron / dashboard button via
// next/lib/services/partner-receipts.ts. Vision extraction runs HERE (the file
// and any payer/payee names never leave this box — LGPD); the response carries
// ONLY { amountCents, receiptRef, sourceMessageId, at }. Registered BEFORE the
// /:convId routes so "receipts" is not swallowed by the convId param.
router.get('/receipts', async (req, res) => {
  try {
    const { partnerId, brandId } = req.query || {};
    if (!partnerId) return res.status(400).json({ error: 'partnerId is required' });
    let sinceHours = parseInt(req.query.sinceHours, 10);
    if (!Number.isFinite(sinceHours) || sinceHours <= 0) sinceHours = RECEIPTS_DEFAULT_SINCE_HOURS;
    sinceHours = Math.min(sinceHours, RECEIPTS_MAX_SINCE_HOURS);

    let links = brandId
      ? db.prepare('SELECT * FROM group_partner_links WHERE partner_id = ? AND brand_id = ? AND enabled = 1 ORDER BY updated_at DESC').all(partnerId, brandId)
      : db.prepare('SELECT * FROM group_partner_links WHERE partner_id = ? AND enabled = 1 ORDER BY updated_at DESC').all(partnerId);
    // Tenant guard (same convention as groupConv): the dashboard proxy forwards
    // x-brand-id; cross-brand access reads as 404 (no existence leak).
    const reqBrand = req.headers['x-brand-id'] || '';
    if (reqBrand) links = links.filter((l) => !l.brand_id || l.brand_id === reqBrand);
    if (!links.length) return res.status(404).json({ error: 'no linked group for partner' });

    const sinceIso = new Date(Date.now() - sinceHours * 3600 * 1000).toISOString();
    const convIds = [...new Set(links.map((l) => l.conversation_id).filter(Boolean))];

    // Inbound only: partners/operators post the comprovante from their own
    // numbers; our outbound PDFs (closing reports) are not receipts.
    const candidates = [];
    for (const convId of convIds) {
      const rows = db.prepare(
        `SELECT id, conversation_id, external_message_id, media_json, created_at FROM messages
         WHERE conversation_id = ? AND direction = 'inbound' AND media_json IS NOT NULL
           AND datetime(created_at) > datetime(?)
         ORDER BY datetime(created_at) DESC LIMIT ?`
      ).all(convId, sinceIso, RECEIPTS_MAX_CANDIDATES);
      for (const row of rows) {
        let media = null;
        try { media = JSON.parse(row.media_json); } catch { continue; }
        if (!media || typeof media.url !== 'string') continue;
        if (media.media_type !== 'image' && media.media_type !== 'document') continue;
        candidates.push({ row, media });
      }
    }

    const getCached = db.prepare('SELECT * FROM receipt_extractions WHERE message_id = ?');
    const upsertCache = db.prepare(`
      INSERT INTO receipt_extractions
        (message_id, conversation_id, status, amount_cents, receipt_ref, model, attempts, extracted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(message_id) DO UPDATE SET
        status = excluded.status,
        amount_cents = excluded.amount_cents,
        receipt_ref = excluded.receipt_ref,
        model = excluded.model,
        attempts = excluded.attempts,
        extracted_at = excluded.extracted_at
    `);

    const started = Date.now();
    let extractedNow = 0;
    let pendingExtraction = 0;
    const receipts = [];
    for (const { row, media } of candidates) {
      let cached = getCached.get(row.id);
      const retriable = cached && cached.status === 'error' && cached.attempts < RECEIPTS_MAX_ERROR_ATTEMPTS;
      if (!cached || retriable) {
        if (extractedNow >= RECEIPTS_MAX_EXTRACTIONS || Date.now() - started > RECEIPTS_TIME_BUDGET_MS) {
          pendingExtraction++;
          continue;
        }
        // basename() so a hostile media_json url can't traverse out of MEDIA_DIR.
        const filePath = path.join(MEDIA_DIR, path.basename(media.url));
        const result = await extractReceipt(filePath, media.media_type, media.mimetype || '');
        extractedNow++;
        if (result.environmental) {
          // Missing key / key over limit / rate limit — an environment problem,
          // not a per-file failure. Don't burn the file's retry attempts on it,
          // so receipts posted during an outage are still picked up afterwards.
          pendingExtraction++;
          continue;
        }
        upsertCache.run(
          row.id, row.conversation_id, result.status,
          result.amountCents ?? null, result.receiptRef ?? null, result.model ?? null,
          (cached ? cached.attempts : 0) + 1, nowIso(),
        );
        cached = getCached.get(row.id);
      }
      if (cached && cached.status === 'ok' && Number.isFinite(cached.amount_cents)) {
        receipts.push({
          amountCents: cached.amount_cents,
          receiptRef: cached.receipt_ref || undefined,
          // The WhatsApp message id when we have it (stable across reingest);
          // this is the confirm idempotency anchor on the Next.js side.
          sourceMessageId: row.external_message_id || row.id,
          at: row.created_at,
        });
      }
    }

    console.log(
      `${LOG_TAG} receipts partner=${partnerId} groups=${convIds.length} scanned=${candidates.length} ` +
      `receipts=${receipts.length} extractedNow=${extractedNow} pending=${pendingExtraction}`,
    );
    res.json({ receipts, scanned: candidates.length, extractedNow, pendingExtraction });
  } catch (err) {
    console.error(`${LOG_TAG} receipts endpoint failed:`, err.message);
    res.status(500).json({ error: 'receipts lookup failed' });
  }
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
