#!/usr/bin/env node
/**
 * Conversation outcome stats aggregation tests — Support Copilot
 *
 * computeOutcomeStats() is the pure aggregation behind GET /api/support/outcomes/stats
 * (the route only adds the SQL fetch + "latest row per conversation" CTE around it —
 * see routes/outcomes.js). Plain-array tests here, no sqlite involved.
 *
 * Run: node services/support-copilot/__tests__/outcome-stats.test.js
 */
'use strict';

const assert = require('node:assert/strict');
const { computeOutcomeStats } = require('../lib/outcome-stats');

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

console.log('\n🧪 computeOutcomeStats\n');

test('empty input returns zeroed stats, no division by zero', () => {
  const s = computeOutcomeStats([]);
  assert.equal(s.total, 0);
  assert.equal(s.resolvedPct, 0);
  assert.equal(s.negativePct, 0);
  assert.deepEqual(s.topRootCauses, []);
  assert.deepEqual(s.trend, []);
});

test('counts each outcome and computes resolved/negative percentages', () => {
  const rows = [
    { outcome: 'resolved_by_bot', created_at: '2026-07-01T10:00:00Z' },
    { outcome: 'resolved_by_operator', created_at: '2026-07-01T11:00:00Z' },
    { outcome: 'unresolved', root_cause: 'cliente_parou_de_responder', created_at: '2026-07-01T12:00:00Z' },
    { outcome: 'escalated', root_cause: 'precisa_financeiro', created_at: '2026-07-02T09:00:00Z' },
  ];
  const s = computeOutcomeStats(rows);
  assert.equal(s.total, 4);
  assert.equal(s.byOutcome.resolved_by_bot, 1);
  assert.equal(s.byOutcome.resolved_by_operator, 1);
  assert.equal(s.byOutcome.unresolved, 1);
  assert.equal(s.byOutcome.escalated, 1);
  assert.equal(s.resolvedPct, 50); // 2/4
  assert.equal(s.negativePct, 50); // unresolved + escalated, 2/4
});

test('spam does not count as resolved or negative', () => {
  const s = computeOutcomeStats([
    { outcome: 'spam', created_at: '2026-07-01T10:00:00Z' },
    { outcome: 'resolved_by_bot', created_at: '2026-07-01T11:00:00Z' },
  ]);
  assert.equal(s.resolvedPct, 50);
  assert.equal(s.negativePct, 0);
});

test('ranks top root causes by frequency, capped at 5', () => {
  const rows = [
    ...Array(3).fill({ outcome: 'unresolved', root_cause: 'faltou_dado', created_at: '2026-07-01T10:00:00Z' }),
    ...Array(2).fill({ outcome: 'abandoned', root_cause: 'cliente_sumiu', created_at: '2026-07-01T10:00:00Z' }),
    { outcome: 'escalated', root_cause: 'raro', created_at: '2026-07-01T10:00:00Z' },
  ];
  const s = computeOutcomeStats(rows);
  assert.equal(s.topRootCauses[0].rootCause, 'faltou_dado');
  assert.equal(s.topRootCauses[0].count, 3);
  assert.equal(s.topRootCauses[1].rootCause, 'cliente_sumiu');
  assert.ok(s.topRootCauses.length <= 5);
});

test('resolved/spam rows without a root_cause never pollute the ranking', () => {
  const s = computeOutcomeStats([
    { outcome: 'resolved_by_bot', root_cause: null, created_at: '2026-07-01T10:00:00Z' },
    { outcome: 'spam', root_cause: null, created_at: '2026-07-01T10:00:00Z' },
  ]);
  assert.deepEqual(s.topRootCauses, []);
});

test('buckets trend by day and tracks negative-outcome sub-count', () => {
  const rows = [
    { outcome: 'resolved_by_bot', created_at: '2026-07-01T08:00:00Z' },
    { outcome: 'unresolved', created_at: '2026-07-01T20:00:00Z' },
    { outcome: 'resolved_by_operator', created_at: '2026-07-02T08:00:00Z' },
  ];
  const s = computeOutcomeStats(rows);
  assert.equal(s.trend.length, 2);
  assert.equal(s.trend[0].date, '2026-07-01');
  assert.equal(s.trend[0].total, 2);
  assert.equal(s.trend[0].negative, 1);
  assert.equal(s.trend[1].date, '2026-07-02');
  assert.equal(s.trend[1].total, 1);
  assert.equal(s.trend[1].negative, 0);
});

test('trend is sorted chronologically regardless of input order', () => {
  const rows = [
    { outcome: 'resolved_by_bot', created_at: '2026-07-03T08:00:00Z' },
    { outcome: 'resolved_by_bot', created_at: '2026-07-01T08:00:00Z' },
    { outcome: 'resolved_by_bot', created_at: '2026-07-02T08:00:00Z' },
  ];
  const s = computeOutcomeStats(rows);
  assert.deepEqual(s.trend.map(t => t.date), ['2026-07-01', '2026-07-02', '2026-07-03']);
});

test('a row with a missing/empty created_at is counted but skipped from the trend', () => {
  const s = computeOutcomeStats([{ outcome: 'unresolved', created_at: '' }]);
  assert.equal(s.total, 1);
  assert.deepEqual(s.trend, []);
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
