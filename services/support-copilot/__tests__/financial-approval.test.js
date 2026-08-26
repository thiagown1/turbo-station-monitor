'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, beforeEach, test } = require('node:test');

const dbPath = path.join(os.tmpdir(), `financial-approval-${process.pid}-${Date.now()}.sqlite`);
process.env.SUPPORT_COPILOT_DB_PATH = dbPath;
process.env.CONTADOR_FINANCIAL_APPROVAL_ENABLED = 'true';
process.env.CONTADOR_FINANCIAL_APPROVAL_OPERATOR_JID = '5511999999999@s.whatsapp.net';
process.env.CONTADOR_FINANCIAL_APPROVAL_ALLOWED_SENDER_IDS = '5511999999999';
process.env.CONTADOR_FINANCIAL_APPROVAL_TTL_MINUTES = '15';

const { db } = require('../lib/db');
const approval = require('../lib/financial-approval');

let clock;
let sends;

function resetState() {
  db.exec(`
    DROP TRIGGER IF EXISTS fail_financial_classification;
    DELETE FROM contador_financial_classifications;
    DELETE FROM contador_financial_proposals;
    DELETE FROM agent_event_outbox;
    DELETE FROM agent_media_analyses;
    DELETE FROM receipt_extractions;
    DELETE FROM messages;
    DELETE FROM conversations;
    DELETE FROM audit_log;
  `);
  clock = new Date('2026-08-26T12:00:00.000Z');
  sends = [];
  approval._setFinancialApprovalTestHooks({
    now: () => new Date(clock),
    sendText: async (instance, target, text) => {
      sends.push({ instance, target, text });
      return { key: { id: `wa-proposal-${sends.length}` } };
    },
  });
}

function eventPayload(sourceMessageId = 'WA-RECEIPT-1') {
  return {
    brandId: 'turbo_station',
    kind: 'expense_receipt',
    sourceMessageId,
    conversationId: 'conv-accounting',
    senderId: '5561991111111',
    receivedAt: '2026-08-26T11:59:00.000Z',
    summary: 'Pagamento do empréstimo identificado no comprovante',
    confidence: 0.98,
    needsAttention: true,
    amountCents: 15000,
    currency: 'BRL',
    receiptRef: 'receipt-reference',
    payee: 'Fornecedor de teste',
    suggestedCategory: 'emprestimos',
  };
}

async function createSentProposal(sourceMessageId = 'WA-RECEIPT-1') {
  const queued = approval.queueFinancialApprovalProposal({
    sourceMessageId,
    sourceConversationId: 'conv-accounting',
    instance: 'turbostation',
    eventPayload: eventPayload(sourceMessageId),
  });
  assert.equal(queued.handled, true);
  await approval.processFinancialApprovalWork();
  const proposal = db.prepare('SELECT * FROM contador_financial_proposals WHERE id = ?').get(queued.proposalId);
  assert.equal(proposal.status, 'awaiting_confirmation');
  assert.equal(sends.length, 1);
  assert.equal(sends[0].target, '5511999999999@s.whatsapp.net');
  assert.equal(sends[0].text.includes(`APROVAR ${proposal.proposal_code}`), true);
  return proposal;
}

function decisionInput(proposal, overrides = {}) {
  return {
    messageId: 'msg-confirm-1',
    externalMessageId: 'wa-confirm-1',
    conversationId: 'conv-operator',
    brandId: 'turbo_station',
    instance: 'turbostation',
    senderId: '5511999999999',
    body: `APROVAR ${proposal.proposal_code}`,
    quotedMessageId: proposal.outbound_message_id,
    ...overrides,
  };
}

function actions() {
  return db.prepare('SELECT action FROM audit_log ORDER BY created_at, rowid').all().map((row) => row.action);
}

beforeEach(resetState);

test('valid personal approval applies the immutable classification exactly once', async () => {
  const proposal = await createSentProposal();
  assert.equal(db.prepare('SELECT COUNT(*) count FROM contador_financial_classifications').get().count, 0);

  const confirmation = approval.handleFinancialApprovalReply(decisionInput(proposal));
  assert.equal(confirmation.confirmed, true);
  await approval.processFinancialApprovalWork();

  const completed = db.prepare('SELECT status, confirmed_by FROM contador_financial_proposals WHERE id = ?').get(proposal.id);
  const classification = db.prepare('SELECT * FROM contador_financial_classifications WHERE source_message_id = ?').get(proposal.source_message_id);
  assert.deepEqual(completed, { status: 'executed', confirmed_by: '5511999999999' });
  assert.equal(classification.proposal_id, proposal.id);
  assert.equal(classification.payload_hash, proposal.payload_hash);
  assert.equal(JSON.parse(classification.action_payload_json).category, 'emprestimos');
  assert.equal(db.prepare('SELECT COUNT(*) count FROM agent_event_outbox').get().count, 0);
  assert.deepEqual(actions(), [
    'contador_financial_proposal_created',
    'contador_financial_proposal_sent',
    'contador_financial_proposal_confirmed',
    'contador_financial_execution_started',
    'contador_financial_execution_completed',
  ]);
});

