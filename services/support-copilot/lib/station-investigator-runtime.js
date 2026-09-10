const { db, nowIso, randomId } = require('./db');
const { loadConfig } = require('./agent-router');
const { buildConversationIncidentContext } = require('./conversation-incident-context');
const { findAllowedStructuredMention } = require('./whatsapp-message-context');
const { sendText } = require('./evolution-client');

const PROCESSING_LEASE_MS = 120_000;

function baseUrl() { return String(process.env.AGENT_EVENT_BASE_URL || '').replace(/\/$/, ''); }
function secret() { return process.env.AGENT_EVENT_SECRET || ''; }

function dailyLimitReached(brandId, limit, excludeMessageId = '') {
  if (limit <= 0) return true;
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const row = db.prepare(`SELECT COUNT(*) count FROM station_investigation_jobs
    WHERE brand_id = ? AND updated_at >= ? AND status <> 'claimed' AND message_id <> ?`)
    .get(brandId, since, excludeMessageId);
  return Number(row?.count || 0) >= limit;
}

function persistStationOwnership(input) {
  const now = nowIso();
  db.prepare(`INSERT OR IGNORE INTO station_investigation_jobs
    (message_id, conversation_id, brand_id, group_jid, instance, status, attempts, next_attempt_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'claimed', 0, ?, ?, ?)`)
    .run(input.messageId, input.conversationId, input.brandId, input.groupJid, input.instance, now, now, now);
}

function reserveDailySlot(messageId, brandId, limit) {
  return db.transaction(() => {
    const current = db.prepare('SELECT status FROM station_investigation_jobs WHERE message_id = ?').get(messageId);
    if (current?.status !== 'claimed') {
      return { acquired: false, status: current?.status || 'unknown', limitReached: false };
    }
    if (dailyLimitReached(brandId, limit, messageId)) {
      return { acquired: false, status: 'claimed', limitReached: true };
    }
    const acquired = db.prepare("UPDATE station_investigation_jobs SET status='reserved', updated_at=? WHERE message_id=? AND status='claimed'")
      .run(nowIso(), messageId);
    return { acquired: acquired.changes === 1, status: acquired.changes === 1 ? 'reserved' : 'unknown', limitReached: false };
  })();
}

function releaseDailySlot(messageId) {
  db.prepare("UPDATE station_investigation_jobs SET status='claimed', updated_at=? WHERE message_id=? AND status='reserved'")
    .run(nowIso(), messageId);
}

function leaseExpired(job, now = Date.now()) {
  const updatedAt = Date.parse(job?.updated_at || '');
  return Number.isFinite(updatedAt) && updatedAt <= now - PROCESSING_LEASE_MS;
}

function isDefinitiveDeliveryRejection(error) {
  const statusCode = Number(error?.statusCode);
  return Number.isInteger(statusCode) && statusCode >= 400 && statusCode <= 599;
}

async function prepareStationInvestigation(input, deps = {}) {
  const prior = db.prepare('SELECT * FROM station_investigation_jobs WHERE message_id = ?').get(input.messageId);
  const resumableInFlight = ['reserved', 'processing'].includes(prior?.status) && leaseExpired(prior);
  if (['sent', 'review', 'sending', 'delivery_unknown'].includes(prior?.status)
      || (['reserved', 'processing'].includes(prior?.status) && !resumableInFlight)) {
    return { claimed: true, ready: false, result: { duplicate: true, status: prior.status } };
  }

  // Persisted jobs keep ownership across provider replays even when the
  // current config is temporarily unavailable or has since been tightened.
  // Otherwise the same attachment can fall through to the generic router.
  const claimedByPriorJob = Boolean(prior);
  const config = await (deps.loadConfig || loadConfig)(input.brandId).catch(() => null);
  const policy = config?.stationInvestigator;
  if (!config?.enabled || !config?.agents?.stationSupport || !policy?.enabled) {
    return { claimed: claimedByPriorJob, ready: false, result: { skipped: true, reason: 'disabled' } };
  }
  if (!policy.allowedConversationIds?.includes(input.conversationId)) {
    return { claimed: claimedByPriorJob, ready: false, result: { skipped: true, reason: 'conversation_not_allowed' } };
  }
  const mentionedJid = findAllowedStructuredMention(input.whatsappContext, policy.mentionJids || []);
  if (!mentionedJid) {
    return { claimed: claimedByPriorJob, ready: false, result: { skipped: true, reason: 'structured_mention_required' } };
  }

  // Once an explicitly allowlisted bot mention is present in an allowlisted
  // group, this workflow owns the message. Any later failure must stay silent
  // and fail closed instead of falling through to a second, generic responder.
  const claimed = true;
  if (!prior) persistStationOwnership(input);
  if (policy.killSwitch) return { claimed, ready: false, result: { skipped: true, reason: 'send_disabled' } };
  if (!baseUrl() || !secret()) return { claimed, ready: false, result: { skipped: true, reason: 'central_unavailable' } };
  let reservedDailySlot = false;
  if (!prior || prior.status === 'claimed') {
    const reservation = reserveDailySlot(input.messageId, input.brandId, Number(policy.dailyLimit ?? 20));
    if (!reservation.acquired) {
      if (!reservation.limitReached) {
        return { claimed, ready: false, result: { duplicate: true, status: reservation.status } };
      }
      return { claimed, ready: false, result: { skipped: true, reason: 'daily_limit' } };
    }
    reservedDailySlot = true;
  }
  let context;
  try {
    context = (deps.buildContext || buildConversationIncidentContext)(input.conversationId, input.messageId, { contextHours: policy.contextHours, maxMessages: policy.maxContextMessages });
  } catch {
    if (reservedDailySlot) releaseDailySlot(input.messageId);
    return { claimed, ready: false, result: { skipped: true, reason: 'context_failed' } };
  }
  if (context.contextConfidence === 'low') {
    if (reservedDailySlot) releaseDailySlot(input.messageId);
    return { claimed, ready: false, result: { skipped: true, reason: 'low_context_confidence' } };
  }
  return { claimed, ready: true, policy, mentionedJid, context };
}

