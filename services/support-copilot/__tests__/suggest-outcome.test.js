#!/usr/bin/env node
/**
 * /suggest outcome shaping tests — Support Copilot
 *
 * formatSuggestOutcome() decides what the /suggest route sends back (and
 * whether it persists a suggestions row) for each generateSuggestion() result
 * shape: normal text, [aguardando_cliente] ("waiting"), and [NO_REPLY]
 * ("noReply" — conversation already closed server-side, e.g. a customer's
 * closing "thanks" after the issue was resolved).
 *
 * Run: node services/support-copilot/__tests__/suggest-outcome.test.js
 */
'use strict';

const assert = require('node:assert/strict');
const { formatSuggestOutcome } = require('../lib/suggest-outcome');

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

console.log('\n🧪 formatSuggestOutcome\n');

test('normal suggestion persists and passes text/model through untouched', () => {
  const outcome = formatSuggestOutcome({ text: 'me manda a estação que eu confirmo', model: 'claude-cli', tags: ['suporte-tecnico'] });
  assert.equal(outcome.shouldPersist, true);
  assert.equal(outcome.response, null);
});

test('waiting result does not persist and reports waiting:true', () => {
  const outcome = formatSuggestOutcome({ text: null, model: 'waiting', waiting: true, tags: [] });
  assert.equal(outcome.shouldPersist, false);
  assert.equal(outcome.response.waiting, true);
  assert.equal(outcome.response.noReply, undefined);
  assert.equal(outcome.response.suggestion, null);
  assert.equal(outcome.response.model, 'waiting');
});

test('noReply ([NO_REPLY]) result does not persist and reports noReply:true', () => {
  const outcome = formatSuggestOutcome({ text: null, model: 'no_reply', noReply: true, tags: ['elogio'] });
  assert.equal(outcome.shouldPersist, false);
  assert.equal(outcome.response.noReply, true);
  assert.equal(outcome.response.waiting, undefined);
  assert.equal(outcome.response.suggestion, null);
  assert.equal(outcome.response.model, 'no_reply');
  // Regression guard: a null suggestion_text should never reach the DB insert —
  // this is the field the original bug persisted for a closing "thanks" reply.
  assert.equal(outcome.response.id, null);
});

test('noReply response carries a human-readable closed message', () => {
  const outcome = formatSuggestOutcome({ text: null, model: 'no_reply', noReply: true });
  assert.match(outcome.response.message, /encerrada/i);
});

test('waiting takes precedence if a result somehow sets both flags', () => {
  const outcome = formatSuggestOutcome({ text: null, waiting: true, noReply: true });
  assert.equal(outcome.response.model, 'waiting');
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