test('fresh expense detection creates a personal proposal and withholds the central event', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes('/api/agents/config')) {
      return {
        ok: true,
        json: async () => ({
          config: {
            enabled: true,
            model: 'openai/gpt-4o-mini',
            accountingGroupConversationIds: ['conv-accounting'],
            agents: { accounting: true },
          },
        }),
      };
    }
    if (String(url).includes('openrouter.ai')) {
      return {
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              content: JSON.stringify({
                kind: 'expense_receipt',
                summary: 'Pagamento do empréstimo',
                confidence: 0.99,
                needs_attention: true,
                amount: 'R$ 150,00',
                currency: 'BRL',
                payee: 'Fornecedor de teste',
                suggested_category: 'emprestimos',
              }),
            },
          }],
          usage: {},
        }),
      };
    }
    throw new Error(`unexpected network call: ${url}`);
  };
  process.env.AGENT_EVENT_BASE_URL = 'https://dashboard.test';
  process.env.AGENT_EVENT_SECRET = 'test-secret';
  process.env.OPENROUTER_API_KEY = 'test-model-key';
  try {
    const router = require('../lib/agent-router');
    const result = await router.routeInboundMessage({
      messageId: 'msg-fresh-expense',
      externalMessageId: 'WA-FRESH-EXPENSE',
      conversationId: 'conv-accounting',
      brandId: 'turbo_station',
      groupJid: 'accounting@g.us',
      instance: 'turbostation',
      senderId: '5561991111111',
      body: 'comprovante de pagamento do empréstimo',
      receivedAt: '2026-08-26T11:59:00.000Z',
    });
    await new Promise((resolve) => setImmediate(resolve));
    await approval.processFinancialApprovalWork();

    assert.equal(result.kind, 'expense_receipt');
    assert.equal(result.financialApprovalQueued, true);
    assert.equal(db.prepare('SELECT COUNT(*) count FROM contador_financial_proposals').get().count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) count FROM contador_financial_classifications').get().count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) count FROM agent_event_outbox').get().count, 0);
  } finally {
    global.fetch = originalFetch;
  }
});

test('enabling the flow does not turn a cached historical receipt into a proposal', async () => {
  const resultJson = JSON.stringify({
    status: 'ok',
    kind: 'expense_receipt',
    summary: 'Comprovante histórico',
    confidence: 0.99,
    amountCents: 10000,
    suggestedCategory: 'emprestimos',
  });
  db.prepare(`
    INSERT INTO agent_media_analyses
      (message_id, conversation_id, brand_id, kind, status, result_json, attempts, analyzed_at)
    VALUES ('msg-historical', 'conv-accounting', 'turbo_station', 'expense_receipt', 'ok', ?, 1, ?)
  `).run(resultJson, '2026-08-01T12:00:00.000Z');
  const router = require('../lib/agent-router');
  const result = await router.routeInboundMessage({
    messageId: 'msg-historical',
    externalMessageId: 'WA-HISTORICAL',
    conversationId: 'conv-accounting',
    brandId: 'turbo_station',
    groupJid: 'accounting@g.us',
    instance: 'turbostation',
    senderId: '5561991111111',
    body: 'comprovante histórico',
    receivedAt: '2026-08-01T12:00:00.000Z',
  });

  assert.equal(result.duplicate, true);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM contador_financial_proposals').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM agent_event_outbox').get().count, 0);
});

test('explicit refusal closes the proposal without applying a classification', async () => {
  const proposal = await createSentProposal('WA-RECEIPT-REFUSE');
  const refusal = approval.handleFinancialApprovalReply(decisionInput(proposal, {
    externalMessageId: 'wa-refuse-1',
    body: `RECUSAR ${proposal.proposal_code}`,
  }));
  assert.equal(refusal.rejected, true);
  await approval.processFinancialApprovalWork();

  assert.equal(db.prepare('SELECT status FROM contador_financial_proposals WHERE id = ?').get(proposal.id).status, 'rejected');
  assert.equal(db.prepare('SELECT COUNT(*) count FROM contador_financial_classifications').get().count, 0);
  assert.ok(actions().includes('contador_financial_proposal_rejected'));
});

