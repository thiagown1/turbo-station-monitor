const path = require('path');
const { db, nowIso, randomId } = require('./db');
const { MEDIA_DIR } = require('./receipt-extractor');
const { classifyMessage } = require('./agent-media-classifier');
const { parseExpenseDecision, parseExpenseBrlAmount } = require('./expense-decision');

const configCache = new Map();
let worker = null;
let delivering = false;
let deliveringMediaJobs = false;
let mediaJobsRecovered = false;
const MEDIA_JOB_MAX_ATTEMPTS = 5;

function baseUrl() { return String(process.env.AGENT_EVENT_BASE_URL || '').replace(/\/$/, ''); }
function secret() { return process.env.AGENT_EVENT_SECRET || ''; }

class AgentConfigUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AgentConfigUnavailableError';
  }
}

async function loadConfig(brandId) {
  const cached = configCache.get(brandId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  if (!baseUrl() || !secret()) return null;
  try {
    const res = await fetch(`${baseUrl()}/api/agents/config?brandId=${encodeURIComponent(brandId)}`, {
      headers: { Authorization: `Bearer ${secret()}` }, signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`config_http_${res.status}`);
    const value = (await res.json()).config;
    configCache.set(brandId, { value, expiresAt: Date.now() + 60_000 });
    return value;
  } catch (error) {
    throw new AgentConfigUnavailableError(`agent_config_unavailable: ${String(error?.message || error)}`);
  }
}

function recentContext(conversationId) {
  return db.prepare('SELECT direction, body FROM messages WHERE conversation_id = ? ORDER BY datetime(created_at) DESC LIMIT 8')
    .all(conversationId).reverse().map(m => `[${m.direction}]: ${m.body}`).join('\n');
}

function partnerForGroup(groupJid) {
  const rows = db.prepare('SELECT partner_id FROM group_partner_links WHERE group_jid = ? AND enabled = 1 ORDER BY linked_at ASC').all(groupJid);
  return rows.length === 1 ? rows[0].partner_id : undefined;
}

function generalLimitReached(brandId, limit) {
  if (limit <= 0) return true;
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const row = db.prepare('SELECT COUNT(*) count FROM agent_media_analyses WHERE brand_id = ? AND analyzed_at >= ?').get(brandId, since);
  return Number(row?.count || 0) >= limit;
}

function queueEvent(messageId, brandId, payload) {
  const now = nowIso();
  db.prepare(`INSERT OR IGNORE INTO agent_event_outbox
    (id, message_id, brand_id, payload_json, status, attempts, next_attempt_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?)`)
    .run(randomId('agent_evt'), messageId, brandId, JSON.stringify(payload), now, now, now);
  void deliverDueEvents();
}

function isPdfInput(input) {
  const mime = String(input.media?.mimetype || '').split(';', 1)[0].trim().toLowerCase();
  return mime === 'application/pdf'
    || String(input.media?.filename || '').toLowerCase().endsWith('.pdf');
}

function shouldDeferEnergyInvoice(input, result) {
  const isPdf = isPdfInput(input);
  return input.deferEnergyInvoiceEvent === true
    && result.kind === 'energy_invoice'
    && (isPdf || Boolean(result.energyBill))
    && (isPdf || Number(result.confidence || 0) >= 0.85);
}

function deferredContadorJob(input, result) {
  const isPdf = isPdfInput(input);
  const messageId = input.externalMessageId || input.messageId;
  const kind = isPdf ? 'pdf' : 'image';
  const payload = {
    messageId,
    conversationId: input.conversationId,
    brandId: input.brandId,
    groupJid: input.groupJid,
    instance: input.instance,
    direction: 'inbound',
    sender: input.sender,
    senderId: input.senderId,
    body: input.body,
    media: input.media,
    receivedAt: input.receivedAt,
    visionExtraction: isPdf ? undefined : result.energyBill,
    kind,
  };
  const now = nowIso();
  return db.prepare(`
    INSERT INTO contador_jobs
      (id, message_id, conversation_id, brand_id, group_jid, instance, kind, payload_json, status, attempts, next_attempt_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
    ON CONFLICT(message_id) DO UPDATE SET
      payload_json = excluded.payload_json,
      status = 'pending',
      attempts = 0,
      next_attempt_at = excluded.next_attempt_at,
      updated_at = excluded.updated_at
    WHERE contador_jobs.status = 'blocked' AND excluded.kind = 'image'
  `).run(
    randomId('contador_job'), messageId, input.conversationId, input.brandId,
    input.groupJid, input.instance || '', kind, JSON.stringify(payload), now, now, now,
  );
}

async function routeInboundMessage(input) {
  const existing = db.prepare('SELECT status, attempts, kind, result_json FROM agent_media_analyses WHERE message_id = ?').get(input.messageId);
  if (existing && existing.status !== 'error') {
    let cached = {};
    try { cached = JSON.parse(existing.result_json || '{}'); } catch (_) { cached = {}; }
    const eventDeferred = shouldDeferEnergyInvoice(input, cached);
    if (eventDeferred) deferredContadorJob(input, cached);
    return { ...cached, duplicate: true, eventDeferred, contadorJobPersisted: eventDeferred };
  }
  const config = await loadConfig(input.brandId);
  if (!config?.enabled) return { skipped: 'disabled' };
  const accountingPriority = (config.accountingGroupConversationIds || []).includes(input.conversationId);
  const partnerPriority = Boolean(input.groupJid && partnerForGroup(input.groupJid));
  const partnerReceiptPriority = Boolean(
    partnerPriority
    && config.agents?.partnerReceipts
    && input.senderId
    && (config.allowedPartnerReceiptSenderIds || []).includes(input.senderId),
  );
  const isMedia = Boolean(input.media);
  const stationRequest = /\b(carregador|esta[cç][aã]o|offline|falha|erro|analis|verific|ocpp)\b/i.test(input.body || '');
  const eligible =
    (accountingPriority && config.agents?.accounting) ||
    partnerReceiptPriority ||
    (stationRequest && partnerPriority && config.agents?.stationSupport) ||
    (isMedia && config.analyzeAllMedia && config.agents?.supportTriage);
  if (!eligible) return { skipped: 'no_enabled_agent' };
  if (!accountingPriority && !partnerReceiptPriority && generalLimitReached(input.brandId, Number(config.dailyGeneralAnalysisLimit || 0))) {
    return { skipped: 'daily_limit' };
  }

  const result = await classifyMessage({
    absPath: input.media?.url ? path.join(MEDIA_DIR, path.basename(input.media.url)) : undefined,
    mediaType: input.media?.media_type,
    mimetype: input.media?.mimetype,
    body: input.body,
    context: recentContext(input.conversationId),
    model: config.model,
  });
  if (result.status === 'ok' && result.kind === 'station_support' && config.agents?.stationSupport) {
    try {
      const { createGroupSuggestion } = require('./auto-suggest');
      const suggestion = await createGroupSuggestion(input.conversationId, input.brandId);
      if (suggestion?.text) result.suggestedReply = suggestion.text;
      if (suggestion?.model) result.supportModel = suggestion.model;
    } catch (error) {
      // The classification and review task are still useful if the deeper
      // support agent is temporarily unavailable. Human review remains gated.
      result.supportSuggestionError = String(error?.message || error).slice(0, 300);
    }
  }
  const now = nowIso();
  const attempts = Number(existing?.attempts || 0) + 1;
  const eventDeferred = shouldDeferEnergyInvoice(input, result);
  db.transaction(() => {
    db.prepare(`INSERT INTO agent_media_analyses
      (message_id, conversation_id, brand_id, kind, status, result_json, model, input_tokens, output_tokens, estimated_cost_usd, attempts, analyzed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(message_id) DO UPDATE SET kind=excluded.kind,status=excluded.status,result_json=excluded.result_json,model=excluded.model,input_tokens=excluded.input_tokens,output_tokens=excluded.output_tokens,estimated_cost_usd=excluded.estimated_cost_usd,attempts=excluded.attempts,analyzed_at=excluded.analyzed_at`)
      .run(input.messageId, input.conversationId, input.brandId, result.kind || 'other', result.status, JSON.stringify(result), result.cost?.model || null, result.cost?.inputTokens || 0, result.cost?.outputTokens || 0, result.cost?.estimatedCostUsd || 0, attempts, now);
    if (eventDeferred) deferredContadorJob(input, result);
  })();
  if (result.status !== 'ok') return result;

  // Populate the legacy receipt cache too, so the manual sweep remains a free,
  // zero-extra-model-call fallback during rollout.
  if (result.kind === 'partner_payment_receipt' || result.kind === 'expense_receipt') {
    db.prepare(`INSERT INTO receipt_extractions (message_id, conversation_id, status, amount_cents, receipt_ref, model, attempts, extracted_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?) ON CONFLICT(message_id) DO UPDATE SET status=excluded.status,amount_cents=excluded.amount_cents,receipt_ref=excluded.receipt_ref,model=excluded.model,extracted_at=excluded.extracted_at`)
      .run(input.messageId, input.conversationId, result.amountCents ? 'ok' : 'error', result.amountCents || null, result.receiptRef || null, result.cost?.model || null, now);
  }
  const partnerId = input.groupJid ? partnerForGroup(input.groupJid) : undefined;
  const eventPayload = {
    brandId: input.brandId,
    kind: result.kind,
    sourceMessageId: input.externalMessageId || input.messageId,
    conversationId: input.conversationId,
    senderId: input.senderId,
    receivedAt: input.receivedAt,
    summary: result.summary,
    confidence: result.confidence,
    needsAttention: result.needsAttention,
    amountCents: result.amountCents,
    receiptRef: result.receiptRef,
    payee: result.payee,
    transactionDate: result.transactionDate,
    suggestedPeriod: result.suggestedPeriod,
    currency: result.currency,
    originalAmountMinor: result.originalAmountMinor,
    recurringHint: result.recurringHint,
    suggestedCategory: result.suggestedCategory,
    suggestedReply: result.suggestedReply,
    partnerId,
    cost: result.cost,
  };
  if (!eventDeferred) queueEvent(input.messageId, input.brandId, eventPayload);
  return { ...result, eventDeferred, contadorJobPersisted: eventDeferred };
}

function persistMediaJob(input) {
  const now = nowIso();
  db.prepare(`INSERT OR IGNORE INTO agent_media_jobs
    (message_id, payload_json, status, attempts, next_attempt_at, created_at, updated_at)
    VALUES (?, ?, 'pending', 0, ?, ?, ?)`)
    .run(input.messageId, JSON.stringify(input), now, now, now);
}

async function deliverSkippedMediaFallback(input) {
  const contadorEvent = {
    messageId: input.externalMessageId || input.messageId,
    conversationId: input.conversationId,
    brandId: input.brandId,
    groupJid: input.groupJid,
    instance: input.instance,
    direction: 'inbound',
    sender: input.sender,
    senderId: input.senderId,
    body: input.body,
    media: input.media,
    receivedAt: input.receivedAt,
    replyToContador: input.replyToContador,
    quotedContadorDraftId: input.quotedContadorDraftId,
  };
  const { enqueueContadorMessage } = require('./contador-runtime');
  const contadorRoute = enqueueContadorMessage(contadorEvent);
  if (contadorRoute.kind !== 'ignored') return { handled: true, contadorEnqueued: contadorRoute.enqueued === true };
  if (!input.groupJid) return { handled: false, contadorEnqueued: false };
  const { createGroupSuggestion } = require('./auto-suggest');
  await createGroupSuggestion(input.conversationId, input.brandId);
  return { handled: true, contadorEnqueued: false };
}

async function processMediaJob(messageId) {
  const claimed = db.prepare(`UPDATE agent_media_jobs
    SET status = 'processing', attempts = attempts + 1, updated_at = ?
    WHERE message_id = ? AND status IN ('pending', 'retry')
      AND datetime(next_attempt_at) <= datetime('now')`)
    .run(nowIso(), messageId);
  if (!claimed.changes) return { queued: true, duplicate: true };
  const row = db.prepare('SELECT payload_json, attempts FROM agent_media_jobs WHERE message_id = ?').get(messageId);
  try {
    const input = JSON.parse(row.payload_json);
    const result = await routeInboundMessage(input);
    if (result?.status === 'error') throw new Error(result.error || 'media_classification_failed');
    const fallback = result?.skipped ? await deliverSkippedMediaFallback(input) : { handled: false };
    db.prepare("UPDATE agent_media_jobs SET status = 'completed', last_error = NULL, updated_at = ? WHERE message_id = ?")
      .run(nowIso(), messageId);
    return { ...result, fallbackHandled: fallback.handled === true, contadorFallbackEnqueued: fallback.contadorEnqueued === true };
  } catch (error) {
    const attempts = Number(row.attempts || 1);
    const retryable = attempts < MEDIA_JOB_MAX_ATTEMPTS;
    const delayMs = Math.min(6 * 60 * 60 * 1000, 30_000 * (2 ** Math.min(attempts, 8)));
    const updatedAt = nowIso();
    db.prepare(`UPDATE agent_media_jobs
      SET status = ?, next_attempt_at = ?, last_error = ?, updated_at = ?
      WHERE message_id = ?`)
      .run(retryable ? 'retry' : 'failed', retryable ? new Date(Date.now() + delayMs).toISOString() : updatedAt, String(error?.message || error).slice(0, 500), updatedAt, messageId);
    throw error;
  }
}

function routeInboundMessageDurably(input) {
  persistMediaJob(input);
  return processMediaJob(input.messageId);
}

async function deliverDueMediaJobs() {
  if (deliveringMediaJobs) return;
  deliveringMediaJobs = true;
  try {
    const due = db.prepare(`SELECT message_id FROM agent_media_jobs
      WHERE status IN ('pending', 'retry') AND datetime(next_attempt_at) <= datetime('now')
      ORDER BY datetime(created_at) ASC LIMIT 5`).all();
    for (const row of due) {
      try { await processMediaJob(row.message_id); } catch (_) { /* retry state persisted */ }
    }
  } finally {
    deliveringMediaJobs = false;
  }
}

async function routeExpenseDecisionReply(input) {
  const codeMatch = String(input.quotedBody || '').match(/\bEXP-([A-F0-9]{8})\b/i);
  const amountCents = parseExpenseBrlAmount(input.body);
  const action = amountCents ? 'set_brl_amount' : parseExpenseDecision(input.body);
  if (!codeMatch || !action) return { handled: false };
  const config = await loadConfig(input.brandId);
  if (!config?.enabled || !config.agents?.accounting || !config.whatsappExpenseConfirmationEnabled) {
    return { handled: true, reply: 'A confirmação de despesas pelo WhatsApp está desativada. Use a revisão no dashboard.' };
  }
  if (!(config.accountingGroupConversationIds || []).includes(input.conversationId)
    || !(config.allowedAccountingDecisionSenderIds || []).includes(input.senderId)) {
    return { handled: true, reply: 'Este remetente não está autorizado a confirmar despesas.' };
  }
  try {
    const res = await fetch(`${baseUrl()}/api/agents/expense-decisions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret()}` },
      body: JSON.stringify({
        brandId: input.brandId,
        conversationId: input.conversationId,
        senderId: input.senderId,
        decisionCode: codeMatch[1].toUpperCase(),
        action,
        amountCents,
        sourceMessageId: input.externalMessageId || input.messageId,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { handled: true, reply: `Não consegui concluir: ${data.error || `erro ${res.status}`}. Confira no dashboard.` };
    return {
      handled: true,
      reply: action === 'set_brl_amount' ? 'Valor em reais recebido. Enviei as opções para registrar a despesa.'
        : action === 'reject' ? 'Certo, o comprovante foi ignorado.'
        : action === 'register_monthly' ? 'Despesa registrada e marcada como recorrente mensal. Os próximos meses continuarão exigindo um comprovante.'
          : 'Despesa registrada somente nesta competência.',
    };
  } catch (_) {
    return { handled: true, reply: 'Não consegui falar com o sistema contábil agora. Tente novamente citando a mesma mensagem.' };
  }
}

async function deliverDueEvents() {
  if (delivering || !baseUrl() || !secret()) return;
  delivering = true;
  try {
    const due = db.prepare("SELECT * FROM agent_event_outbox WHERE status IN ('pending','retry') AND next_attempt_at <= ? ORDER BY created_at ASC LIMIT 20").all(nowIso());
    for (const row of due) {
      let status = 0; let responseBody = '';
      try {
        const res = await fetch(`${baseUrl()}/api/agents/events`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret()}` }, body: row.payload_json, signal: AbortSignal.timeout(20_000),
        });
        status = res.status; responseBody = (await res.text()).slice(0, 2000);
        if (res.ok || (res.status >= 400 && res.status < 500 && res.status !== 429)) {
          db.prepare("UPDATE agent_event_outbox SET status = ?, attempts = attempts + 1, response_status = ?, response_json = ?, last_error = NULL, updated_at = ? WHERE id = ?")
            .run(res.ok ? 'delivered' : 'business_rejected', status, responseBody, nowIso(), row.id);
          continue;
        }
      } catch (error) { responseBody = error.message; }
      const attempts = row.attempts + 1;
      const delayMs = Math.min(6 * 60 * 60 * 1000, 30_000 * (2 ** Math.min(attempts, 8)));
      db.prepare("UPDATE agent_event_outbox SET status = 'retry', attempts = ?, next_attempt_at = ?, response_status = ?, last_error = ?, updated_at = ? WHERE id = ?")
        .run(attempts, new Date(Date.now() + delayMs).toISOString(), status || null, responseBody.slice(0, 500), nowIso(), row.id);
    }
  } finally { delivering = false; }
}

function startAgentEventWorker() {
  if (worker) return;
  if (!mediaJobsRecovered) {
    const recoveredAt = nowIso();
    db.prepare(`UPDATE agent_media_jobs
      SET status = 'retry', next_attempt_at = ?, last_error = 'interrupted_process', updated_at = ?
      WHERE status = 'processing'`).run(recoveredAt, recoveredAt);
    mediaJobsRecovered = true;
  }
  worker = setInterval(() => {
    void deliverDueEvents();
    void deliverDueMediaJobs();
  }, 30_000);
  worker.unref?.();
  void deliverDueEvents();
  void deliverDueMediaJobs();
}

module.exports = {
  routeInboundMessage,
  routeInboundMessageDurably,
  routeExpenseDecisionReply,
  parseExpenseDecision,
  deliverDueEvents,
  deliverDueMediaJobs,
  startAgentEventWorker,
  loadConfig,
  shouldDeferEnergyInvoice,
  isPdfInput,
};
