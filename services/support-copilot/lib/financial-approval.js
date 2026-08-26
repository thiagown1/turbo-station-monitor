'use strict';

const { createHash } = require('crypto');
const { db, nowIso, randomId, normalizePhone } = require('./db');
const evolutionClient = require('./evolution-client');
const {
  CONTADOR_FINANCIAL_APPROVAL_ENABLED,
  CONTADOR_FINANCIAL_APPROVAL_OPERATOR_JID,
  CONTADOR_FINANCIAL_APPROVAL_ALLOWED_SENDER_IDS,
  CONTADOR_FINANCIAL_APPROVAL_TTL_MINUTES,
  LOG_TAG,
} = require('./constants');

const ALLOWED_CATEGORIES = new Set([
  'gateway',
  'ia',
  'infra',
  'marketing',
  'taxas',
  'emprestimos',
  'outros',
]);
const SEND_MAX_ATTEMPTS = 5;
const EXECUTION_MAX_ATTEMPTS = 5;
let workerBusy = false;
let sendTextImpl = evolutionClient.sendText;
let nowProvider = () => new Date();

function featureEnabled() {
  return CONTADOR_FINANCIAL_APPROVAL_ENABLED;
}

function operatorSenderId() {
  return normalizePhone(String(CONTADOR_FINANCIAL_APPROVAL_OPERATOR_JID).split('@')[0]);
}

function configurationReady() {
  const target = CONTADOR_FINANCIAL_APPROVAL_OPERATOR_JID;
  const senderId = operatorSenderId();
  return Boolean(
    featureEnabled()
    && target
    && !target.endsWith('@g.us')
    && senderId
    && CONTADOR_FINANCIAL_APPROVAL_ALLOWED_SENDER_IDS.includes(senderId)
  );
}

