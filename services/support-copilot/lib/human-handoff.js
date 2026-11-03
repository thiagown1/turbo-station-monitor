'use strict';

/**
 * Human handoff — Support Copilot.
 *
 * One shared place that decides WHEN the AI must hand a conversation to a
 * person, WHO owns it afterwards, and WHAT the person receives. Used by the
 * 1:1 copilot, the station investigator and the partner assistant.
 *
 * Ownership uses the columns the copilot already has on `conversations`:
 *   status            open | assigned (takeover) | escalated | closed
 *   assigned_agent_id who took it over
 *   escalated_at/to   when and to whom (label only, e.g. 'team')
 * While the status is `assigned` or `escalated` the conversation is HUMAN-OWNED
 * and no AI path may suggest, auto-send, investigate or answer in it.
 * Only `resolveHandoff` (or the existing /release route) gives it back.
 *
 * Design rules:
 *  - FAIL CLOSED. If anything about notifying fails, ownership stays with the
 *    human side and the AI stays silent. A failure is audited and flagged
 *    (`needsAttention`), never retried in a loop.
 *  - NO INVENTED CHANNEL. The team notice and the customer notice are injected
 *    functions. The on-call phone call is an injected PORT (`onCall`). With no
 *    function wired, the handoff is recorded and flagged, and nothing is sent.
 *  - NO PROMISES. The customer notice states a fact (forwarded to the team). It
 *    gives no deadline and names no channel.
 *  - PURE DECISIONS. `evaluateHandoff` has no I/O and no clock.
 *
 * See docs/HUMAN_HANDOFF.md.
 */

const crypto = require('node:crypto');
const { detectEscalation, HUMAN_OWNED_STATUSES } = require('./auto-respond-gate');

const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_CALL_TIMEOUT_MS = 10_000;
const TEXT_LIMIT = 500;

// Reason codes, in precedence order (first wins as `primary`).
const REASON_ORDER = Object.freeze([
  'urgent',
  'explicit_human_request',
  'risk_topic',
  'out_of_scope',
  'repeated_failures',
  'low_confidence',
]);

// Matched against accent-folded, lowercased text.
const URGENT_PATTERNS = [
  /\b(pegando|pegou|pegar) fogo\b/,
  /\bfogo (no|na|em|saindo|saiu)\b/,
  /\bincendio\b/,
  /\bfumaca\b/,
  /\bcheiro de queimado\b/,
  /\bqueimando\b/,
  /\bfaisca\w*\b/,
  /\b(levei|tomei|deu|dando|dei) (um )?choque\b/,
  /\bchoque eletrico\b/,
  /\bexplo(diu|sao|dindo)\b/,
  /\bcurto.?circuito\b/,
  /\bcabo (ficou |esta |ta )?preso\b/,
  /\bpreso (no|na) (carro|veiculo|carregador|conector)\b/,
  /\bsocorro\b/,
  /\bacidente\b/,
  /\bferid[oa]s?\b/,
];

// Extra "talk to a person" phrasings on top of the copilot gate's list.
const HUMAN_REQUEST_EXTRA = /\b(atendente|atendimento humano|um humano|uma pessoa|alguem da equipe|alguem do suporte)\b/;

const LOW_CONFIDENCE_REASONS = Object.freeze(['station_not_identified', 'low_context_confidence', 'context_failed']);

function fold(text) {
  return String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function clip(text, limit = TEXT_LIMIT) {
  const s = String(text == null ? '' : text);
  return s.length > limit ? `${s.slice(0, limit)}…` : s;
}

function randomId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function maskPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length >= 4 ? `***${digits.slice(-4)}` : '***';
}

function isHumanOwned(conv) {
  return Boolean(conv) && HUMAN_OWNED_STATUSES.includes(conv.status);
}

/** Live check used right before an AI path analyses or sends. Fails open to "not owned" if the row is missing. */
function isConversationHumanOwned(db, conversationId) {
  const row = db.prepare('SELECT status FROM conversations WHERE id = ?').get(conversationId);
  return isHumanOwned(row);
}

/**
 * Decide whether the AI must hand off. Pure.
 *
 * @param {object} input
 * @param {string} [input.text]            last customer/group message
 * @param {string[]} [input.tags]          tags emitted by the suggestion
 * @param {object} [input.signals]         { stationIdentified, confidence, blockedReasons,
 *                                           outOfScope, failureCount }
 * @param {object} [input.policy]          { failureThreshold }
 * @returns {{escalate:boolean, priority:'urgent'|'normal', primary:string|null, reasons:string[]}}
 */