async function routeStationInvestigation(input, deps = {}) {
  const preparation = deps.prepared || await prepareStationInvestigation(input, deps);
  if (!preparation.ready) return preparation.result;
  const { policy, mentionedJid, context } = preparation;
  const now = nowIso();
  const staleBefore = new Date(Date.now() - PROCESSING_LEASE_MS).toISOString();
  const acquired = db.prepare(`UPDATE station_investigation_jobs
    SET status='processing', attempts=attempts+1, context_fingerprint=?, context_message_ids_json=?, updated_at=?
    WHERE message_id=? AND (
      status IN ('reserved', 'retry')
      OR (status='processing' AND updated_at <= ?)
    )`)
    .run(context.contextFingerprint, JSON.stringify(context.messageRefs.map(x => x.id)), now, input.messageId, staleBefore);
  if (acquired.changes !== 1) {
    const current = db.prepare('SELECT status FROM station_investigation_jobs WHERE message_id = ?').get(input.messageId);
    return { duplicate: true, status: current?.status || 'unknown' };
  }
  let sendStarted = false;
  try {
    const response = await (deps.request || fetch)(`${baseUrl()}/api/agents/station-investigations`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret()}` },
      body: JSON.stringify({ brandId: input.brandId, conversationId: input.conversationId, groupJid: input.groupJid, mentionedJid, sourceMessageId: input.messageId, receivedAt: input.receivedAt, context }),
      signal: AbortSignal.timeout(45_000),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`investigator_http_${response.status}`);
    if (!policy.autoSend || result.decision !== 'send' || !result.reply) {
      db.prepare("UPDATE station_investigation_jobs SET status='review', decision=?, confidence=?, station_ids_json=?, result_json=?, updated_at=? WHERE message_id=?")
        .run(result.decision || 'review', result.confidence || null, JSON.stringify(result.stationIds || []), JSON.stringify(result), nowIso(), input.messageId);
      return { status: 'review', result };
    }
    const sending = db.prepare(`UPDATE station_investigation_jobs
      SET status='sending', decision='send', confidence=?, station_ids_json=?, result_json=?, updated_at=?
      WHERE message_id=? AND status='processing'`)
      .run(result.confidence || null, JSON.stringify(result.stationIds || []), JSON.stringify(result), nowIso(), input.messageId);
    if (sending.changes !== 1) {
      const current = db.prepare('SELECT status FROM station_investigation_jobs WHERE message_id = ?').get(input.messageId);
      return { duplicate: true, status: current?.status || 'unknown' };
    }
    sendStarted = true;
    const sent = await (deps.sendText || sendText)(input.instance, input.groupJid, result.reply);
    const externalId = sent?.key?.id || null;
    if (!externalId) throw new Error('station_delivery_id_missing');
    const sentAt = nowIso();
    db.transaction(() => {
      db.prepare(`INSERT INTO messages (id, conversation_id, brand_id, direction, source, body, external_message_id, delivery_status, created_at)
        VALUES (?, ?, ?, 'outbound', 'station-investigator', ?, ?, 'sent', ?)`)
        .run(randomId('msg'), input.conversationId, input.brandId, result.reply, externalId, sentAt);
      db.prepare("UPDATE station_investigation_jobs SET status='sent', decision='send', confidence=?, station_ids_json=?, result_json=?, response_sent_at=?, response_external_message_id=?, updated_at=? WHERE message_id=?")
        .run(result.confidence || null, JSON.stringify(result.stationIds || []), JSON.stringify(result), sentAt, externalId, sentAt, input.messageId);
    })();
    return { status: 'sent', result };
  } catch (error) {
    if (sendStarted && !isDefinitiveDeliveryRejection(error)) {
      db.prepare("UPDATE station_investigation_jobs SET status='delivery_unknown', last_error=?, updated_at=? WHERE message_id=? AND status='sending'")
        .run(String(error?.message || error).slice(0, 500), nowIso(), input.messageId);
      return { status: 'delivery_unknown', error: String(error?.message || error) };
    }
    const next = new Date(Date.now() + 60_000).toISOString();
    db.prepare("UPDATE station_investigation_jobs SET status='retry', next_attempt_at=?, last_error=?, updated_at=? WHERE message_id=?")
      .run(next, String(error?.message || error).slice(0, 500), nowIso(), input.messageId);
    return { status: 'retry', error: String(error?.message || error) };
  }
}

module.exports = { prepareStationInvestigation, routeStationInvestigation, dailyLimitReached };
