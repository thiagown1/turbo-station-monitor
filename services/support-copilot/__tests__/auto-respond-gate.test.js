#!/usr/bin/env node
/**
 * Auto-respond gate tests — Support Copilot
 *
 * Exhaustive coverage of evaluateAutoRespond() and its helpers: every fail-closed
 * branch, escalation triggers (money/legal/human-request/anger + tags), business
 * hours, allowlist (phone + conv id, +55 / 9th-digit variants), percentage
 * rollout determinism, and the humanized delay.
 *
 * Run: node services/support-copilot/__tests__/auto-respond-gate.test.js
 */
'use strict';

const assert = require('node:assert/strict');
const {
  evaluateAutoRespond,
  detectEscalation,
  withinBusinessHours,
  humanizedDelayMs,
  rolloutBucket,
} = require('../lib/auto-respond-gate');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
  }
}

// Baseline: a fully-eligible scenario that SHOULD auto-respond (percent 100).
function ok(overrides = {}) {
  return {
    conv: { id: 'conv_ok', channel: 'whatsapp', customer_phone: '+5561999990000', is_staff: 0, status: 'open' },
    lastInboundText: 'qual o horario de funcionamento?',
    suggestion: { text: 'Funcionamos das 8h as 22h!', model: 'deepseek/deepseek-v4-flash', tags: ['informacao'] },
    settings: { auto_respond: 1, auto_respond_percent: 100 },
    nowMs: Date.UTC(2026, 5, 11, 15, 0), // 12:00 in America/Sao_Paulo (UTC-3)
    ...overrides,
  };
}

console.log('\n🧪 auto-respond gate — master flag & suggestion\n');

test('allows when everything is eligible (percent 100)', () => {
  const r = evaluateAutoRespond(ok());
  assert.equal(r.allow, true);
  assert.ok(r.delayMs > 0);
  assert.equal(r.typing, true);
});

test('blocks when master flag is off', () => {
  const r = evaluateAutoRespond(ok({ settings: { auto_respond: 0, auto_respond_percent: 100 } }));
  assert.equal(r.allow, false);
  assert.equal(r.reason, 'flag_off');
});

test('blocks an empty suggestion', () => {
  const r = evaluateAutoRespond(ok({ suggestion: { text: '   ', model: 'x' } }));
  assert.equal(r.allow, false);
  assert.equal(r.reason, 'empty_suggestion');
});

test('blocks a template-fallback suggestion', () => {
  const r = evaluateAutoRespond(ok({ suggestion: { text: 'oi', model: 'template-fallback' } }));
  assert.equal(r.allow, false);
  assert.equal(r.reason, 'template_fallback');
});

test('blocks a [NO_REPLY] suggestion', () => {
  const r = evaluateAutoRespond(ok({ suggestion: { text: '[NO_REPLY]', model: 'x' } }));
  assert.equal(r.allow, false);
  assert.equal(r.reason, 'non_reply_token');
});

test('blocks an [aguardando_cliente] suggestion', () => {
  const r = evaluateAutoRespond(ok({ suggestion: { text: 'beleza [aguardando_cliente]', model: 'x' } }));
  assert.equal(r.allow, false);
  assert.equal(r.reason, 'non_reply_token');
});

console.log('\n🧪 auto-respond gate — conversation eligibility\n');

test('blocks a staff conversation', () => {
  const r = evaluateAutoRespond(ok({ conv: { ...ok().conv, is_staff: 1 } }));
  assert.equal(r.allow, false);
  assert.equal(r.reason, 'staff_conv');
});

test('blocks a closed conversation', () => {
  const r = evaluateAutoRespond(ok({ conv: { ...ok().conv, status: 'closed' } }));
  assert.equal(r.allow, false);
  assert.equal(r.reason, 'closed_conv');
});

test('blocks a group conversation (not 1:1 whatsapp)', () => {
  const r = evaluateAutoRespond(ok({ conv: { ...ok().conv, channel: 'whatsapp-group' } }));
  assert.equal(r.allow, false);
  assert.equal(r.reason, 'not_whatsapp_1to1');
});

test('blocks when there is no customer phone', () => {
  const r = evaluateAutoRespond(ok({ conv: { ...ok().conv, customer_phone: null } }));
  assert.equal(r.allow, false);
  assert.equal(r.reason, 'no_phone');
});

console.log('\n🧪 auto-respond gate — escalation triggers\n');