function evaluateHandoff({ text = '', tags = [], signals = {}, policy = {} } = {}) {
  const found = new Set();
  const folded = fold(text);

  if (URGENT_PATTERNS.some(re => re.test(folded))) found.add('urgent');

  const gate = detectEscalation(text, '', tags);
  if (gate === 'pedido_humano') found.add('explicit_human_request');
  else if (gate) found.add('risk_topic');
  if (HUMAN_REQUEST_EXTRA.test(folded)) found.add('explicit_human_request');

  if (signals.outOfScope) found.add('out_of_scope');

  const threshold = Number(policy.failureThreshold) > 0 ? Number(policy.failureThreshold) : DEFAULT_FAILURE_THRESHOLD;
  if (Number(signals.failureCount) >= threshold) found.add('repeated_failures');

  const blocked = Array.isArray(signals.blockedReasons) ? signals.blockedReasons : [];
  if (
    signals.stationIdentified === false
    || signals.confidence === 'low'
    || blocked.some(r => LOW_CONFIDENCE_REASONS.includes(r))
  ) {
    found.add('low_confidence');
  }

  const reasons = REASON_ORDER.filter(r => found.has(r));
  return {
    escalate: reasons.length > 0,
    priority: found.has('urgent') ? 'urgent' : 'normal',
    primary: reasons[0] || null,
    reasons,
  };
}

/** Everything a person needs to pick the case up without re-asking. */
function buildHandoffPacket({ conv, evaluation, lastMessage = '', evidence = [], aiDraft = '', failureCount = 0, now }) {
  return {
    conversationId: conv.id,
    brandId: conv.brand_id || null,
    channel: conv.channel || null,
    customerName: conv.customer_name || null,
    phoneMasked: maskPhone(conv.customer_phone),
    priority: evaluation.priority,
    primary: evaluation.primary,
    reasons: evaluation.reasons,
    lastMessage: clip(lastMessage),
    aiDraft: clip(aiDraft),
    evidence: (Array.isArray(evidence) ? evidence : []).slice(0, 10).map(e => clip(e, 200)),
    failureCount: Number(failureCount) || 0,
    createdAt: now || null,
  };
}

const REASON_LABEL = Object.freeze({
  urgent: 'urgência / risco',
  explicit_human_request: 'pediu uma pessoa',
  risk_topic: 'tema sensível (dinheiro, jurídico ou cliente irritado)',
  out_of_scope: 'fora do escopo da IA',
  repeated_failures: 'falhas repetidas da IA',
  low_confidence: 'IA sem confiança ou estação não identificada',
});

/** Message to the customer: a fact, no deadline, no channel. */
function renderCustomerNotice({ priority } = {}) {
  const base = 'Passei sua mensagem para a nossa equipe. Uma pessoa vai continuar a conversa por aqui.';
  if (priority !== 'urgent') return base;
  return `${base} Se houver fogo, fumaça ou risco de choque, afaste-se do equipamento e ligue para os Bombeiros (193).`;
}

/** Message to the team (internal group). No raw phone number. */
function renderInternalNotice(packet) {
  const lines = [];
  lines.push(packet.priority === 'urgent' ? '🚨 URGENTE — atendimento humano necessário' : '🙋 Atendimento humano necessário');
  lines.push(`Motivo: ${(packet.reasons || []).map(r => REASON_LABEL[r] || r).join('; ') || 'não informado'}`);
  lines.push(`Cliente: ${packet.customerName || 'sem nome'} (${packet.phoneMasked})`);
  lines.push(`Conversa: ${packet.conversationId}`);
  if (packet.lastMessage) lines.push(`Última mensagem: "${packet.lastMessage}"`);
  if (packet.evidence?.length) lines.push(`Evidências:\n${packet.evidence.map(e => `- ${e}`).join('\n')}`);
  if (packet.aiDraft) lines.push(`Rascunho da IA (não enviado): "${packet.aiDraft}"`);
  if (packet.failureCount) lines.push(`Falhas recentes da IA: ${packet.failureCount}`);
  lines.push('A IA ficou em silêncio nesta conversa até alguém marcar como resolvida.');
  return lines.join('\n');
}

