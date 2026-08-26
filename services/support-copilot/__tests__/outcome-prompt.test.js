#!/usr/bin/env node
/**
 * Conversation outcome prompt/parse tests — Support Copilot
 *
 * buildOutcomePrompt() shapes what the classifier sees; parseOutcomeResponse()
 * turns its raw text back into a validated outcome. Both are pure (no DB, no
 * network) so they're covered here without pulling in lib/db.js's real
 * sqlite connection — see lib/outcome-prompt.js's module docstring.
 *
 * Run: node services/support-copilot/__tests__/outcome-prompt.test.js
 */
'use strict';

const assert = require('node:assert/strict');
const { OUTCOMES, NEGATIVE_OUTCOMES, buildOutcomePrompt, parseOutcomeResponse } = require('../lib/outcome-prompt');

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

const conv = { id: 'conv_1', brand_id: 'turbo_station' };
const msgs = [
  { direction: 'inbound', body: 'Oi, minha recarga não iniciou' },
  { direction: 'outbound', body: 'Me manda a estação que eu confirmo' },
  { direction: 'inbound', body: 'Obrigada, já resolveu!' },
];

console.log('\n🧪 buildOutcomePrompt\n');

test('includes the transcript in Cliente/Operador-Bot roles', () => {
  const prompt = buildOutcomePrompt(conv, msgs, { closedBy: 'bot' });
  assert.match(prompt, /\[Cliente\] Oi, minha recarga não iniciou/);
  assert.match(prompt, /\[Operador\/Bot\] Me manda a estação/);
});

test('labels who closed the conversation', () => {
  const byBot = buildOutcomePrompt(conv, msgs, { closedBy: 'bot' });
  const byOperator = buildOutcomePrompt(conv, msgs, { closedBy: 'operator' });
  assert.match(byBot, /o próprio bot/);
  assert.match(byOperator, /operador humano/);
});

test('includes tags when provided, omits the line when empty', () => {
  const withTags = buildOutcomePrompt(conv, msgs, { closedBy: 'bot', tags: ['recarga', 'suporte-tecnico'] });
  const withoutTags = buildOutcomePrompt(conv, msgs, { closedBy: 'bot', tags: [] });
  assert.match(withTags, /Tags da conversa: recarga, suporte-tecnico/);
  assert.doesNotMatch(withoutTags, /Tags da conversa/);
});

test('lists all outcome categories in the instructions', () => {
  const prompt = buildOutcomePrompt(conv, msgs, { closedBy: 'bot' });
  for (const o of OUTCOMES) assert.match(prompt, new RegExp(o));
});

test('caps the transcript to the most recent messages for a long conversation', () => {
  const long = Array.from({ length: 50 }, (_, i) => ({ direction: i % 2 === 0 ? 'inbound' : 'outbound', body: `msg ${i}` }));
  const prompt = buildOutcomePrompt(conv, long, { closedBy: 'bot' });
  assert.doesNotMatch(prompt, /msg 0\b/);
  assert.match(prompt, /msg 49\b/);
});

console.log('\n🧪 parseOutcomeResponse\n');

test('parses a clean JSON response', () => {
  const r = parseOutcomeResponse('{"outcome": "resolved_by_bot", "rootCause": null, "analysis": null, "suggestion": null}');
  assert.equal(r.outcome, 'resolved_by_bot');
  assert.equal(r.parseOk, true);
});

test('parses JSON wrapped in a fenced code block', () => {
  const r = parseOutcomeResponse('```json\n{"outcome": "unresolved", "rootCause": "cliente_parou_de_responder", "analysis": "sumiu no meio", "suggestion": "fazer follow-up"}\n```');
  assert.equal(r.outcome, 'unresolved');
  assert.equal(r.rootCause, 'cliente_parou_de_responder');
  assert.equal(r.parseOk, true);
});

test('extracts a JSON span from surrounding prose', () => {
  const r = parseOutcomeResponse('Aqui está minha análise:\n{"outcome": "escalated", "rootCause": "precisa_financeiro", "analysis": "encaminhado", "suggestion": "nada"}\nFim.');
  assert.equal(r.outcome, 'escalated');
  assert.equal(r.parseOk, true);
});

test('rejects an outcome value outside the taxonomy and falls back safely', () => {
  const r = parseOutcomeResponse('{"outcome": "made_up_value"}');
  assert.equal(r.outcome, 'unresolved');
  assert.equal(r.parseOk, false);
});

test('falls back safely on unparseable garbage instead of throwing', () => {
  assert.doesNotThrow(() => parseOutcomeResponse('not json at all, sorry'));
  const r = parseOutcomeResponse('not json at all, sorry');
  assert.equal(r.outcome, 'unresolved');
  assert.equal(r.parseOk, false);
  assert.equal(r.rootCause, 'classifier_parse_error');
});

test('falls back safely on empty/null input', () => {
  assert.doesNotThrow(() => parseOutcomeResponse(''));
  assert.doesNotThrow(() => parseOutcomeResponse(null));
  assert.equal(parseOutcomeResponse(null).outcome, 'unresolved');
});

test('clamps overly long analysis/suggestion fields', () => {
  const long = 'x'.repeat(1000);
  const r = parseOutcomeResponse(JSON.stringify({ outcome: 'unresolved', rootCause: 'x', analysis: long, suggestion: long }));
  assert.ok(r.analysis.length <= 500);
  assert.ok(r.suggestion.length <= 500);
});

test('NEGATIVE_OUTCOMES matches exactly the non-resolved categories', () => {
  const resolved = new Set(['resolved_by_bot', 'resolved_by_operator']);
  for (const o of OUTCOMES) {
    if (resolved.has(o)) assert.equal(NEGATIVE_OUTCOMES.has(o), false, `${o} should not be negative`);
    else if (o !== 'spam') assert.equal(NEGATIVE_OUTCOMES.has(o), true, `${o} should be negative`);
  }
  assert.equal(NEGATIVE_OUTCOMES.has('spam'), false, 'spam is not a real support case, not a "didn\'t work out" one');
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