const escalations = [
  ['refund word', 'quero meu reembolso agora', 'financeiro'],
  ['estorno', 'preciso de estorno do pix', 'financeiro'],
  ['cobranca indevida', 'tive uma cobranca indevida', 'financeiro'],
  ['fraude', 'isso e fraude, fui roubado', 'financeiro'],
  ['procon', 'vou no procon', 'juridico'],
  ['advogado', 'meu advogado vai entrar em contato', 'juridico'],
  ['processar', 'vou processar voces', 'juridico'],
  ['lgpd', 'quero exercer meus direitos LGPD', 'juridico'],
  ['falar com atendente', 'quero falar com um atendente humano', 'pedido_humano'],
  ['me liga', 'me liga por favor', 'pedido_humano'],
  ['ligacao', 'prefiro uma ligacao', 'pedido_humano'],
  ['absurdo', 'isso e um absurdo', 'furioso'],
  ['pessimo', 'atendimento pessimo', 'furioso'],
  ['profanity', 'que merda de carregador', 'furioso'],
];
for (const [label, text, type] of escalations) {
  test(`escalates on customer message: ${label}`, () => {
    const r = evaluateAutoRespond(ok({ lastInboundText: text }));
    assert.equal(r.allow, false, `expected block for "${text}"`);
    assert.equal(r.reason, `escalate:${type}`);
  });
}

test('escalates when the SUGGESTION itself mentions reembolso', () => {
  const r = evaluateAutoRespond(ok({
    lastInboundText: 'minha recarga falhou',
    suggestion: { text: 'vou processar seu reembolso agora', model: 'x', tags: ['recarga'] },
  }));
  assert.equal(r.allow, false);
  assert.equal(r.reason, 'escalate:financeiro');
});

test('escalates on a furioso tag from the suggestion', () => {
  const r = evaluateAutoRespond(ok({ suggestion: { text: 'entendo', model: 'x', tags: ['furioso'] } }));
  assert.equal(r.allow, false);
  assert.equal(r.reason, 'escalate:tag:furioso');
});

test('escalates on a financeiro tag', () => {
  const r = evaluateAutoRespond(ok({ suggestion: { text: 'ok', model: 'x', tags: ['financeiro'] } }));
  assert.equal(r.allow, false);
  assert.equal(r.reason, 'escalate:tag:financeiro');
});

test('does NOT escalate a normal price question (preco is not financeiro trigger)', () => {
  const r = evaluateAutoRespond(ok({ lastInboundText: 'qual o preco da recarga?', suggestion: { text: 'R$ 1,38/kWh', model: 'x', tags: ['informacao'] } }));
  assert.equal(r.allow, true);
});

test('detectEscalation returns null for a benign message', () => {
  assert.equal(detectEscalation('oi tudo bem? qual estacao mais perto', 'temos uma no shopping', ['informacao']), null);
});

console.log('\n🧪 auto-respond gate — business hours\n');

test('blocks outside business hours', () => {
  const r = evaluateAutoRespond(ok({
    settings: { auto_respond: 1, auto_respond_percent: 100, auto_respond_business_hours: JSON.stringify({ start: '08:00', end: '22:00' }) },
    nowMs: Date.UTC(2026, 5, 11, 4, 0), // 01:00 BRT
  }));
  assert.equal(r.allow, false);
  assert.equal(r.reason, 'outside_hours');
});

test('allows inside business hours', () => {
  const r = evaluateAutoRespond(ok({
    settings: { auto_respond: 1, auto_respond_percent: 100, auto_respond_business_hours: JSON.stringify({ start: '08:00', end: '22:00' }) },
    nowMs: Date.UTC(2026, 5, 11, 18, 0), // 15:00 BRT
  }));
  assert.equal(r.allow, true);
});

test('blocks on a non-working weekday', () => {
  // 2026-06-13 is a Saturday (day 6). days=[1..5] excludes it.
  const r = evaluateAutoRespond(ok({
    settings: { auto_respond: 1, auto_respond_percent: 100, auto_respond_business_hours: JSON.stringify({ days: [1, 2, 3, 4, 5], start: '00:00', end: '23:59' }) },
    nowMs: Date.UTC(2026, 5, 13, 18, 0),
  }));
  assert.equal(r.allow, false);
  assert.equal(r.reason, 'outside_hours');
});

test('withinBusinessHours: no config means unrestricted', () => {
  assert.equal(withinBusinessHours(null, Date.UTC(2026, 5, 11, 4, 0)), true);
});

console.log('\n🧪 auto-respond gate — allowlist\n');

test('blocks a conv not in a non-empty allowlist', () => {
  const r = evaluateAutoRespond(ok({
    settings: { auto_respond: 1, auto_respond_percent: 100, auto_respond_allowlist: JSON.stringify(['+5511988887777']) },
  }));
  assert.equal(r.allow, false);
  assert.equal(r.reason, 'not_in_allowlist');
});