function audit(db, conv, action, metadata, now, actor = null) {
  db.prepare(`INSERT INTO audit_log (id, brand_id, conversation_id, action, actor_user_id, metadata_json, created_at)
              VALUES (?,?,?,?,?,?,?)`)
    .run(randomId('audit'), conv.brand_id || null, conv.id, action, actor, JSON.stringify(metadata || {}), now);
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function runCall({ onCall, packet, timeoutMs }) {
  if (packet.priority !== 'urgent') return { status: 'not_required' };
  if (!onCall || typeof onCall.resolve !== 'function' || typeof onCall.place !== 'function') {
    return { status: 'not_configured' };
  }
  let target;
  try {
    target = await withTimeout(Promise.resolve(onCall.resolve()), timeoutMs);
  } catch (_) {
    return { status: 'oncall_unavailable' };
  }
  if (!target || target.available !== true) return { status: 'oncall_unavailable' };
  const summary = {
    conversationId: packet.conversationId,
    priority: packet.priority,
    reasons: packet.reasons,
    lastMessage: clip(packet.lastMessage, 200),
  };
  try {
    const placed = await withTimeout(Promise.resolve(onCall.place(target.contactRef, summary)), timeoutMs);
    return placed && placed.ok ? { status: 'placed' } : { status: 'call_failed' };
  } catch (_) {
    return { status: 'call_failed' };
  }
}

/**
 * Take ownership and hand the case to people. Idempotent per conversation: a
 * conversation that is already human-owned is a no-op (no second notice).
 *
 * @returns {Promise<{ok:boolean, duplicate?:boolean, reason?:string, notified?:boolean,
 *   customerNotified?:boolean, call?:{status:string}, needsAttention?:boolean}>}
 */
async function requestHandoff({
  db, conv, evaluation, packet, notify, sendCustomerNotice, onCall,
  target = 'team', actor = null, now = new Date().toISOString(), callTimeoutMs = DEFAULT_CALL_TIMEOUT_MS,
}) {
  if (!evaluation || !evaluation.escalate) return { ok: false, reason: 'no_escalation_needed' };

  const claim = db.transaction(() => {
    const current = db.prepare('SELECT status, priority FROM conversations WHERE id = ?').get(conv.id);
    if (!current) return { ok: false, reason: 'conversation_not_found' };
    if (isHumanOwned(current)) return { ok: true, duplicate: true };
    const priority = evaluation.priority === 'urgent' || current.priority === 'urgent' ? 'urgent' : (current.priority || 'normal');
    db.prepare(`UPDATE conversations SET status = 'escalated', escalated_at = ?, escalated_to = ?, priority = ?, updated_at = ? WHERE id = ?`)
      .run(now, target, priority, now, conv.id);
    audit(db, conv, 'support.handoff', {
      reasons: evaluation.reasons, primary: evaluation.primary, priority: evaluation.priority, escalated_to: target,
    }, now, actor);
    return { ok: true, duplicate: false };
  });
  const claimed = claim();
  if (!claimed.ok) return claimed;
  if (claimed.duplicate) return { ok: true, duplicate: true, notified: false, customerNotified: false, call: { status: 'skipped' }, needsAttention: false };

  let needsAttention = false;

  let notified = false;
  if (typeof notify !== 'function') {
    audit(db, conv, 'support.handoff_notify_skipped', { reason: 'no_channel_configured' }, now);
    needsAttention = true;
  } else {
    try {
      await notify({ text: renderInternalNotice(packet), packet });
      notified = true;
    } catch (err) {
      audit(db, conv, 'support.handoff_notify_failed', { error: clip(err && err.message, 200) }, now);
      needsAttention = true;
    }
  }

  let customerNotified = false;
  if (typeof sendCustomerNotice === 'function') {
    try {
      await sendCustomerNotice({ text: renderCustomerNotice({ priority: evaluation.priority }), conversationId: conv.id });
      customerNotified = true;
    } catch (err) {
      audit(db, conv, 'support.handoff_customer_notice_failed', { error: clip(err && err.message, 200) }, now);
    }
  }

  const call = await runCall({ onCall, packet: { ...packet, priority: evaluation.priority }, timeoutMs: callTimeoutMs });
  if (call.status !== 'not_required') audit(db, conv, 'support.handoff_call', { status: call.status }, now);
  if (call.status === 'oncall_unavailable' || call.status === 'call_failed') needsAttention = true;

  return { ok: true, duplicate: false, notified, customerNotified, call, needsAttention };
}

/** Give the conversation back to the AI. Only a person triggers this. */
function resolveHandoff({ db, conversationId, actor = null, now = new Date().toISOString() }) {
  const conv = db.prepare('SELECT id, brand_id, status FROM conversations WHERE id = ?').get(conversationId);
  if (!conv) return { ok: false, reason: 'conversation_not_found' };
  if (!isHumanOwned(conv)) return { ok: false, reason: 'not_human_owned' };
  db.transaction(() => {
    db.prepare(`UPDATE conversations SET status = 'open', assigned_agent_id = NULL, escalated_at = NULL, escalated_to = NULL, updated_at = ? WHERE id = ?`)
      .run(now, conv.id);
    audit(db, conv, 'support.handoff_resolved', { previous_status: conv.status }, now, actor);
  })();
  return { ok: true };
}

/** Failed or blocked AI jobs for one conversation since `sinceIso`. */
function countRecentFailures(db, conversationId, sinceIso) {
  let total = 0;
  const queries = [
    `SELECT COUNT(*) n FROM station_investigation_jobs
       WHERE conversation_id = ? AND updated_at >= ? AND (status = 'failed' OR decision = 'blocked')
         AND COALESCE(last_error, '') <> 'human_owned'`,
    `SELECT COUNT(*) n FROM partner_assistant_jobs
       WHERE conversation_id = ? AND updated_at >= ? AND status = 'failed'
         AND COALESCE(last_error, '') <> 'human_owned'`,
  ];
  for (const sql of queries) {
    try {
      total += db.prepare(sql).get(conversationId, sinceIso).n;
    } catch (_) { /* table missing in this deployment: counts as zero */ }
  }
  return total;
}

module.exports = {
  HUMAN_OWNED_STATUSES,
  REASON_ORDER,
  isHumanOwned,
  isConversationHumanOwned,
  evaluateHandoff,
  buildHandoffPacket,
  renderCustomerNotice,
  renderInternalNotice,
  requestHandoff,
  resolveHandoff,
  countRecentFailures,
};
