#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  estimateCost,
  extractFinancialFields,
  extractEnergyBill,
  isProviderUnavailableStatus,
} = require('../lib/agent-media-classifier');
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

test('treats provider capacity and service outages as environmental failures', () => {
  for (const status of [401, 403, 408, 429, 500, 502, 503, 504]) {
    assert.equal(isProviderUnavailableStatus(status), true, `HTTP ${status}`);
  }
  for (const status of [400, 404, 422]) {
    assert.equal(isProviderUnavailableStatus(status), false, `HTTP ${status}`);
  }
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
  const bounded = extractEnergyBill({
    kind: 'energy_invoice',
    energy_bill: {
      kwh_nao_compensado: 1_000_001,
      kwh_compensado: 1_000_001,
      total_brl: 'R$ 10.000.000,01',
    },
  });
  assert.equal(bounded.kwhNaoCompensado, null);
  assert.equal(bounded.kwhCompensado, null);
  assert.equal(bounded.totalCents, null);
  const zeroed = extractEnergyBill({
    kind: 'energy_invoice',
    energy_bill: {
      kwh_nao_compensado: 0,
      tarifa_nao_compensada: '0,00',
      kwh_compensado: '0',
      tarifa_scee: 0,
      tarifa_sem_tributos_nao_compensada: 0,
      tarifa_sem_tributos: '0',
    },
  });
  assert.equal(zeroed.kwhNaoCompensado, 0);
  assert.equal(zeroed.tarifaNaoCompensada, 0);
  assert.equal(zeroed.kwhCompensado, 0);
  assert.equal(zeroed.tarifaScee, 0);
  assert.equal(zeroed.tarifaSemTributosNaoCompensada, 0);
  assert.equal(zeroed.tarifaSemTributos, 0);
  assert.equal(extractEnergyBill({
    kind: 'energy_invoice', energy_bill: { total_brl: 'R$ 0,00' },
  }).totalCents, 0);
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

test('requires the cited expense code and an allowlisted sender, and stays silent outside accounting conversations', () => {
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
        global.fetch = async (url) => {
          if (String(url).includes('/api/agents/config')) throw new Error('temporary config timeout');
          throw new Error('unexpected URL ' + url);
        };
        const foreignConv = await router.routeExpenseDecisionReply({ brandId: 'turbo_station', conversationId: 'conv_outra_sala', senderId: '5511999999999', body: 'registrar', quotedBody: 'Código EXP-A1B2C3D4', messageId: 'm5' });
        const foreignConvStranger = await router.routeExpenseDecisionReply({ brandId: 'turbo_station', conversationId: 'conv_outra_sala', senderId: '5511777777777', body: 'registrar', quotedBody: 'Código EXP-A1B2C3D4', messageId: 'm6' });
        const callsAfterForeign = decisionCalls;
        const unavailable = await router.routeExpenseDecisionReply({ brandId: 'uncached_brand', conversationId: 'conv1', senderId: '5511999999999', body: '2', quotedBody: 'Código EXP-A1B2C3D4', messageId: 'm4' });
        if (missingQuote.handled) throw new Error('uncited reply was handled');
        if (!denied.handled || !denied.reply.includes('não está autorizado')) throw new Error('unauthorized sender not blocked');
        if (!allowed.handled || decisionCalls !== 1) throw new Error('allowed decision not posted exactly once');
        if (!foreignConv.silent || foreignConv.reply) throw new Error('agent answered an EXP- quote outside an accounting conversation');
        if (!foreignConvStranger.silent || foreignConvStranger.reply) throw new Error('agent answered a stranger outside an accounting conversation');
        if (callsAfterForeign !== 1) throw new Error('foreign conversation reached the decision API');
        if (!unavailable.handled || !unavailable.reply.includes('Tente novamente')) throw new Error('config outage escaped the decision flow');
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
        const input = { messageId: 'energy-1', conversationId: 'conv1', brandId: 'turbo_station', groupJid: 'contas@g.us', instance: 'turbostation', senderId: '5511999999999', body: 'conta de energia', media: { media_type: 'document', mimetype: 'application/pdf; charset=binary' }, receivedAt: now, deferEnergyInvoiceEvent: true };
        const result = await router.routeInboundMessageDurably(input);
        await router.deliverDueEvents();
        const outbox = db.prepare('SELECT COUNT(*) count FROM agent_event_outbox').get();
        const firstJob = db.prepare('SELECT message_id, kind, status FROM contador_jobs WHERE message_id = ?').get('energy-1');
        const mediaJob = db.prepare('SELECT status, attempts FROM agent_media_jobs WHERE message_id = ?').get('energy-1');
        if (!result.eventDeferred || result.energyBill.kwhNaoCompensado !== 812) throw new Error('energy extraction not deferred');
        if (!result.contadorJobPersisted || firstJob?.kind !== 'pdf' || firstJob?.status !== 'pending') throw new Error('parameterized PDF was not committed as a PDF contador job');
        if (mediaJob?.status !== 'completed' || mediaJob?.attempts !== 1) throw new Error('classification was not durably completed');
        if (outbox.count !== 0 || eventCalls !== 0) throw new Error('generic event was duplicated');
        db.prepare('DELETE FROM contador_jobs WHERE message_id = ?').run('energy-1');
        const replay = await router.routeInboundMessage(input);
        const recovered = db.prepare('SELECT COUNT(*) count FROM contador_jobs WHERE message_id = ?').get('energy-1');
        if (!replay.duplicate || !replay.contadorJobPersisted || recovered.count !== 1) throw new Error('cached analysis did not recover contador job');
        console.log('energy-deferred-ok');
      })().catch(e => { console.error(e); process.exit(1); });
    `], { cwd: path.join(__dirname, '..'), env: { ...process.env, SUPPORT_COPILOT_DB_PATH: dbPath }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    assert.ok(output.includes('energy-deferred-ok'));
  } finally {
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
  }
});

test('retries a temporary config failure without reserving the Contador message id', () => {
  const dbPath = path.join(os.tmpdir(), `agent-router-config-retry-${process.pid}-${Date.now()}.sqlite`);
  try {
    const output = execFileSync(process.execPath, ['-e', `
      (async () => {
        process.env.SUPPORT_COPILOT_DB_PATH = ${JSON.stringify(dbPath)};
        process.env.AGENT_EVENT_BASE_URL = 'https://dashboard.test';
        process.env.AGENT_EVENT_SECRET = 'test-secret';
        process.env.OPENROUTER_API_KEY = 'test-openrouter';
        let configCalls = 0;
        global.fetch = async (url) => {
          if (String(url).includes('/api/agents/config')) {
            configCalls++;
            if (configCalls === 1) throw new Error('temporary config timeout');
            return { ok: true, json: async () => ({ config: { enabled: true, model: 'openai/gpt-4o-mini', accountingGroupConversationIds: ['conv1'], agents: { accounting: true } } }) };
          }
          if (String(url).includes('openrouter.ai')) return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ kind: 'energy_invoice', summary: 'Conta Equatorial', confidence: 0.99, needs_attention: true, energy_bill: { distributor: 'equatorial_go', uc: '1234', ref_period: { year: 2026, month: 7 }, due_date: null, kwh_nao_compensado: 812, tarifa_nao_compensada: 0.75, kwh_compensado: null, tarifa_scee: null, tarifa_sem_tributos_nao_compensada: null, tarifa_sem_tributos: null, total_brl: 'R$ 609,00' } }) } }], usage: {} }) };
          throw new Error('unexpected URL ' + url);
        };
        const { db, nowIso } = require('./lib/db');
        const router = require('./lib/agent-router');
        const input = { messageId: 'energy-config-retry', conversationId: 'conv1', brandId: 'turbo_station', groupJid: 'contas@g.us', instance: 'turbostation', senderId: '5511999999999', body: 'conta de energia', media: { media_type: 'image', mimetype: 'image/jpeg' }, receivedAt: nowIso(), deferEnergyInvoiceEvent: true };
        let firstFailed = false;
        try { await router.routeInboundMessageDurably(input); } catch (_) { firstFailed = true; }
        const retryJob = db.prepare('SELECT status FROM agent_media_jobs WHERE message_id = ?').get(input.messageId);
        const prematureContador = db.prepare('SELECT COUNT(*) count FROM contador_jobs WHERE message_id = ?').get(input.messageId);
        if (!firstFailed || retryJob?.status !== 'retry') throw new Error('config failure was not left retryable');
        if (prematureContador.count !== 0) throw new Error('retry reserved the Contador message id');
        db.prepare("UPDATE agent_media_jobs SET next_attempt_at = ? WHERE message_id = ?").run(nowIso(), input.messageId);
        await router.deliverDueMediaJobs();
        const completed = db.prepare('SELECT status FROM agent_media_jobs WHERE message_id = ?').get(input.messageId);
        const contadorJob = db.prepare('SELECT status, payload_json FROM contador_jobs WHERE message_id = ?').get(input.messageId);
        const payload = JSON.parse(contadorJob?.payload_json || '{}');
        if (completed?.status !== 'completed' || contadorJob?.status !== 'pending') throw new Error('retry did not complete the durable handoff');
        if (payload.visionExtraction?.kwhNaoCompensado !== 812) throw new Error('retry lost the extracted invoice');
        console.log('agent-config-retry-ok');
      })().catch(e => { console.error(e); process.exit(1); });
    `], { cwd: path.join(__dirname, '..'), env: { ...process.env, SUPPORT_COPILOT_DB_PATH: dbPath }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    assert.ok(output.includes('agent-config-retry-ok'));
  } finally {
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
  }
});

test('caps durable media retries and performs skipped fallback before completion', () => {
  const dbPath = path.join(os.tmpdir(), `agent-router-terminal-retry-${process.pid}-${Date.now()}.sqlite`);
  try {
    const output = execFileSync(process.execPath, ['-e', `
      (async () => {
        process.env.SUPPORT_COPILOT_DB_PATH = ${JSON.stringify(dbPath)};
        process.env.AGENT_EVENT_BASE_URL = 'https://dashboard.test';
        process.env.AGENT_EVENT_SECRET = 'test-secret';
        let contadorCalls = 0;
        let mediaCalls = 0;
        let emitted = 0;
        let mediaDescription = '[descrição recuperada]';
        let suggestionCalls = 0;
        const suggestionSources = new Set();
        require.cache[require.resolve('./lib/agent-media-classifier')] = { exports: {
          classifyMessage: async () => ({ status: 'ok', kind: 'support_attention', summary: 'revisar com suporte', confidence: 0.9 }),
        } };
        require.cache[require.resolve('./lib/auto-suggest')] = { exports: {
          createGroupSuggestion: async (_conversationId, _brandId, options = {}) => {
            if (!options.sourceMessageId) throw new Error('durable suggestion source id missing');
            if (suggestionSources.has(options.sourceMessageId)) return { text: 'sugestão recuperada', duplicate: true };
            suggestionSources.add(options.sourceMessageId);
            suggestionCalls++;
            return { text: 'sugestão recuperada' };
          },
        } };
        require.cache[require.resolve('./lib/contador-runtime')] = { exports: {
          enqueueContadorMessage: (event) => {
            if (!event.groupJid) return { kind: 'ignored', enqueued: false };
            contadorCalls++;
            return { kind: 'pdf', enqueued: true };
          },
        } };
        require.cache[require.resolve('./lib/media-processor')] = { exports: {
          processMedia: async () => { mediaCalls++; return mediaDescription; },
        } };
        require.cache[require.resolve('./lib/sse')] = { exports: {
          emitEvent: () => { emitted++; },
        } };
        global.fetch = async (url) => {
          if (String(url).includes('/api/agents/config')) throw new Error('permanent config failure');
          throw new Error('unexpected URL ' + url);
        };
        const { db, nowIso } = require('./lib/db');
        const router = require('./lib/agent-router');
        const failedInput = { messageId: 'media-failed', conversationId: 'conv1', brandId: 'turbo_station', body: 'imagem', receivedAt: nowIso() };
        db.prepare(` + "`" + `INSERT INTO agent_media_jobs
          (message_id, payload_json, status, attempts, next_attempt_at, created_at, updated_at)
          VALUES (?, ?, 'retry', 4, ?, ?, ?)` + "`" + `).run(failedInput.messageId, JSON.stringify(failedInput), nowIso(), nowIso(), nowIso());
        await router.deliverDueMediaJobs();
        const failed = db.prepare('SELECT status, attempts FROM agent_media_jobs WHERE message_id = ?').get(failedInput.messageId);
        if (failed.status !== 'failed' || failed.attempts !== 5) throw new Error('media retries were not capped');

        global.fetch = async (url) => {
          if (String(url).includes('/api/agents/config')) return { ok: true, json: async () => ({ config: { enabled: false } }) };
          throw new Error('unexpected URL ' + url);
        };
        const skipped = await router.routeInboundMessageDurably({
          messageId: 'media-skipped', externalMessageId: 'wa-skipped', conversationId: 'conv1', brandId: 'turbo_station',
          groupJid: 'contas@g.us', instance: 'turbostation', body: 'conta.pdf',
          media: { media_type: 'document', mimetype: 'application/pdf' }, receivedAt: nowIso(),
        });
        const completed = db.prepare('SELECT status FROM agent_media_jobs WHERE message_id = ?').get('media-skipped');
        if (!skipped.fallbackHandled || !skipped.contadorFallbackEnqueued || contadorCalls !== 1) throw new Error('skipped fallback was not delivered');
        if (completed.status !== 'completed') throw new Error('skipped media job was not completed after fallback');

        global.fetch = async (url) => {
          if (String(url).includes('/api/agents/config')) return { ok: true, json: async () => ({ config: {
            enabled: true, model: 'openai/gpt-4o-mini', accountingGroupConversationIds: ['conv-recovery', 'conv-direct-success'],
            agents: { accounting: true },
          } }) };
          if (String(url).includes('/api/agents/events')) return { ok: true, status: 202, text: async () => '{}' };
          throw new Error('unexpected URL ' + url);
        };
        const recoveryInput = {
          messageId: 'media-success-recovery', externalMessageId: 'wa-success-recovery',
          conversationId: 'conv-recovery', brandId: 'recovery_brand', groupJid: 'grupo-recovery@g.us',
          body: '[📷 Imagem]', receivedAt: nowIso(), media: { media_type: 'image', url: '/api/support/media/recovery.jpg' },
        };
        db.prepare(` + "`" + `INSERT INTO agent_media_jobs
          (message_id, payload_json, status, attempts, next_attempt_at, created_at, updated_at)
          VALUES (?, ?, 'retry', 1, ?, ?, ?)` + "`" + `).run(
            recoveryInput.messageId, JSON.stringify(recoveryInput), nowIso(), nowIso(), nowIso(),
          );
        await router.deliverDueMediaJobs();
        const recovered = db.prepare('SELECT status FROM agent_media_jobs WHERE message_id = ?').get(recoveryInput.messageId);
        if (recovered.status !== 'completed' || suggestionCalls !== 1) {
          throw new Error('successful recovered group media did not complete its support handoff');
        }
        db.prepare("UPDATE agent_media_jobs SET status = 'retry', next_attempt_at = ? WHERE message_id = ?")
          .run(nowIso(), recoveryInput.messageId);
        await router.deliverDueMediaJobs();
        if (suggestionCalls !== 1) throw new Error('recovered group handoff was not idempotent');

        const directSuccessAt = nowIso();
        db.prepare(` + "`" + `INSERT INTO messages
          (id, conversation_id, brand_id, direction, source, body, external_message_id, created_at)
          VALUES ('direct-success-recovery', 'conv-direct-success', 'direct_recovery_brand', 'inbound', 'evolution', '[📷 Imagem]', 'wa-direct-success', ?)` + "`" + `).run(directSuccessAt);
        const directSuccessInput = {
          messageId: 'direct-success-recovery', externalMessageId: 'wa-direct-success',
          conversationId: 'conv-direct-success', brandId: 'direct_recovery_brand',
          body: '[📷 Imagem]', receivedAt: directSuccessAt,
          media: { media_type: 'image', url: '/api/support/media/direct-success.jpg' },
        };
        db.prepare(` + "`" + `INSERT INTO agent_media_jobs
          (message_id, payload_json, status, attempts, next_attempt_at, created_at, updated_at)
          VALUES (?, ?, 'retry', 1, ?, ?, ?)` + "`" + `).run(
            directSuccessInput.messageId, JSON.stringify(directSuccessInput), nowIso(), nowIso(), nowIso(),
          );
        await router.deliverDueMediaJobs();
        const directSuccessJob = db.prepare('SELECT status FROM agent_media_jobs WHERE message_id = ?').get(directSuccessInput.messageId);
        let directSuccessMessage = db.prepare('SELECT body FROM messages WHERE id = ?').get(directSuccessInput.messageId);
        if (directSuccessJob.status !== 'completed' || !directSuccessMessage.body.includes('[Análise automática]: revisar com suporte') || emitted !== 1) {
          throw new Error('successful recovered direct media did not enrich the stored message');
        }
        const emittedAfterDirectSuccess = emitted;
        db.prepare("UPDATE agent_media_jobs SET status = 'retry', next_attempt_at = ? WHERE message_id = ?")
          .run(nowIso(), directSuccessInput.messageId);
        await router.deliverDueMediaJobs();
        directSuccessMessage = db.prepare('SELECT body FROM messages WHERE id = ?').get(directSuccessInput.messageId);
        if ((directSuccessMessage.body.match(/\\[Análise automática\\]:/g) || []).length !== 1 || emitted !== emittedAfterDirectSuccess) {
          throw new Error('recovered direct media enrichment was not idempotent');
        }

        const insertedAt = nowIso();
        db.prepare(` + "`" + `INSERT INTO messages
          (id, conversation_id, brand_id, direction, source, body, external_message_id, created_at)
          VALUES ('direct-media', 'conv-direct', 'turbo_station', 'inbound', 'evolution', '[📷 Imagem]', 'wa-direct', ?)` + "`" + `).run(insertedAt);
        const direct = await router.routeInboundMessageDurably({
          messageId: 'direct-media', externalMessageId: 'wa-direct', conversationId: 'conv-direct', brandId: 'turbo_station',
          senderId: '5511999999999', body: '[📷 Imagem]', receivedAt: insertedAt,
          media: { media_type: 'image', url: '/api/support/media/direct.jpg' },
        });
        const directJob = db.prepare('SELECT status, fallback_applied_at FROM agent_media_jobs WHERE message_id = ?').get('direct-media');
        const directMessage = db.prepare('SELECT body FROM messages WHERE id = ?').get('direct-media');
        if (!direct.fallbackHandled || directJob.status !== 'completed' || !directJob.fallback_applied_at) throw new Error('one-to-one durable fallback was not completed');
        if (mediaCalls !== 1 || emitted !== emittedAfterDirectSuccess + 1 || !directMessage.body.includes('descrição recuperada')) {
          throw new Error('one-to-one durable fallback did not enrich the message');
        }
        const emittedAfterDirectFallback = emitted;
        db.prepare("UPDATE agent_media_jobs SET status = 'retry', next_attempt_at = ? WHERE message_id = ?")
          .run(nowIso(), 'direct-media');
        await router.deliverDueMediaJobs();
        const replayedDirectMessage = db.prepare('SELECT body FROM messages WHERE id = ?').get('direct-media');
        if (mediaCalls !== 1 || emitted !== emittedAfterDirectFallback
          || replayedDirectMessage.body.split('descrição recuperada').length - 1 !== 1) {
          throw new Error('one-to-one skipped fallback was not idempotent');
        }

        mediaDescription = null;
        db.prepare(` + "`" + `INSERT INTO messages
          (id, conversation_id, brand_id, direction, source, body, external_message_id, created_at)
          VALUES ('direct-empty', 'conv-direct', 'turbo_station', 'inbound', 'evolution', '[📷 Imagem]', 'wa-direct-empty', ?)` + "`" + `).run(nowIso());
        let emptyFailed = false;
        try {
          await router.routeInboundMessageDurably({
            messageId: 'direct-empty', externalMessageId: 'wa-direct-empty', conversationId: 'conv-direct', brandId: 'turbo_station',
            senderId: '5511999999999', body: '[📷 Imagem]', receivedAt: nowIso(),
            media: { media_type: 'image', url: '/api/support/media/direct-empty.jpg' },
          });
        } catch (_) { emptyFailed = true; }
        const emptyJob = db.prepare('SELECT status, attempts, last_error FROM agent_media_jobs WHERE message_id = ?').get('direct-empty');
        if (!emptyFailed || emptyJob.status !== 'retry' || emptyJob.attempts !== 1 || !emptyJob.last_error.includes('empty_result')) {
          throw new Error('empty one-to-one fallback was not kept retryable');
        }
        console.log('agent-terminal-retry-ok');
      })().catch(e => { console.error(e); process.exit(1); });
    `], { cwd: path.join(__dirname, '..'), env: { ...process.env, SUPPORT_COPILOT_DB_PATH: dbPath }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    assert.ok(output.includes('agent-terminal-retry-ok'));
  } finally {
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
  }
});

test('deduplicates group suggestions by durable source message id', () => {
  const dbPath = path.join(os.tmpdir(), `group-suggestion-source-${process.pid}-${Date.now()}.sqlite`);
  try {
    const output = execFileSync(process.execPath, ['-e', `
      (async () => {
        process.env.SUPPORT_COPILOT_DB_PATH = ${JSON.stringify(dbPath)};
        let modelCalls = 0;
        require.cache[require.resolve('./lib/copilot')] = { exports: {
          generateSuggestion: async () => {
            modelCalls++;
            return { text: 'Sugestão única', model: 'test-model' };
          },
        } };
        require.cache[require.resolve('./lib/sse')] = { exports: { emitEvent: () => {} } };
        const { db, nowIso } = require('./lib/db');
        const now = nowIso();
        db.prepare("INSERT INTO conversations (id, brand_id, channel, customer_phone, status, created_at, updated_at) VALUES ('conv-source','turbo_station','whatsapp-group','group@g.us','open',?,?)").run(now, now);
        db.prepare("INSERT INTO messages (id, conversation_id, brand_id, direction, source, body, external_message_id, created_at) VALUES ('msg-source','conv-source','turbo_station','inbound','evolution','ajuda','wa-source',?)").run(now);
        const { createGroupSuggestion } = require('./lib/auto-suggest');
        const first = await createGroupSuggestion('conv-source', 'turbo_station', { sourceMessageId: 'msg-source' });
        const second = await createGroupSuggestion('conv-source', 'turbo_station', { sourceMessageId: 'msg-source' });
        const rows = db.prepare('SELECT id, source_message_id FROM suggestions WHERE source_message_id = ?').all('msg-source');
        if (!first?.suggestionId || !second?.duplicate || rows.length !== 1 || modelCalls !== 1) {
          throw new Error('group suggestion source dedup failed');
        }
        console.log('group-suggestion-source-ok');
      })().catch(e => { console.error(e); process.exit(1); });
    `], { cwd: path.join(__dirname, '..'), env: { ...process.env, SUPPORT_COPILOT_DB_PATH: dbPath }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    assert.ok(output.includes('group-suggestion-source-ok'));
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

test('routes receipts from a multi-partner group only when the extracted payee identifies one partner', () => {
  const dbPath = path.join(os.tmpdir(), `agent-router-multi-partner-${process.pid}-${Date.now()}.sqlite`);
  try {
    const output = execFileSync(process.execPath, ['-e', `
      (async () => {
        process.env.SUPPORT_COPILOT_DB_PATH = ${JSON.stringify(dbPath)};
        process.env.AGENT_EVENT_BASE_URL = 'https://dashboard.test';
        process.env.AGENT_EVENT_SECRET = 'test-secret';
        process.env.OPENROUTER_API_KEY = 'test-openrouter';
        const modelReplies = [
          { amount: 'R$ 7.686,85', transaction_id: 'E2E-ARENA', payee: 'ARENA ENERGIA E CORRETORA', payee_document: '50.643.268/0001-10' },
          { amount: 'R$ 5.326,47', transaction_id: 'E2E-DAMIAO', payee: 'Damiao de Jesus Ramos', payee_document: '497.176.185-34' },
          { amount: 'R$ 9.999,99', transaction_id: 'E2E-UNKNOWN', payee: 'Outro favorecido', payee_document: '6541160' },
        ];
        const events = [];
        let modelCalls = 0;
        global.fetch = async (url, init) => {
          if (String(url).includes('/api/agents/config')) {
            return { ok: true, json: async () => ({ config: {
              enabled: true,
              model: 'openai/gpt-4o-mini',
              dailyGeneralAnalysisLimit: 0,
              allowedPartnerReceiptSenderIds: ['5511999999999'],
              accountingGroupConversationIds: [],
              agents: { partnerReceipts: true, supportTriage: false },
            } }) };
          }
          if (String(url).includes('openrouter.ai')) {
            const reply = modelReplies[modelCalls++];
            return { ok: true, json: async () => ({
              choices: [{ message: { content: JSON.stringify({
                kind: 'partner_payment_receipt', summary: 'Comprovante PIX', confidence: 0.99,
                needs_attention: true, ...reply,
              }) } }],
              usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.00001 },
            }) };
          }
          if (String(url).includes('/api/agents/events')) {
            events.push(JSON.parse(init.body));
            return { ok: true, status: 202, text: async () => '{"ok":true}' };
          }
          throw new Error('unexpected URL ' + url);
        };
        const { db, nowIso } = require('./lib/db');
        const now = nowIso();
        db.prepare("INSERT INTO conversations (id, brand_id, channel, customer_phone, status, created_at, updated_at) VALUES ('conv-arena','turbo_station','whatsapp-group','arena@g.us','open',?,?)").run(now, now);
        const insertLink = db.prepare("INSERT INTO group_partner_links (group_jid, conversation_id, brand_id, partner_id, partner_user_id, partner_name, enabled, linked_at) VALUES ('arena@g.us','conv-arena','turbo_station',?,?,?,1,?)");
        insertLink.run('partner-arena', 'user-arena', 'ARENA ENERGIA E CORRETORA', now);
        insertLink.run('partner-damiao', 'user-damiao', 'Damião de Jesus Ramos', now);
        const router = require('./lib/agent-router');
        for (const [index, messageId] of ['msg-arena', 'msg-damiao', 'msg-unknown'].entries()) {
          const result = await router.routeInboundMessage({
            messageId, externalMessageId: 'WA-' + index, conversationId: 'conv-arena',
            brandId: 'turbo_station', groupJid: 'arena@g.us', senderId: '5511999999999',
            body: '[Yves]: comprovante PIX', media: { media_type: 'image' }, receivedAt: now,
          });
          if (result.kind !== 'partner_payment_receipt') throw new Error('receipt was skipped before classification');
        }
        await router.deliverDueEvents();
        if (modelCalls !== 3 || events.length !== 3) throw new Error('unexpected analysis/delivery counts');
        if (events[0].partnerId !== 'partner-arena') throw new Error('Arena receipt resolved to wrong partner');
        if (events[1].partnerId !== 'partner-damiao') throw new Error('accent-insensitive Damião match failed');
        if (Object.hasOwn(events[2], 'partnerId')) throw new Error('unknown payee must remain unbound');
        // A payee the group cannot name (the usual case — a PIX comprovante prints
        // the account holder, not the partner's registered name) must still reach
        // the backend with the group's partners, which then decides by amount.
        if (JSON.stringify(events[2].candidatePartnerIds) !== JSON.stringify(['partner-arena', 'partner-damiao'])) {
          throw new Error('unresolved payee must carry the group candidates, got ' + JSON.stringify(events[2].candidatePartnerIds));
        }
        // A receipt already tied to one partner must NOT widen the search.
        if (Object.hasOwn(events[0], 'candidatePartnerIds') || Object.hasOwn(events[1], 'candidatePartnerIds')) {
          throw new Error('a resolved receipt must not send candidates');
        }
        // The payee document travels as digits only — it is what identifies the
        // partner when the comprovante is re-sent in the accounting group.
        if (events[0].payeeDocument !== '50643268000110') throw new Error('CNPJ do favorecido nao normalizado: ' + events[0].payeeDocument);
        if (events[1].payeeDocument !== '49717618534') throw new Error('CPF do favorecido nao normalizado: ' + events[1].payeeDocument);
        // A half-read number must be dropped, never sent as a guess.
        if (Object.hasOwn(events[2], 'payeeDocument')) throw new Error('documento incompleto nao pode ser enviado');
        console.log('agent-multi-partner-receipts-ok');
      })().catch(e => { console.error(e); process.exit(1); });
    `], { cwd: path.join(__dirname, '..'), env: { ...process.env, SUPPORT_COPILOT_DB_PATH: dbPath }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    assert.ok(output.includes('agent-multi-partner-receipts-ok'));
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
        if (suggestion.source_message_id !== 'msg1') throw new Error('station support suggestion is not durably keyed to its source message');
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