function currentIso() {
  return nowProvider().toISOString();
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((result, key) => {
      if (value[key] !== undefined) result[key] = canonicalize(value[key]);
      return result;
    }, {});
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function safeError(error) {
  return String(error?.message || error || 'unknown_error')
    .replace(/\bauthorization\s*[:=]\s*bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'authorization=[redacted]')
    .replace(/\bbearer\s+[A-Za-z0-9._~+/=-]+/gi, 'bearer=[redacted]')
    .replace(/(api[-_ ]?key|authorization|bearer|token|secret)\s*[:=]\s*\S+/gi, '$1=[redacted]')
    .slice(0, 300);
}

function audit(action, proposal, details = {}) {
  db.prepare(`
    INSERT INTO audit_log
      (id, brand_id, conversation_id, action, actor_user_id, metadata_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    randomId('audit'),
    proposal?.brand_id || proposal?.brandId || 'turbo_station',
    proposal?.source_conversation_id || proposal?.sourceConversationId || null,
    action,
    details.actorUserId || null,
    JSON.stringify({
      proposalId: proposal?.id || null,
      sourceMessageId: proposal?.source_message_id || proposal?.sourceMessageId || null,
      ...Object.fromEntries(Object.entries(details).filter(([key]) => key !== 'actorUserId')),
    }),
    currentIso(),
  );
}

function normalizedCategory(value) {
  const category = String(value || '').trim().toLowerCase();
  return ALLOWED_CATEGORIES.has(category) ? category : null;
}

function proposalStatus(category) {
  if (!category) return 'blocked_invalid_action';
  return configurationReady() ? 'pending_send' : 'waiting_config';
}

function queueFinancialApprovalProposal(params) {
  if (!featureEnabled()) return { handled: false };
  const eventPayload = params?.eventPayload || {};
  if (eventPayload.kind !== 'expense_receipt') return { handled: false };

  const category = normalizedCategory(eventPayload.suggestedCategory);
  const sourceMessageId = String(params.sourceMessageId || eventPayload.sourceMessageId || '').trim();
  const sourceConversationId = String(params.sourceConversationId || eventPayload.conversationId || '').trim();
  const brandId = String(eventPayload.brandId || '').trim();
  if (!sourceMessageId || !sourceConversationId || !brandId) {
    throw new Error('financial_approval_missing_source_identity');
  }

  const actionPayload = {
    action: 'classify_expense',
    category: category || String(eventPayload.suggestedCategory || '').slice(0, 100),
    receipt: {
      brandId,
      sourceMessageId,
      conversationId: sourceConversationId,
      senderId: eventPayload.senderId,
      receivedAt: eventPayload.receivedAt,
      summary: eventPayload.summary,
      confidence: eventPayload.confidence,
      amountCents: eventPayload.amountCents,
      currency: eventPayload.currency,
      originalAmountMinor: eventPayload.originalAmountMinor,
      transactionDate: eventPayload.transactionDate,
      suggestedPeriod: eventPayload.suggestedPeriod,
      recurringHint: eventPayload.recurringHint,
      receiptRef: eventPayload.receiptRef,
      payee: eventPayload.payee,
    },
  };
  const payloadJson = canonicalJson(actionPayload);
  const payloadHash = sha256(payloadJson);
  const id = `finprop_${sha256(`${brandId}:${sourceMessageId}:${payloadHash}`)}`;
  const proposalCode = `FIN-${sha256(`proposal:${id}`).slice(0, 8).toUpperCase()}`;
  const createdAt = currentIso();
  const expiresAt = new Date(nowProvider().getTime() + CONTADOR_FINANCIAL_APPROVAL_TTL_MINUTES * 60_000).toISOString();
  const status = proposalStatus(category);
  const operatorJid = CONTADOR_FINANCIAL_APPROVAL_OPERATOR_JID;

  const inserted = db.prepare(`
    INSERT OR IGNORE INTO contador_financial_proposals
      (id, proposal_code, source_message_id, source_conversation_id, brand_id,
       source_sender_id, operator_jid, instance, action_type, action_payload_json,
       payload_hash, status, send_attempts, execution_attempts, next_attempt_at,
       expires_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'classify_expense', ?, ?, ?, 0, 0, ?, ?, ?, ?)
  `).run(
    id,
    proposalCode,
    sourceMessageId,
    sourceConversationId,
    brandId,
    eventPayload.senderId || null,
    operatorJid,
    params.instance || 'turbostation',
    payloadJson,
    payloadHash,
    status,
    status === 'pending_send' ? createdAt : null,
    expiresAt,
    createdAt,
    createdAt,
  );

  const proposal = db.prepare('SELECT * FROM contador_financial_proposals WHERE source_message_id = ?')
    .get(sourceMessageId);
  if (!proposal) throw new Error('financial_approval_proposal_not_persisted');
  if (proposal.payload_hash !== payloadHash || proposal.action_payload_json !== payloadJson) {
    audit('contador_financial_proposal_conflict', proposal, { reason: 'immutable_payload_mismatch' });
    return { handled: true, proposalId: proposal.id, status: 'blocked_conflict' };
  }
  if (inserted.changes === 1) {
    audit('contador_financial_proposal_created', proposal, {
      actionType: 'classify_expense',
      category: category || 'invalid',
      payloadHash,
      status,
    });
    if (!category) {
      audit('contador_financial_proposal_blocked', proposal, { reason: 'invalid_or_missing_category' });
    } else if (status === 'waiting_config') {
      audit('contador_financial_proposal_blocked', proposal, { reason: 'approval_configuration_incomplete' });
    }
  }
  return { handled: true, proposalId: proposal.id, status: proposal.status, created: inserted.changes === 1 };
}

function redactSummary(value) {
  return String(value || 'Comprovante recebido')
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[e-mail oculto]')
    .replace(/\b\d{6,}\b/g, '[identificador oculto]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, 500);
}

function brl(amountCents) {
  if (!Number.isInteger(amountCents) || amountCents <= 0) return 'não identificado';
  return `R$ ${(amountCents / 100).toFixed(2).replace('.', ',')}`;
}

function formatProposalMessage(proposal) {
  const payload = JSON.parse(proposal.action_payload_json);
  const receipt = payload.receipt || {};
  const payee = redactSummary(receipt.payee || 'não identificado').slice(0, 120);
  const summary = redactSummary(receipt.summary);
  return [
    `Aprovação financeira ${proposal.proposal_code}`,
    `Comprovante: ${summary}`,
    `Favorecido: ${payee}`,
    `Valor: ${brl(receipt.amountCents)}`,
    `Ação proposta: classificar como ${payload.category}.`,
    '',
    'Para confirmar, cite esta mensagem e responda exatamente:',
    `APROVAR ${proposal.proposal_code}`,
    '',
    'Para recusar:',
    `RECUSAR ${proposal.proposal_code}`,
    '',
    `Expira em ${CONTADOR_FINANCIAL_APPROVAL_TTL_MINUTES} minutos. A aprovação só grava a classificação local para revisão; não movimenta saldo e não registra pagamento, crédito, estorno ou despesa contábil.`,
  ].join('\n');
}

function ensureOperatorConversation(proposal) {
  const phone = normalizePhone(String(proposal.operator_jid).split('@')[0]);
  let conversation = db.prepare(`
    SELECT id FROM conversations
    WHERE brand_id = ? AND channel = 'whatsapp' AND customer_phone = ?
    ORDER BY datetime(updated_at) DESC LIMIT 1
  `).get(proposal.brand_id, phone);
  if (conversation) return conversation.id;
  const id = randomId('conv');
  const now = currentIso();
  db.prepare(`
    INSERT INTO conversations
      (id, brand_id, channel, customer_phone, customer_name, status, created_at, updated_at)
    VALUES (?, ?, 'whatsapp', ?, 'Operador financeiro', 'open', ?, ?)
  `).run(id, proposal.brand_id, phone, now, now);
  return id;
}

function recordProposalOutbound(proposal, text, externalMessageId) {
  const conversationId = ensureOperatorConversation(proposal);
  const createdAt = currentIso();
  db.prepare(`
    INSERT INTO messages
      (id, conversation_id, brand_id, direction, source, body, external_message_id,
       media_json, delivery_status, created_at)
    VALUES (?, ?, ?, 'outbound', 'contador', ?, ?, ?, 'sent', ?)
  `).run(
    randomId('msg'),
    conversationId,
    proposal.brand_id,
    text,
    externalMessageId || null,
    JSON.stringify({ contador: { kind: 'financial_approval_proposal', proposalId: proposal.id } }),
    createdAt,
  );
  db.prepare(`
    UPDATE conversations SET last_message_at = ?, last_outbound_at = ?, updated_at = ? WHERE id = ?
  `).run(createdAt, createdAt, createdAt, conversationId);
}

function nextRetryIso(attempts) {
  const minutes = [1, 5, 15, 30, 60][Math.min(Math.max(attempts - 1, 0), 4)];
  return new Date(nowProvider().getTime() + minutes * 60_000).toISOString();
}

function expireProposal(proposal, reason = 'confirmation_expired') {
  const expiredAt = currentIso();
  const updated = db.prepare(`
    UPDATE contador_financial_proposals
    SET status = 'expired', next_attempt_at = NULL, last_error = ?, updated_at = ?
    WHERE id = ? AND status IN ('pending_send','retry_send','waiting_config','awaiting_confirmation')
  `).run(reason, expiredAt, proposal.id);
  if (updated.changes) audit('contador_financial_proposal_expired', proposal, { reason });
  return updated.changes === 1;
}

async function sendProposal(proposal) {
  if (Date.parse(proposal.expires_at) <= nowProvider().getTime()) {
    expireProposal(proposal);
    return;
  }
  if (!configurationReady() || proposal.operator_jid !== CONTADOR_FINANCIAL_APPROVAL_OPERATOR_JID) {
    db.prepare(`
      UPDATE contador_financial_proposals
      SET status = 'waiting_config', next_attempt_at = NULL, last_error = 'approval_configuration_incomplete', updated_at = ?
      WHERE id = ? AND status IN ('pending_send','retry_send','waiting_config')
    `).run(currentIso(), proposal.id);
    return;
  }
  const claimedAt = currentIso();
  const claimed = db.prepare(`
    UPDATE contador_financial_proposals
    SET status = 'sending', send_attempts = send_attempts + 1, updated_at = ?
    WHERE id = ? AND status IN ('pending_send','retry_send','waiting_config')
  `).run(claimedAt, proposal.id);
  if (!claimed.changes) return;

  const current = db.prepare('SELECT * FROM contador_financial_proposals WHERE id = ?').get(proposal.id);
  const text = formatProposalMessage(current);
  let result;
  try {
    result = await sendTextImpl(current.instance, current.operator_jid, text);
  } catch (error) {
    const attempts = Number(current.send_attempts || 1);
    const statusCode = Number(error?.statusCode);
    const definitive = Number.isInteger(statusCode);
    const retryable = definitive && (statusCode === 408 || statusCode === 429 || statusCode >= 500)
      && attempts < SEND_MAX_ATTEMPTS;
    const status = retryable ? 'retry_send' : definitive ? 'failed_delivery' : 'delivery_unknown';
    db.prepare(`
      UPDATE contador_financial_proposals
      SET status = ?, next_attempt_at = ?, last_error = ?, updated_at = ?
      WHERE id = ? AND status = 'sending'
    `).run(status, retryable ? nextRetryIso(attempts) : null, safeError(error), currentIso(), current.id);
    audit('contador_financial_proposal_send_failed', current, { reason: status, attempts });
    return;
  }

  const externalMessageId = result?.key?.id || null;
  try {
    db.transaction(() => {
      recordProposalOutbound(current, text, externalMessageId);
      const sentAt = currentIso();
      db.prepare(`
        UPDATE contador_financial_proposals
        SET status = 'awaiting_confirmation', outbound_message_id = ?, sent_at = ?,
            next_attempt_at = NULL, last_error = NULL, updated_at = ?
        WHERE id = ? AND status = 'sending'
      `).run(externalMessageId, sentAt, sentAt, current.id);
      audit('contador_financial_proposal_sent', current, { delivery: 'accepted' });
    })();
  } catch (error) {
    db.prepare(`
      UPDATE contador_financial_proposals
      SET status = 'delivery_unknown', next_attempt_at = NULL, last_error = ?, updated_at = ?
      WHERE id = ? AND status = 'sending'
    `).run(safeError(error), currentIso(), current.id);
    audit('contador_financial_proposal_send_failed', current, { reason: 'local_checkpoint_failed' });
  }
}

function exactDecision(text) {
  const normalized = String(text || '').trim().toUpperCase();
  const match = normalized.match(/^(APROVAR|RECUSAR)\s+(FIN-[A-F0-9]{8})$/);
  if (!match) return null;
  return { decision: match[1] === 'APROVAR' ? 'approve' : 'reject', code: match[2] };
}

function looksLikeDecision(text) {
  return /\bFIN-[A-F0-9]{4,}\b/i.test(String(text || ''))
    || /^\s*(APROVAR|RECUSAR)\b/i.test(String(text || ''));
}

function handleFinancialApprovalReply(input) {
  if (!looksLikeDecision(input?.body)) return { handled: false };
  const parsed = exactDecision(input.body);
  const looseCode = String(input.body || '').toUpperCase().match(/\bFIN-[A-F0-9]{8}\b/)?.[0];
  const proposal = looseCode
    ? db.prepare('SELECT * FROM contador_financial_proposals WHERE proposal_code = ?').get(looseCode)
    : null;
  const senderId = normalizePhone(input.senderId);
  const authorized = Boolean(senderId && CONTADOR_FINANCIAL_APPROVAL_ALLOWED_SENDER_IDS.includes(senderId));

  if (!proposal) {
    if (authorized) audit('contador_financial_confirmation_rejected', input, { reason: parsed ? 'proposal_not_found' : 'invalid_format', actorUserId: `whatsapp:${senderId}` });
    return { handled: true, silent: !authorized, reply: authorized ? 'Proposta não encontrada ou formato inválido.' : undefined };
  }
  if (!authorized) {
    audit('contador_financial_confirmation_rejected', proposal, { reason: 'sender_not_allowed' });
    return { handled: true, silent: true, reason: 'sender_not_allowed' };
  }
  const actorUserId = `whatsapp:${senderId}`;
  if (!featureEnabled()) {
    audit('contador_financial_confirmation_rejected', proposal, { reason: 'feature_disabled', actorUserId });
    return { handled: true, reply: 'A aprovação financeira pessoal está desativada.' };
  }
  if (!parsed) {
    audit('contador_financial_confirmation_rejected', proposal, { reason: 'invalid_format', actorUserId });
    return { handled: true, reply: `Use exatamente APROVAR ${proposal.proposal_code} ou RECUSAR ${proposal.proposal_code}, citando a proposta.` };
  }
  if (!proposal.outbound_message_id || input.quotedMessageId !== proposal.outbound_message_id) {
    audit('contador_financial_confirmation_rejected', proposal, { reason: 'quoted_message_mismatch', actorUserId });
    return { handled: true, reply: 'A confirmação foi recusada porque não cita a proposta exata.' };
  }
  if (Date.parse(proposal.expires_at) <= nowProvider().getTime()) {
    expireProposal(proposal);
    return { handled: true, reply: 'A proposta expirou e nenhuma classificação foi aplicada.' };
  }
  if (proposal.status !== 'awaiting_confirmation') {
    audit('contador_financial_confirmation_rejected', proposal, { reason: 'duplicate_or_closed', status: proposal.status, actorUserId });
    return {
      handled: true,
      duplicate: true,
      reply: proposal.status === 'executed'
        ? 'Esta proposta já foi executada; nenhuma ação foi repetida.'
        : 'Esta proposta já foi encerrada; nenhuma ação foi aplicada.',
    };
  }

  const decidedAt = currentIso();
  const nextStatus = parsed.decision === 'approve' ? 'confirmed' : 'rejected';
  const updated = db.transaction(() => {
    const result = db.prepare(`
      UPDATE contador_financial_proposals
      SET status = ?, confirmation_message_id = ?, confirmed_by = ?, confirmed_at = ?,
          rejected_at = ?, next_attempt_at = ?, last_error = NULL, updated_at = ?
      WHERE id = ? AND status = 'awaiting_confirmation'
    `).run(
      nextStatus,
      input.externalMessageId || input.messageId,
      senderId,
      parsed.decision === 'approve' ? decidedAt : null,
      parsed.decision === 'reject' ? decidedAt : null,
      parsed.decision === 'approve' ? decidedAt : null,
      decidedAt,
      proposal.id,
    );
    if (!result.changes) return false;
    audit(
      parsed.decision === 'approve' ? 'contador_financial_proposal_confirmed' : 'contador_financial_proposal_rejected',
      proposal,
      { actorUserId, decision: parsed.decision },
    );
    return true;
  })();
  if (!updated) return { handled: true, duplicate: true, reply: 'A proposta já foi encerrada.' };
  return {
    handled: true,
    confirmed: parsed.decision === 'approve',
    rejected: parsed.decision === 'reject',
    proposalId: proposal.id,
    reply: parsed.decision === 'approve'
      ? 'Confirmação aceita. A classificação será gravada de forma idempotente.'
      : 'Proposta recusada. Nenhuma classificação foi aplicada.',
  };
}

async function sendFinancialApprovalAcknowledgement(input, text) {
  const senderId = normalizePhone(input?.senderId);
  if (!featureEnabled() || !senderId || !CONTADOR_FINANCIAL_APPROVAL_ALLOWED_SENDER_IDS.includes(senderId)) {
    return { sent: false, reason: 'sender_not_allowed' };
  }
  const result = await sendTextImpl(input.instance || 'turbostation', senderId, text);
  const createdAt = currentIso();
  db.prepare(`
    INSERT INTO messages
      (id, conversation_id, brand_id, direction, source, body, external_message_id,
       media_json, delivery_status, created_at)
    VALUES (?, ?, ?, 'outbound', 'contador', ?, ?, ?, 'sent', ?)
  `).run(
    randomId('msg'),
    input.conversationId,
    input.brandId,
    text,
    result?.key?.id || null,
    JSON.stringify({ contador: { kind: 'financial_approval_status' } }),
    createdAt,
  );
  db.prepare(`
    UPDATE conversations SET last_message_at = ?, last_outbound_at = ?, updated_at = ? WHERE id = ?
  `).run(createdAt, createdAt, createdAt, input.conversationId);
  return { sent: true, externalMessageId: result?.key?.id || null };
}

function compatibleClassification(existing, proposal) {
  return existing.proposal_id === proposal.id
    && existing.payload_hash === proposal.payload_hash
    && existing.action_payload_json === proposal.action_payload_json;
}

function executeProposal(proposal) {
  const claimedAt = currentIso();
  const claimed = db.transaction(() => {
    const result = db.prepare(`
      UPDATE contador_financial_proposals
      SET status = 'executing', execution_attempts = execution_attempts + 1, updated_at = ?
      WHERE id = ? AND status IN ('confirmed','execution_retry')
        AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
    `).run(claimedAt, proposal.id, claimedAt);
    if (result.changes) audit('contador_financial_execution_started', proposal, { actorUserId: `whatsapp:${proposal.confirmed_by}` });
    return result.changes === 1;
  })();
  if (!claimed) return;

  const current = db.prepare('SELECT * FROM contador_financial_proposals WHERE id = ?').get(proposal.id);
  try {
    if (sha256(current.action_payload_json) !== current.payload_hash) {
      throw Object.assign(new Error('immutable_payload_hash_mismatch'), { terminal: true });
    }
    const payload = JSON.parse(current.action_payload_json);
    if (payload.action !== 'classify_expense' || !ALLOWED_CATEGORIES.has(payload.category)) {
      throw Object.assign(new Error('immutable_action_not_allowed'), { terminal: true });
    }

    db.transaction(() => {
      const existing = db.prepare(`
        SELECT * FROM contador_financial_classifications WHERE source_message_id = ?
      `).get(current.source_message_id);
      if (existing && !compatibleClassification(existing, current)) {
        throw Object.assign(new Error('classification_idempotency_conflict'), { terminal: true });
      }
      if (!existing) {
        db.prepare(`
          INSERT INTO contador_financial_classifications
            (source_message_id, proposal_id, brand_id, action_type, action_payload_json,
             payload_hash, classified_by, classified_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          current.source_message_id,
          current.id,
          current.brand_id,
          current.action_type,
          current.action_payload_json,
          current.payload_hash,
          `whatsapp:${current.confirmed_by}`,
          currentIso(),
        );
      }
      const executedAt = currentIso();
      db.prepare(`
        UPDATE contador_financial_proposals
        SET status = 'executed', executed_at = ?, next_attempt_at = NULL,
            last_error = NULL, updated_at = ?
        WHERE id = ? AND status = 'executing'
      `).run(executedAt, executedAt, current.id);
      audit('contador_financial_execution_completed', current, {
        actorUserId: `whatsapp:${current.confirmed_by}`,
        idempotentReplay: Boolean(existing),
      });
    })();
  } catch (error) {
    const attempts = Number(current.execution_attempts || 1);
    const terminal = error?.terminal === true || attempts >= EXECUTION_MAX_ATTEMPTS;
    db.prepare(`
      UPDATE contador_financial_proposals
      SET status = ?, next_attempt_at = ?, last_error = ?, updated_at = ?
      WHERE id = ? AND status = 'executing'
    `).run(
      terminal ? 'failed_execution' : 'execution_retry',
      terminal ? null : nextRetryIso(attempts),
      safeError(error),
      currentIso(),
      current.id,
    );
    audit('contador_financial_execution_failed', current, {
      actorUserId: `whatsapp:${current.confirmed_by}`,
      terminal,
      attempts,
      reason: safeError(error),
    });
  }
}

