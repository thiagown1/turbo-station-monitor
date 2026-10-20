'use strict';

const { db, nowIso } = require('./db');
const { partnerAssistantPolicy, partnerAssistantOwns, redact } = require('./partner-assistant-runtime');

const TRIAGE_TIMEOUT_MS = 8000;
const INTENTS = new Set(['station_status', 'usage_question', 'revenue_question', 'how_it_works', 'action_request', 'conversation', 'other']);

async function runPartnerTriage(input, config, deps) {
  const policy = partnerAssistantPolicy(config, input.conversationId);
  if (!policy || policy.triageMode === 'off' || input.direction !== 'inbound') return;
  if (!input.messageId || input.messageId.length > 128 || input.whatsappContext?.mentionedJids?.length) return;
  if (partnerAssistantOwns(input.messageId)) return;
  const text = redact(input.body).trim().slice(0, 2000);
  const base = String(process.env.AGENT_EVENT_BASE_URL || '').replace(/\/$/, '');
  const secret = process.env.PARTNER_AGENT_SECRET;
  if (!text || !base || !secret) return;

  // Reserve before HTTP, including failures: a replay/restart must never pay twice.
  // No retry worker: a crash after reservation can intentionally lose this shadow sample.
  const inserted = db.prepare(`INSERT OR IGNORE INTO partner_assistant_triage
      (message_id, conversation_id, brand_id, created_at) VALUES (?, ?, ?, ?)`)
    .run(input.messageId, input.conversationId, input.brandId, nowIso());
  if (inserted.changes !== 1) return;

  const response = await (deps.request || fetch)(`${base}/api/agents/partner-triage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
    body: JSON.stringify({
      brandId: input.brandId,
      subject: { type: 'whatsapp_group', conversationId: input.conversationId },
      message: { text, messageId: input.messageId },
    }),
    signal: AbortSignal.timeout(TRIAGE_TIMEOUT_MS),
  });
  if (!response.ok) return;
  const result = await response.json();
  if (!result || result.ok !== true || !['off', 'shadow', 'active'].includes(result.mode)
      || !['answer', 'forward', 'silent'].includes(result.decision) || typeof result.act !== 'boolean'
      || !(result.intent === null || INTENTS.has(result.intent))
      || !(result.confidence === null || (typeof result.confidence === 'number' && Number.isFinite(result.confidence)
        && result.confidence >= 0 && result.confidence <= 1))) return;

  // Deliberately shadow-only, EVEN for active/act=true. Enabling replies or hand-offs
  // needs a separate implementation/release; never create assistant jobs or reviews here.
  (deps.log || (row => console.log('[partner-triage]', JSON.stringify(row))))({
    brandId: input.brandId, conversationId: input.conversationId, messageId: input.messageId,
    decision: result.decision, intent: result.intent, confidence: result.confidence,
  });
}

/** No HTTP/SQLite work on the ingest stack; all failures stay inside this task. */
function schedulePartnerTriage(input, config, deps = {}) {
  setImmediate(() => {
    // Never log raw network errors/bodies: they may echo message text or credentials.
    void runPartnerTriage(input, config, deps).catch(() => {});
  });
}

module.exports = { schedulePartnerTriage };
