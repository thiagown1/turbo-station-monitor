#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { estimateCost, extractFinancialFields, extractEnergyBill } = require('../lib/agent-media-classifier');
const { parseExpenseDecision, parseExpenseBrlAmount } = require('../lib/expense-decision');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (error) { failed++; console.error(`  ✗ ${name}\n    ${error.message}`); }
}

console.log('\n🧪 central agent router\n');

test('uses provider-reported cost when OpenRouter returns it', () => {
  assert.equal(estimateCost({ prompt_tokens: 1000, completion_tokens: 200, cost: 0.00123 }), 0.00123);
});

test('falls back to configured token rates when provider cost is absent', () => {
  process.env.AGENT_INPUT_USD_PER_MILLION = '0.15';
  process.env.AGENT_OUTPUT_USD_PER_MILLION = '0.60';
  assert.equal(estimateCost({ prompt_tokens: 1_000_000, completion_tokens: 1_000_000 }), 0.75);
});

test('does not invent a BRL value for a foreign-currency charge', () => {
  assert.deepEqual(extractFinancialFields({ currency: 'USD', original_amount: 'US$ 200.00', amount: 'US$ 200.00', settled_brl_amount: null }), {
    currency: 'USD', originalAmountMinor: 20000, amountCents: undefined,
  });
  assert.equal(extractFinancialFields({ currency: 'USD', original_amount: 'US$ 200.00', settled_brl_amount: 'R$ 1.120,35' }).amountCents, 112035);
});

test('normalizes energy invoice vision fields and rejects implausible tariffs', () => {
  assert.deepEqual(extractEnergyBill({
    kind: 'energy_invoice',
    energy_bill: {
      distributor: 'equatorial_go', uc: '4.397.850.012-06', ref_period: { year: 2026, month: 5 },
      due_date: '2026-05-28', kwh_nao_compensado: '6.173', tarifa_nao_compensada: '0,774023',
      kwh_compensado: null, tarifa_scee: 99, tarifa_sem_tributos_nao_compensada: '0,62',
      tarifa_sem_tributos: '0.774', total_brl: 'R$ 135,07',
    },
  }), {
    distributor: 'equatorial_go', uc: '4.397.850.012-06', refPeriod: { year: 2026, month: 5 },
    dueDate: '2026-05-28', kwhNaoCompensado: 6173, tarifaNaoCompensada: 0.774023,
    kwhCompensado: null, tarifaScee: null, tarifaSemTributosNaoCompensada: 0.62,
    tarifaSemTributos: 0.774, totalCents: 13507,
  });
  assert.equal(extractEnergyBill({ kind: 'expense_receipt' }), undefined);
});

test('parses only explicit expense decisions and gives recurrence precedence', () => {
  assert.equal(parseExpenseDecision('1'), 'register_once');
  assert.equal(parseExpenseDecision('registrar recorrente mensal'), 'register_monthly');
  assert.equal(parseExpenseDecision('3 - ignorar'), 'reject');
  assert.equal(parseExpenseDecision('acho que sim talvez'), null);
  assert.equal(parseExpenseBrlAmount('valor R$ 1.120,35'), 112035);
  assert.equal(parseExpenseBrlAmount('sim'), undefined);
});