async function processFinancialApprovalWork() {
  if (!featureEnabled() || workerBusy) return;
  workerBusy = true;
  try {
    const now = currentIso();
    const expiring = db.prepare(`
      SELECT * FROM contador_financial_proposals
      WHERE status IN ('pending_send','retry_send','waiting_config','awaiting_confirmation')
        AND expires_at <= ?
    `).all(now);
    for (const proposal of expiring) expireProposal(proposal);

    const sendable = db.prepare(`
      SELECT * FROM contador_financial_proposals
      WHERE status IN ('pending_send','retry_send','waiting_config')
        AND expires_at > ?
        AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
      ORDER BY created_at ASC LIMIT 10
    `).all(now, now);
    for (const proposal of sendable) await sendProposal(proposal);

    const executable = db.prepare(`
      SELECT * FROM contador_financial_proposals
      WHERE status IN ('confirmed','execution_retry')
        AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
      ORDER BY created_at ASC LIMIT 10
    `).all(now);
    for (const proposal of executable) executeProposal(proposal);
  } finally {
    workerBusy = false;
  }
}

function recoverInterruptedFinancialApprovalWork() {
  if (!featureEnabled()) return;
  const recoveredAt = currentIso();
  db.transaction(() => {
    const interruptedSends = db.prepare(`
      SELECT * FROM contador_financial_proposals WHERE status = 'sending'
    `).all();
    db.prepare(`
      UPDATE contador_financial_proposals
      SET status = 'delivery_unknown', next_attempt_at = NULL,
          last_error = 'interrupted_during_proposal_send', updated_at = ?
      WHERE status = 'sending'
    `).run(recoveredAt);
    for (const proposal of interruptedSends) {
      audit('contador_financial_proposal_send_failed', proposal, {
        reason: 'interrupted_delivery_unknown',
      });
    }

    const interruptedExecutions = db.prepare(`
      SELECT * FROM contador_financial_proposals WHERE status = 'executing'
    `).all();
    db.prepare(`
      UPDATE contador_financial_proposals
      SET status = 'execution_retry', next_attempt_at = ?,
          last_error = 'interrupted_during_local_classification', updated_at = ?
      WHERE status = 'executing'
    `).run(recoveredAt, recoveredAt);
    for (const proposal of interruptedExecutions) {
      audit('contador_financial_execution_failed', proposal, {
        actorUserId: proposal.confirmed_by ? `whatsapp:${proposal.confirmed_by}` : null,
        terminal: false,
        reason: 'interrupted_retry_scheduled',
      });
    }
  })();
}

function _setFinancialApprovalTestHooks(hooks = {}) {
  if (hooks.sendText) sendTextImpl = hooks.sendText;
  if (hooks.now) nowProvider = hooks.now;
}

module.exports = {
  featureEnabled,
  configurationReady,
  queueFinancialApprovalProposal,
  handleFinancialApprovalReply,
  sendFinancialApprovalAcknowledgement,
  processFinancialApprovalWork,
  recoverInterruptedFinancialApprovalWork,
  formatProposalMessage,
  exactDecision,
  _setFinancialApprovalTestHooks,
};