test('duplicate confirmation never repeats the classification', async () => {
  const proposal = await createSentProposal('WA-RECEIPT-DUP');
  approval.handleFinancialApprovalReply(decisionInput(proposal));
  await approval.processFinancialApprovalWork();

  const duplicate = approval.handleFinancialApprovalReply(decisionInput(proposal, {
    messageId: 'msg-confirm-2',
    externalMessageId: 'wa-confirm-2',
  }));
  await approval.processFinancialApprovalWork();

  assert.equal(duplicate.duplicate, true);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM contador_financial_classifications').get().count, 1);
  assert.equal(actions().filter((action) => action === 'contador_financial_execution_completed').length, 1);
});

test('expired proposal rejects approval and remains fail-closed', async () => {
  const proposal = await createSentProposal('WA-RECEIPT-EXPIRED');
  clock = new Date('2026-08-26T12:16:00.000Z');
  const result = approval.handleFinancialApprovalReply(decisionInput(proposal));
  await approval.processFinancialApprovalWork();

  assert.equal(result.reply.includes('expirou'), true);
  assert.equal(db.prepare('SELECT status FROM contador_financial_proposals WHERE id = ?').get(proposal.id).status, 'expired');
  assert.equal(db.prepare('SELECT COUNT(*) count FROM contador_financial_classifications').get().count, 0);
});

test('unauthorized sender is silently rejected and cannot confirm', async () => {
  const proposal = await createSentProposal('WA-RECEIPT-UNAUTHORIZED');
  const result = approval.handleFinancialApprovalReply(decisionInput(proposal, {
    senderId: '5511888888888',
    externalMessageId: 'wa-attacker-1',
  }));
  await approval.processFinancialApprovalWork();

  assert.equal(result.silent, true);
  assert.equal(result.reason, 'sender_not_allowed');
  assert.equal(db.prepare('SELECT status FROM contador_financial_proposals WHERE id = ?').get(proposal.id).status, 'awaiting_confirmation');
  assert.equal(db.prepare('SELECT COUNT(*) count FROM contador_financial_classifications').get().count, 0);
  assert.ok(actions().includes('contador_financial_confirmation_rejected'));
});

test('free-form response is rejected even from an authorized operator', async () => {
  const proposal = await createSentProposal('WA-RECEIPT-FREEFORM');
  const result = approval.handleFinancialApprovalReply(decisionInput(proposal, {
    body: `sim, pode aprovar ${proposal.proposal_code}`,
    externalMessageId: 'wa-freeform-1',
  }));
  await approval.processFinancialApprovalWork();

  assert.equal(result.reply.includes('Use exatamente'), true);
  assert.equal(db.prepare('SELECT status FROM contador_financial_proposals WHERE id = ?').get(proposal.id).status, 'awaiting_confirmation');
  assert.equal(db.prepare('SELECT COUNT(*) count FROM contador_financial_classifications').get().count, 0);
});

test('exact code without the exact quoted proposal is rejected', async () => {
  const proposal = await createSentProposal('WA-RECEIPT-WRONG-QUOTE');
  const result = approval.handleFinancialApprovalReply(decisionInput(proposal, {
    quotedMessageId: 'wa-different-proposal',
    externalMessageId: 'wa-wrong-quote-1',
  }));
  await approval.processFinancialApprovalWork();

  assert.equal(result.reply.includes('não cita a proposta exata'), true);
  assert.equal(db.prepare('SELECT status FROM contador_financial_proposals WHERE id = ?').get(proposal.id).status, 'awaiting_confirmation');
  assert.equal(db.prepare('SELECT COUNT(*) count FROM contador_financial_classifications').get().count, 0);
});

test('classification write failure is audited and retained for bounded retry', async () => {
  const proposal = await createSentProposal('WA-RECEIPT-WRITE-FAIL');
  db.exec(`
    CREATE TRIGGER fail_financial_classification
    BEFORE INSERT ON contador_financial_classifications
    BEGIN
      SELECT RAISE(FAIL, 'forced_write_failure');
    END;
  `);
  approval.handleFinancialApprovalReply(decisionInput(proposal));
  await approval.processFinancialApprovalWork();

  const failed = db.prepare('SELECT status, execution_attempts, last_error, next_attempt_at FROM contador_financial_proposals WHERE id = ?').get(proposal.id);
  assert.equal(failed.status, 'execution_retry');
  assert.equal(failed.execution_attempts, 1);
  assert.equal(failed.last_error, 'forced_write_failure');
  assert.ok(failed.next_attempt_at);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM contador_financial_classifications').get().count, 0);
  assert.ok(actions().includes('contador_financial_execution_failed'));
});

after(() => {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true });
});
