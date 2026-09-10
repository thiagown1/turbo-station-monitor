const { db, nowIso, randomId } = require('./db');
const { loadConfig } = require('./agent-router');
const { buildConversationIncidentContext } = require('./conversation-incident-context');
const { findAllowedStructuredMention } = require('./whatsapp-message-context');
const { sendText } = require('./evolution-client');

function baseUrl() { return String(process.env.AGENT_EVENT_BASE_URL || '').replace(/\/$/, ''); }
function secret() { return process.env.AGENT_EVENT_SECRET || ''; }

function dailyLimitReached(brandId, limit) {
  if (limit <= 0) return true;
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const row = db.prepare('SELECT COUNT(*) count FROM station_investigation_jobs WHERE brand_id = ? AND created_at >= ?').get(brandId, since);
  return Number(row?.count || 0) >= limit;
}

async function prepareStationInvestigation(input, deps = {}) {
  const config = await (deps.loadConfig || loadConfig)(input.brandId).catch(() => null);
  const policy = config?.stationInvestigator;
  if (!config?.enabled || !config?.agents?.stationSupport || !policy?.enabled) {
    return { claimed: false, ready: false, result: { skipped: true, reason: 'disabled' } };
  }
  if (!policy.allowedConversationIds?.includes(input.conversationId)) {
    return { claimed: false, ready: false, result: { skipped: true, reason: 'conversation_not_allowed' } };
  }
  const mentionedJid = findAllowedStructuredMention(input.whatsappContext, policy.mentionJids || []);
  if (!mentionedJid) {
    return { claimed: false, ready: false, result: { skipped: true, reason: 'structured_mention_required' } };
  }

  // Once an explicitly allowlisted bot mention is present in an allowlisted
  // group, this workflow owns the message. Any later failure must stay silent
  // and fail closed instead of falling through to a second, generic responder.
  const claimed = true;
  if (policy.killSwitch) return { claimed, ready: false, result: { skipped: true, reason: 'send_disabled' } };
  if (!baseUrl() || !secret()) return { claimed, ready: false, result: { skipped: true, reason: 'central_unavailable' } };
  const prior = db.prepare('SELECT * FROM station_investigation_jobs WHERE message_id = ?').get(input.messageId);
  if (prior?.status === 'sent' || prior?.status === 'review') {
    return { claimed, ready: false, result: { duplicate: true, status: prior.status } };
  }
  if (!prior && dailyLimitReached(input.brandId, Number(policy.dailyLimit || 20))) {
    return { claimed, ready: false, result: { skipped: true, reason: 'daily_limit' } };
  }
  let context;
  try {
    context = (deps.buildContext || buildConversationIncidentContext)(input.conversationId, input.messageId, { contextHours: policy.contextHours, maxMessages: policy.maxContextMessages });
  } catch {
    return { claimed, ready: false, result: { skipped: true, reason: 'context_failed' } };
  }
  if (context.contextConfidence === 'low') {
    return { claimed, ready: false, result: { skipped: true, reason: 'low_context_confidence' } };
  }
  return { claimed, ready: true, policy, mentionedJid, context };
}

async function routeStationInvestigation(input, deps = {}) {
  const preparation = deps.prepared || await prepareStationInvestigation(input, deps);
  if (!preparation.ready) return preparation.result;
  const { policy, mentionedJid, context } = preparation;
  const now = nowIso();
  db.prepare(`INSERT INTO station_investigation_jobs
    (message_id, conversation_id, brand_id, group_jid, instance, context_fingerprint, context_message_ids_json, status, attempts, next_attempt_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'processing', 1, ?, ?, ?)
    ON CONFLICT(message_id) DO UPDATE SET status='processing', attempts=attempts+1, updated_at=excluded.updated_at`)
    .run(input.messageId, input.conversationId, input.brandId, input.groupJid, input.instance, context.contextFingerprint, JSON.stringify(context.messageRefs.map(x => x.id)), now, now, now);
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
    const sent = await (deps.sendText || sendText)(input.instance, input.groupJid, result.reply);
    const externalId = sent?.key?.id || null;
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
    const next = new Date(Date.now() + 60_000).toISOString();
    db.prepare("UPDATE station_investigation_jobs SET status='retry', next_attempt_at=?, last_error=?, updated_at=? WHERE message_id=?")
      .run(next, String(error?.message || error).slice(0, 500), nowIso(), input.messageId);
    return { status: 'retry', error: String(error?.message || error) };
  }
}

module.exports = { prepareStationInvestigation, routeStationInvestigation, dailyLimitReached };