test('requires the cited expense code and an allowlisted sender before posting a decision', () => {
  const dbPath = path.join(os.tmpdir(), `agent-decision-${process.pid}-${Date.now()}.sqlite`);
  try {
    const output = execFileSync(process.execPath, ['-e', `
      (async () => {
        process.env.SUPPORT_COPILOT_DB_PATH = ${JSON.stringify(dbPath)};
        process.env.AGENT_EVENT_BASE_URL = 'https://dashboard.test';
        process.env.AGENT_EVENT_SECRET = 'test-secret';
        let decisionCalls = 0;
        global.fetch = async (url, init) => {
          if (String(url).includes('/api/agents/config')) return { ok: true, json: async () => ({ config: { enabled: true, whatsappExpenseConfirmationEnabled: true, accountingGroupConversationIds: ['conv1'], allowedAccountingDecisionSenderIds: ['5511999999999'], agents: { accounting: true } } }) };
          if (String(url).includes('/api/agents/expense-decisions')) { decisionCalls++; return { ok: true, json: async () => ({ ok: true }) }; }
          throw new Error('unexpected URL ' + url);
        };
        const router = require('./lib/agent-router');
        const missingQuote = await router.routeExpenseDecisionReply({ brandId: 'turbo_station', conversationId: 'conv1', senderId: '5511999999999', body: '2', quotedBody: 'sem codigo', messageId: 'm1' });
        const denied = await router.routeExpenseDecisionReply({ brandId: 'turbo_station', conversationId: 'conv1', senderId: '5511888888888', body: '2', quotedBody: 'Código EXP-A1B2C3D4', messageId: 'm2' });
        const allowed = await router.routeExpenseDecisionReply({ brandId: 'turbo_station', conversationId: 'conv1', senderId: '5511999999999', body: 'registrar recorrente', quotedBody: 'Código EXP-A1B2C3D4', messageId: 'm3' });
        if (missingQuote.handled) throw new Error('uncited reply was handled');
        if (!denied.handled || !denied.reply.includes('não está autorizado')) throw new Error('unauthorized sender not blocked');
        if (!allowed.handled || decisionCalls !== 1) throw new Error('allowed decision not posted exactly once');
        console.log('agent-decision-ok');
      })().catch(e => { console.error(e); process.exit(1); });
    `], { cwd: path.join(__dirname, '..'), env: { ...process.env, SUPPORT_COPILOT_DB_PATH: dbPath }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    assert.ok(output.includes('agent-decision-ok'));
  } finally {
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
  }
});

test('classifies once, caches the receipt and durably delivers one event', () => {
  const dbPath = path.join(os.tmpdir(), `agent-router-${process.pid}-${Date.now()}.sqlite`);
  try {
    const output = execFileSync(process.execPath, ['-e', `
      (async () => {
        process.env.SUPPORT_COPILOT_DB_PATH = ${JSON.stringify(dbPath)};
        process.env.AGENT_EVENT_BASE_URL = 'https://dashboard.test';
        process.env.AGENT_EVENT_SECRET = 'test-secret';
        process.env.OPENROUTER_API_KEY = 'test-openrouter';
        const calls = { config: 0, model: 0, event: 0 };
        global.fetch = async (url, init) => {
          if (String(url).includes('/api/agents/config')) {
            calls.config++;
            return { ok: true, json: async () => ({ config: { enabled: true, model: 'openai/gpt-4o-mini', dailyGeneralAnalysisLimit: 100, accountingGroupConversationIds: ['conv1'], agents: { accounting: true } } }) };
          }
          if (String(url).includes('openrouter.ai')) {
            calls.model++;
            return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ kind: 'expense_receipt', summary: 'PIX para fornecedor', confidence: 0.99, needs_attention: true, amount: 'R$ 123,45', transaction_id: 'E2E-1', payee: 'Fornecedor X', suggested_category: 'operacional', suggested_reply: null }) } }], usage: { prompt_tokens: 900, completion_tokens: 80, cost: 0.00019 } }) };
          }
          if (String(url).includes('/api/agents/events')) {
            calls.event++;
            const payload = JSON.parse(init.body);
            if (payload.senderId !== '5561999999999') throw new Error('sender identity lost');
            return { ok: true, status: 202, text: async () => '{"ok":true}' };
          }
          throw new Error('unexpected URL ' + url);
        };
        const { db, nowIso } = require('./lib/db');
        const now = nowIso();
        db.prepare("INSERT INTO conversations (id, brand_id, channel, customer_phone, status, created_at, updated_at) VALUES ('conv1','turbo_station','whatsapp-group','group@g.us','open',?,?)").run(now, now);
        db.prepare("INSERT INTO messages (id, conversation_id, brand_id, direction, source, body, external_message_id, sender_id, created_at) VALUES ('msg1','conv1','turbo_station','inbound','evolution','[Yves]: pago','WA-1','5561999999999',?)").run(now);
        const router = require('./lib/agent-router');
        const input = { messageId: 'msg1', externalMessageId: 'WA-1', conversationId: 'conv1', brandId: 'turbo_station', groupJid: 'group@g.us', senderId: '5561999999999', body: '[Yves]: pago', media: null, receivedAt: now };
        const first = await router.routeInboundMessage(input);
        await router.deliverDueEvents();
        const second = await router.routeInboundMessage(input);
        const analysis = db.prepare('SELECT * FROM agent_media_analyses WHERE message_id = ?').get('msg1');
        const receipt = db.prepare('SELECT * FROM receipt_extractions WHERE message_id = ?').get('msg1');
        const outbox = db.prepare('SELECT * FROM agent_event_outbox WHERE message_id = ?').get('msg1');
        if (first.kind !== 'expense_receipt') throw new Error('wrong classification');
        if (!second.duplicate) throw new Error('second processing was not idempotent');
        if (analysis.estimated_cost_usd !== 0.00019) throw new Error('cost not persisted');
        if (receipt.amount_cents !== 12345) throw new Error('receipt cache not populated');
        if (outbox.status !== 'delivered') throw new Error('outbox not delivered: ' + JSON.stringify(outbox));
        if (calls.model !== 1 || calls.event !== 1) throw new Error('unexpected paid/delivery calls: ' + JSON.stringify(calls));
        console.log('agent-router-ok');
      })().catch(e => { console.error(e); process.exit(1); });
    `], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, SUPPORT_COPILOT_DB_PATH: dbPath }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.ok(output.includes('agent-router-ok'));
  } finally {
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
  }
});

test('defers an energy invoice to Contador with structured fields and no duplicate generic event', () => {
  const dbPath = path.join(os.tmpdir(), `agent-router-energy-${process.pid}-${Date.now()}.sqlite`);
  try {
    const output = execFileSync(process.execPath, ['-e', `
      (async () => {
        process.env.SUPPORT_COPILOT_DB_PATH = ${JSON.stringify(dbPath)};
        process.env.AGENT_EVENT_BASE_URL = 'https://dashboard.test';
        process.env.AGENT_EVENT_SECRET = 'test-secret';
        process.env.OPENROUTER_API_KEY = 'test-openrouter';
        let eventCalls = 0;
        global.fetch = async (url) => {
          if (String(url).includes('/api/agents/config')) return { ok: true, json: async () => ({ config: { enabled: true, model: 'openai/gpt-4o-mini', accountingGroupConversationIds: ['conv1'], agents: { accounting: true } } }) };
          if (String(url).includes('openrouter.ai')) return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ kind: 'energy_invoice', summary: 'Conta Equatorial', confidence: 0.99, needs_attention: true, energy_bill: { distributor: 'equatorial_go', uc: '1234', ref_period: { year: 2026, month: 7 }, due_date: '2026-08-10', kwh_nao_compensado: 812, tarifa_nao_compensada: 0.75, kwh_compensado: null, tarifa_scee: null, tarifa_sem_tributos_nao_compensada: 0.6, tarifa_sem_tributos: null, total_brl: 'R$ 609,00' } }) } }], usage: {} }) };
          if (String(url).includes('/api/agents/events')) { eventCalls++; return { ok: true, status: 202, text: async () => '{}' }; }
          throw new Error('unexpected URL ' + url);
        };
        const { db, nowIso } = require('./lib/db');
        const now = nowIso();
        const router = require('./lib/agent-router');
        const result = await router.routeInboundMessage({ messageId: 'energy-1', conversationId: 'conv1', brandId: 'turbo_station', body: 'conta de energia', receivedAt: now, deferEnergyInvoiceEvent: true });
        await router.deliverDueEvents();
        const outbox = db.prepare('SELECT COUNT(*) count FROM agent_event_outbox').get();
        if (!result.eventDeferred || result.energyBill.kwhNaoCompensado !== 812) throw new Error('energy extraction not deferred');
        if (outbox.count !== 0 || eventCalls !== 0) throw new Error('generic event was duplicated');
        console.log('energy-deferred-ok');
      })().catch(e => { console.error(e); process.exit(1); });
    `], { cwd: path.join(__dirname, '..'), env: { ...process.env, SUPPORT_COPILOT_DB_PATH: dbPath }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    assert.ok(output.includes('energy-deferred-ok'));
  } finally {
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
  }
});

test('does not spend a model call on partner media from a non-allowlisted sender', () => {
  const dbPath = path.join(os.tmpdir(), `agent-router-sender-${process.pid}-${Date.now()}.sqlite`);
  try {
    const output = execFileSync(process.execPath, ['-e', `
      (async () => {
        process.env.SUPPORT_COPILOT_DB_PATH = ${JSON.stringify(dbPath)};
        process.env.AGENT_EVENT_BASE_URL = 'https://dashboard.test';
        process.env.AGENT_EVENT_SECRET = 'test-secret';
        process.env.OPENROUTER_API_KEY = 'test-openrouter';
        const calls = { model: 0 };
        global.fetch = async (url) => {
          if (String(url).includes('/api/agents/config')) {
            return { ok: true, json: async () => ({ config: {
              enabled: true,
              model: 'openai/gpt-4o-mini',
              dailyGeneralAnalysisLimit: 100,
              allowedPartnerReceiptSenderIds: ['5511999999999'],
              accountingGroupConversationIds: [],
              agents: { partnerReceipts: true, supportTriage: false },
            } }) };
          }
          if (String(url).includes('openrouter.ai')) {
            calls.model++;
            return { ok: true, json: async () => ({
              choices: [{ message: { content: JSON.stringify({
                kind: 'partner_payment_receipt', summary: 'PIX', confidence: 0.99,
                needs_attention: true, amount: 'R$ 10,00', transaction_id: 'E2E-SENDER',
              }) } }],
              usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.00001 },
            }) };
          }
          if (String(url).includes('/api/agents/events')) {
            return { ok: true, status: 202, text: async () => '{"ok":true}' };
          }
          throw new Error('unexpected URL ' + url);
        };
        const { db, nowIso } = require('./lib/db');
        const now = nowIso();
        db.prepare("INSERT INTO conversations (id, brand_id, channel, customer_phone, status, created_at, updated_at) VALUES ('conv1','turbo_station','whatsapp-group','group@g.us','open',?,?)").run(now, now);
        db.prepare("INSERT INTO group_partner_links (group_jid, partner_id, partner_user_id, enabled, linked_at) VALUES ('group@g.us','partner-1','partner-user-1',1,?)").run(now);
        const router = require('./lib/agent-router');
        const denied = await router.routeInboundMessage({
          messageId: 'msg-denied', conversationId: 'conv1', brandId: 'turbo_station',
          groupJid: 'group@g.us', senderId: '5511888888888', body: '[Outro]: [imagem]',
          media: { media_type: 'image', url: '/api/support/media/not-read.jpg' }, receivedAt: now,
        });
        if (denied.skipped !== 'no_enabled_agent') throw new Error('non-allowlisted sender was not skipped');
        if (calls.model !== 0) throw new Error('paid model called for non-allowlisted sender');
        const allowed = await router.routeInboundMessage({
          messageId: 'msg-allowed', conversationId: 'conv1', brandId: 'turbo_station',
          groupJid: 'group@g.us', senderId: '5511999999999', body: '[Yves]: comprovante PIX',
          media: null, receivedAt: now,
        });
        if (allowed.kind !== 'partner_payment_receipt' || calls.model !== 1) {
          throw new Error('allowlisted sender was not classified exactly once');
        }
        console.log('agent-sender-filter-ok');
      })().catch(e => { console.error(e); process.exit(1); });
    `], { cwd: path.join(__dirname, '..'), env: { ...process.env, SUPPORT_COPILOT_DB_PATH: dbPath }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    assert.ok(output.includes('agent-sender-filter-ok'));
  } finally {
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
  }
});

test('station requests use the tool-backed support suggestion and still require central review', () => {
  const dbPath = path.join(os.tmpdir(), `agent-router-station-${process.pid}-${Date.now()}.sqlite`);
  try {
    const output = execFileSync(process.execPath, ['-e', `
      (async () => {
        process.env.SUPPORT_COPILOT_DB_PATH = ${JSON.stringify(dbPath)};
        process.env.AGENT_EVENT_BASE_URL = 'https://dashboard.test';
        process.env.AGENT_EVENT_SECRET = 'test-secret';
        process.env.OPENROUTER_API_KEY = 'test-openrouter';
        global.fetch = async (url, init) => {
          if (String(url).includes('/api/agents/config')) return { ok: true, json: async () => ({ config: { enabled: true, model: 'openai/gpt-4o-mini', dailyGeneralAnalysisLimit: 100, accountingGroupConversationIds: [], agents: { stationSupport: true } } }) };
          if (String(url).includes('openrouter.ai')) return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ kind: 'station_support', summary: 'Carregador offline', confidence: 0.97, needs_attention: true, amount: null, transaction_id: null, payee: null, suggested_category: null, suggested_reply: 'resposta rasa' }) } }], usage: { prompt_tokens: 500, completion_tokens: 60, cost: 0.0001 } }) };
          if (String(url).includes('/api/agents/events')) {
            const payload = JSON.parse(init.body);
            if (payload.suggestedReply !== 'Diagnóstico confirmado pelas ferramentas.') throw new Error('did not publish deep suggestion: ' + JSON.stringify(payload));
            return { ok: true, status: 202, text: async () => '{"ok":true}' };
          }
          throw new Error('unexpected URL ' + url);
        };
        const { db, nowIso } = require('./lib/db');
        const now = nowIso();
        db.prepare("INSERT INTO conversations (id, brand_id, channel, customer_phone, status, created_at, updated_at) VALUES ('conv1','turbo_station','whatsapp-group','group@g.us','open',?,?)").run(now, now);
        db.prepare("INSERT INTO messages (id, conversation_id, brand_id, direction, source, body, external_message_id, sender_id, created_at) VALUES ('msg1','conv1','turbo_station','inbound','evolution','[Parceiro]: carregador offline','WA-2','5561999999999',?)").run(now);
        db.prepare("INSERT INTO group_partner_links (group_jid, partner_id, partner_user_id, enabled, linked_at) VALUES ('group@g.us','partner-1','partner-user-1',1,?)").run(now);
        require.cache[require.resolve('./lib/copilot')] = { exports: { generateSuggestion: async () => ({ text: 'Diagnóstico confirmado pelas ferramentas.', model: 'openclaw/support' }) } };
        const router = require('./lib/agent-router');
        const result = await router.routeInboundMessage({ messageId: 'msg1', externalMessageId: 'WA-2', conversationId: 'conv1', brandId: 'turbo_station', groupJid: 'group@g.us', senderId: '5561999999999', body: '[Parceiro]: carregador offline', media: null, receivedAt: now });
        await router.deliverDueEvents();
        const suggestion = db.prepare("SELECT * FROM suggestions WHERE conversation_id = 'conv1'").get();
        if (result.suggestedReply !== 'Diagnóstico confirmado pelas ferramentas.') throw new Error('deep result missing');
        if (!suggestion || suggestion.status !== 'pending') throw new Error('human support suggestion missing');
        console.log('agent-station-ok');
      })().catch(e => { console.error(e); process.exit(1); });
    `], { cwd: path.join(__dirname, '..'), env: { ...process.env, SUPPORT_COPILOT_DB_PATH: dbPath }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    assert.ok(output.includes('agent-station-ok'));
  } finally {
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
  }
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