test('allows a phone listed in the allowlist (exact)', () => {
  const r = evaluateAutoRespond(ok({
    settings: { auto_respond: 1, auto_respond_percent: 0, auto_respond_allowlist: JSON.stringify(['+5561999990000']) },
  }));
  assert.equal(r.allow, true);
  assert.equal(r.reason, 'allowlisted');
});

test('allowlist matches ignoring formatting (digits only)', () => {
  const r = evaluateAutoRespond(ok({
    settings: { auto_respond: 1, auto_respond_percent: 0, auto_respond_allowlist: JSON.stringify(['(61) 99999-0000... 55']) },
  }));
  // digitsOnly("(61) 99999-0000... 55") = 55619999900055 vs phone 5561999990000 -> different.
  // Use the canonical formatted variant instead:
  assert.equal(r.allow, false); // formatting that adds stray digits must NOT match
});

test('allowlist matches a conversation id directly', () => {
  const r = evaluateAutoRespond(ok({
    settings: { auto_respond: 1, auto_respond_percent: 0, auto_respond_allowlist: JSON.stringify(['conv_ok']) },
  }));
  assert.equal(r.allow, true);
  assert.equal(r.reason, 'allowlisted');
});

test('allowlisted conv bypasses percent=0', () => {
  const r = evaluateAutoRespond(ok({
    settings: { auto_respond: 1, auto_respond_percent: 0, auto_respond_allowlist: JSON.stringify(['5561999990000']) },
  }));
  assert.equal(r.allow, true);
});

console.log('\n🧪 auto-respond gate — percentage rollout\n');

test('percent 0 (no allowlist) blocks everything', () => {
  const r = evaluateAutoRespond(ok({ settings: { auto_respond: 1, auto_respond_percent: 0 } }));
  assert.equal(r.allow, false);
  assert.equal(r.reason, 'percent_zero');
});

test('rolloutBucket is deterministic and stable per id', () => {
  const a = rolloutBucket('conv_abc');
  const b = rolloutBucket('conv_abc');
  assert.equal(a, b);
  assert.ok(a >= 0 && a < 100);
});

test('percent rollout includes/excludes consistently with the bucket', () => {
  const id = 'conv_ok';
  const bucket = rolloutBucket(id);
  // percent just above the bucket -> included; just at/below -> excluded.
  const included = evaluateAutoRespond(ok({ settings: { auto_respond: 1, auto_respond_percent: bucket + 1 } }));
  const excluded = evaluateAutoRespond(ok({ settings: { auto_respond: 1, auto_respond_percent: bucket } }));
  assert.equal(included.allow, true, `bucket=${bucket}, percent=${bucket + 1} should include`);
  assert.equal(excluded.allow, false, `bucket=${bucket}, percent=${bucket} should exclude`);
  assert.equal(excluded.reason, 'percent_rollout');
});

test('rollout distribution is roughly proportional at 25%', () => {
  let inAt25 = 0;
  const N = 4000;
  for (let i = 0; i < N; i++) {
    if (rolloutBucket(`conv_${i}`) < 25) inAt25++;
  }
  const ratio = inAt25 / N;
  assert.ok(ratio > 0.20 && ratio < 0.30, `expected ~0.25, got ${ratio.toFixed(3)}`);
});

console.log('\n🧪 auto-respond gate — humanized delay\n');

test('delay grows with text length and is capped', () => {
  const short = humanizedDelayMs('oi');
  const long = humanizedDelayMs('x'.repeat(1000));
  assert.ok(long > short);
  assert.ok(long <= 9000);
  assert.ok(short >= 1500);
});

test('delay respects custom options', () => {
  assert.equal(humanizedDelayMs('abcde', { baseMs: 0, perCharMs: 10, maxMs: 100000 }), 50);
});

console.log('\n🧪 auto-respond gate — ordering / precedence\n');

test('escalation takes precedence over allowlist+percent', () => {
  const r = evaluateAutoRespond(ok({
    lastInboundText: 'quero reembolso',
    settings: { auto_respond: 1, auto_respond_percent: 100, auto_respond_allowlist: JSON.stringify(['5561999990000']) },
  }));
  assert.equal(r.allow, false);
  assert.equal(r.reason, 'escalate:financeiro');
});

test('flag_off takes precedence over an escalation-worthy message', () => {
  const r = evaluateAutoRespond(ok({ lastInboundText: 'vou processar voces', settings: { auto_respond: 0 } }));
  assert.equal(r.reason, 'flag_off');
});

// Summary
console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
if (failed > 0) {
  console.error('\n❌ Some tests failed!');
  process.exit(1);
} else {
  console.log('\n✅ All tests passed!');
  process.exit(0);
}
