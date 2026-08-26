#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');

const {
  ROLLOUT_PHASE,
  RECOMMENDATION,
  ACTION,
  classifyEndpoint,
  normalizeRolloutPhase,
  assessRollback,
  createApprovalProposal,
  validateApprovalConfirmation,
  consumeApprovalProposal,
} = require('../services/lib/auto-rollback-policy');
const {
  evaluate,
  alertBlockedOnce,
  readinessBlocksBeforeAction,
  pendingConfirmationEvaluation,
  formatApprovalProposal,
  prepareApprovalProposal,
  killSwitchAllowsActuation,
} = require('../services/auto-rollback-watchdog');

const NEW_SHA = '1111111111111111111111111111111111111111';
const PREV_SHA = '2222222222222222222222222222222222222222';
const NOW = Date.parse('2026-08-26T12:10:00.000Z');

function metric(endpoint, { total, c5xx, success = total - c5xx, first5xxMs = NOW - 60_000, last5xxMs = NOW } = {}) {
  return { endpoint, total, c5xx, success, first5xxMs, last5xxMs };
}

function cleanBaseline(endpoint = '/api/version') {
  return [metric(endpoint, { total: 5, c5xx: 0, success: 5, first5xxMs: null, last5xxMs: null })];
}

function fullContext(overrides = {}) {
  const {
    deploy: deployOverrides,
    rollbackCandidate: rollbackCandidateOverrides,
    changeSafety: changeSafetyOverrides,
    guardrails: guardrailOverrides,
    ...topLevelOverrides
  } = overrides;
  return {
    nowMs: NOW,
    rolloutPhase: ROLLOUT_PHASE.SHADOW,
    deploy: {
      newSha: NEW_SHA,
      previousSha: PREV_SHA,
      currentSha: NEW_SHA,
      cutoverMs: NOW - 120_000,
      ...deployOverrides,
    },
    baseline: cleanBaseline(),
    post: [metric('/api/version', { total: 3, c5xx: 3, success: 0 })],
    aggregate: { total: 3, c5xx: 3, distinct5xxEndpoints: 1 },
    rollbackCandidate: {
      ready: true,
      shaMatches: true,
      smokeVerified: true,
      smokeStatus: 200,
      smokeSha: PREV_SHA,
      ...rollbackCandidateOverrides,
    },
    changeSafety: {
      candidateConfirmed: true,
      noExternalDependency: true,
      noFinancialAmbiguity: true,
      noIrreversibleActivation: true,
      noMigration: true,
      noRuntimeFlagChange: true,
      ...changeSafetyOverrides,
    },
    guardrails: {
      killSwitchAllows: true,
      dedupeAvailable: true,
      alreadyActedForRelease: false,
      cooldownElapsed: true,
      ...guardrailOverrides,
    },
    ...topLevelOverrides,
  };
}

test('classifies only dependency-free canaries as deterministic internal', () => {
  assert.equal(classifyEndpoint('/api/version?probe=1').kind, 'deterministic_internal_canary');
  assert.equal(classifyEndpoint('/api/health').kind, 'deterministic_internal_canary');
  assert.equal(classifyEndpoint('/api/payments/process').kind, 'critical_financial');
  assert.equal(classifyEndpoint('/api/recharge/start-transaction').kind, 'critical_charging');
  assert.equal(classifyEndpoint('/api/webhook/pagarme').kind, 'external_dependency');
  assert.equal(classifyEndpoint('/api/dashboard/summary').kind, 'routine');
});

test('unknown rollout phases fail closed to shadow', () => {
  assert.equal(normalizeRolloutPhase('catastrophic-auto'), ROLLOUT_PHASE.CATASTROPHIC_AUTO);
  assert.equal(normalizeRolloutPhase('unexpected'), ROLLOUT_PHASE.SHADOW);
  assert.equal(normalizeRolloutPhase(undefined), ROLLOUT_PHASE.SHADOW);
});

test('catastrophic canary failure is observable but never acts in shadow', () => {
  const result = assessRollback(fullContext());
  assert.equal(result.recommendation, RECOMMENDATION.ROLLBACK_RECOMMENDED);
  assert.equal(result.failureClass, 'catastrophic_deterministic_release_failure');
  assert.equal(result.directEligibility.eligible, true);
  assert.equal(result.action, ACTION.SHADOW_REPORT);
});

test('approval-required phase creates a proposal path, not direct execution', () => {
  const result = assessRollback(fullContext({ rolloutPhase: ROLLOUT_PHASE.APPROVAL_REQUIRED }));
  assert.equal(result.directEligibility.eligible, true);
  assert.equal(result.action, ACTION.PROPOSAL_REQUIRED);
});

test('catastrophic-auto remains blocked unless the previous candidate smoke is verified', () => {
  const result = assessRollback(fullContext({
    rolloutPhase: ROLLOUT_PHASE.CATASTROPHIC_AUTO,
    rollbackCandidate: { smokeVerified: false, smokeStatus: 403, smokeSha: null },
  }));
  assert.equal(result.action, ACTION.PROPOSAL_REQUIRED);
  assert.equal(result.directEligibility.eligible, false);
  assert.match(result.directEligibility.blockers.join(' '), /smoke/i);
});

test('catastrophic-auto permits only the fully evidenced deterministic class', () => {
  const result = assessRollback(fullContext({ rolloutPhase: ROLLOUT_PHASE.CATASTROPHIC_AUTO }));
  assert.equal(result.directEligibility.eligible, true);
  assert.equal(result.action, ACTION.DIRECT_ROLLBACK_PERMITTED);
});

test('a short duplicate burst is not a catastrophic signal', () => {
  const result = assessRollback(fullContext({
    post: [metric('/api/version', {
      total: 3, c5xx: 3, success: 0,
      first5xxMs: NOW - 10_000, last5xxMs: NOW,
    })],
    aggregate: { total: 3, c5xx: 3, distinct5xxEndpoints: 1 },
    rolloutPhase: ROLLOUT_PHASE.CATASTROPHIC_AUTO,
  }));
  assert.equal(result.recommendation, RECOMMENDATION.OBSERVE);
  assert.equal(result.action, ACTION.NONE);
});

test('missing baseline evidence alerts but cannot recommend or act', () => {
  const result = assessRollback(fullContext({ baseline: [], rolloutPhase: ROLLOUT_PHASE.CATASTROPHIC_AUTO }));
  assert.equal(result.recommendation, RECOMMENDATION.ALERT_INVESTIGATE);
  assert.equal(result.action, ACTION.ALERT_INVESTIGATE);
  assert.match(result.blockers.join(' '), /baseline/i);
});

test('a catastrophic route requires its own clean pre-cutover baseline before any proposal', () => {
  const result = assessRollback(fullContext({
    rolloutPhase: ROLLOUT_PHASE.APPROVAL_REQUIRED,
    baseline: cleanBaseline('/api/health'),
  }));
  assert.equal(result.recommendation, RECOMMENDATION.ALERT_INVESTIGATE);
  assert.equal(result.action, ACTION.ALERT_INVESTIGATE);
  assert.match(result.blockers.join(' '), /same-route baseline/i);
});

test('same-route baseline requires successful observations, not merely non-5xx responses', () => {
  const result = assessRollback(fullContext({
    rolloutPhase: ROLLOUT_PHASE.CATASTROPHIC_AUTO,
    baseline: [metric('/api/version', { total: 2, c5xx: 0, success: 0 })],
  }));
  assert.equal(result.recommendation, RECOMMENDATION.ALERT_INVESTIGATE);
  assert.equal(result.action, ACTION.ALERT_INVESTIGATE);
  assert.match(result.blockers.join(' '), /same-route baseline/i);
});

test('uses a catastrophic canary that has qualifying same-route baseline evidence', () => {
  const result = assessRollback(fullContext({
    rolloutPhase: ROLLOUT_PHASE.APPROVAL_REQUIRED,
    post: [
      metric('/api/health', { total: 3, c5xx: 3, success: 0 }),
      metric('/api/version', { total: 3, c5xx: 3, success: 0 }),
    ],
    baseline: cleanBaseline('/api/version'),
  }));
  assert.equal(result.recommendation, RECOMMENDATION.ROLLBACK_RECOMMENDED);
  assert.equal(result.action, ACTION.PROPOSAL_REQUIRED);
  assert.match(result.reasons.join(' '), /\/api\/version/);
});

test('honors the configured post-cutover attribution window', () => {
  const result = assessRollback(fullContext({
    nowMs: NOW,
    heightenedWindowMs: 15 * 60_000,
    deploy: { cutoverMs: NOW - 11 * 60_000 },
  }));
  assert.equal(result.recommendation, RECOMMENDATION.ROLLBACK_RECOMMENDED);
  assert.doesNotMatch(result.blockers.join(' '), /outside/i);
});

test('missing action readiness never suppresses an inert shadow report', () => {
  const missingReadiness = {
    selection: { target: null, reason: 'no verified candidate' },
    changeSafety: {},
  };
  assert.equal(readinessBlocksBeforeAction(ROLLOUT_PHASE.SHADOW, missingReadiness), false);
  assert.equal(readinessBlocksBeforeAction(ROLLOUT_PHASE.APPROVAL_REQUIRED, missingReadiness), true);
  assert.equal(readinessBlocksBeforeAction(ROLLOUT_PHASE.CATASTROPHIC_AUTO, missingReadiness), true);
});

test('a valid pending confirmation resumes its proposal evaluation after the live signal clears', () => {
  const evaluation = {
    critical: true,
    recommendation: RECOMMENDATION.ROLLBACK_RECOMMENDED,
    action: ACTION.PROPOSAL_REQUIRED,
  };
  const state = {
    newSha: NEW_SHA,
    prevSha: PREV_SHA,
    pendingProposal: {
      status: 'pending', releaseSha: NEW_SHA, targetSha: PREV_SHA,
      expiresAtMs: NOW + 60_000, evaluation,
    },
    pendingConfirmation: { proposalId: 'rbp_test' },
  };
  assert.strictEqual(pendingConfirmationEvaluation(state, NOW), evaluation);
  assert.equal(pendingConfirmationEvaluation(state, NOW + 60_001), null);
  assert.equal(pendingConfirmationEvaluation({ ...state, pendingConfirmation: null }, NOW), null);
  assert.equal(pendingConfirmationEvaluation({ ...state, prevSha: 'different-target' }, NOW), null);
});

test('approval proposal tells the operator the exact action and nonce required by validation', () => {
  const proposal = createApprovalProposal({
    releaseSha: NEW_SHA,
    targetSha: PREV_SHA,
    nowMs: NOW,
    proposalId: 'rbp_visible_contract',
    nonce: 'nonce-visible-contract',
  });
  const text = formatApprovalProposal(proposal, 'evidence summary');
  assert.match(text, /CONFIRM_ROLLBACK/);
  assert.match(text, /nonce-visible-contract/);
  assert.match(text, /rbp_visible_contract/);
  assert.match(text, new RegExp(NEW_SHA));
  assert.match(text, new RegExp(PREV_SHA));
});

test('replacing an expired proposal clears delivery dedupe so new credentials are sent', () => {
  const state = {
    newSha: NEW_SHA,
    prevSha: PREV_SHA,
    lastShadowAlertSha: NEW_SHA,
    pendingConfirmation: { proposalId: 'expired' },
    pendingProposal: {
      id: 'expired', status: 'pending', releaseSha: NEW_SHA, targetSha: PREV_SHA,
      expiresAtMs: NOW - 1,
    },
  };
  assert.equal(prepareApprovalProposal(state, { critical: true }, NOW), true);
  assert.notEqual(state.pendingProposal.id, 'expired');
  assert.equal(state.pendingConfirmation, null);
  assert.equal(state.lastShadowAlertSha, null);
});

test('human-approved actuation still requires the current kill switch', () => {
  assert.equal(killSwitchAllowsActuation({ ks: { on: true } }), true);
  assert.equal(killSwitchAllowsActuation({ ks: { on: false } }), false);
  assert.equal(killSwitchAllowsActuation({ ks: { on: 'firestore-deferred' } }), false);
  assert.equal(killSwitchAllowsActuation({}), false);
});

test('post-deploy evaluation excludes failures recorded before the cutover', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE vercel_logs (timestamp INTEGER, endpoint TEXT, status_code INTEGER)');
  const insert = db.prepare('INSERT INTO vercel_logs (timestamp, endpoint, status_code) VALUES (?, ?, ?)');
  for (let i = 0; i < 20; i++) insert.run(NOW - 250_000 + i * 5_000, '/api/health', 200);
  insert.run(NOW - 70_000, '/api/version', 500);
  insert.run(NOW - 40_000, '/api/version', 500);
  insert.run(NOW - 10_000, '/api/version', 500);

  try {
    const result = evaluate(db, NOW + 10_000, {
      newSha: NEW_SHA,
      prevSha: PREV_SHA,
      currentSha: NEW_SHA,
      deployStartMs: NOW,
    });
    assert.equal(result.recommendation, RECOMMENDATION.OBSERVE);
    assert.equal(result.evidence.c5xx, 0);
  } finally {
    db.close();
  }
});

test('kill switch and reversible-change gates fail independently', () => {
  const cases = [
    ['kill switch', { guardrails: { killSwitchAllows: false } }],
    ['migration', { changeSafety: { noMigration: false } }],
    ['runtime flag', { changeSafety: { noRuntimeFlagChange: false } }],
    ['irreversible', { changeSafety: { noIrreversibleActivation: false } }],
  ];
  for (const [name, overrides] of cases) {
    const result = assessRollback(fullContext({ rolloutPhase: ROLLOUT_PHASE.CATASTROPHIC_AUTO, ...overrides }));
    assert.equal(result.directEligibility.eligible, false, name);
    assert.equal(result.action, ACTION.PROPOSAL_REQUIRED, name);
  }
});

test('dedupe and cooldown blockers never offer an unusable approval proposal', () => {
  for (const [name, guardrails] of [
    ['already acted', { alreadyActedForRelease: true }],
    ['cooldown', { cooldownElapsed: false }],
  ]) {
    const result = assessRollback(fullContext({
      rolloutPhase: ROLLOUT_PHASE.CATASTROPHIC_AUTO,
      guardrails,
    }));
    assert.equal(result.recommendation, RECOMMENDATION.ALERT_INVESTIGATE, name);
    assert.equal(result.action, ACTION.ALERT_INVESTIGATE, name);
  }
});

test('critical financial failures alert quickly but can never authorize rollback', () => {
  const result = assessRollback(fullContext({
    post: [metric('/api/payments/process', { total: 3, c5xx: 2, success: 1 })],
    baseline: cleanBaseline('/api/payments/process'),
    aggregate: { total: 3, c5xx: 2, distinct5xxEndpoints: 1 },
    rolloutPhase: ROLLOUT_PHASE.CATASTROPHIC_AUTO,
  }));
  assert.equal(result.recommendation, RECOMMENDATION.ALERT_INVESTIGATE);
  assert.equal(result.failureClass, 'critical_financial_or_external_ambiguity');
  assert.equal(result.directEligibility.eligible, false);
  assert.equal(result.action, ACTION.ALERT_INVESTIGATE);
});

test('elevated pre-cutover baseline blocks deploy attribution', () => {
  const result = assessRollback(fullContext({
    baseline: [metric('/api/version', { total: 5, c5xx: 2, success: 3 })],
    rolloutPhase: ROLLOUT_PHASE.CATASTROPHIC_AUTO,
  }));
  assert.equal(result.recommendation, RECOMMENDATION.ALERT_INVESTIGATE);
  assert.equal(result.directEligibility.eligible, false);
  assert.match(result.blockers.join(' '), /baseline/i);
});

test('routine aggregate failures require the larger threshold and never go direct', () => {
  const result = assessRollback(fullContext({
    post: [
      metric('/api/a', { total: 8, c5xx: 5 }),
      metric('/api/b', { total: 7, c5xx: 4 }),
      metric('/api/c', { total: 5, c5xx: 1 }),
    ],
    baseline: [
      metric('/api/a', { total: 5, c5xx: 0 }),
      metric('/api/b', { total: 5, c5xx: 0 }),
      metric('/api/c', { total: 5, c5xx: 0 }),
    ],
    aggregate: { total: 20, c5xx: 10, distinct5xxEndpoints: 3 },
    rolloutPhase: ROLLOUT_PHASE.CATASTROPHIC_AUTO,
  }));
  assert.equal(result.recommendation, RECOMMENDATION.ROLLBACK_RECOMMENDED);
  assert.equal(result.failureClass, 'aggregate_release_regression');
  assert.equal(result.directEligibility.eligible, false);
  assert.equal(result.action, ACTION.PROPOSAL_REQUIRED);
});

test('sensitive-route failures cannot be promoted through the routine aggregate', () => {
  const post = Array.from({ length: 10 }, (_, i) =>
    metric(`/api/payments/provider-${i}`, { total: 2, c5xx: 1, success: 1 }));
  const result = assessRollback(fullContext({
    post,
    baseline: post.map((row) => metric(row.endpoint, { total: 2, c5xx: 0, success: 2 })),
    aggregate: { total: 20, c5xx: 10, distinct5xxEndpoints: 10 },
    rolloutPhase: ROLLOUT_PHASE.APPROVAL_REQUIRED,
  }));
  assert.notEqual(result.recommendation, RECOMMENDATION.ROLLBACK_RECOMMENDED);
  assert.notEqual(result.action, ACTION.PROPOSAL_REQUIRED);
});

test('evaluation aggregates query variants as one logical route', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE vercel_logs (timestamp INTEGER, endpoint TEXT, status_code INTEGER)');
  const insert = db.prepare('INSERT INTO vercel_logs (timestamp, endpoint, status_code) VALUES (?, ?, ?)');
  insert.run(NOW - 120_000, '/api/version?probe=baseline-a', 200);
  insert.run(NOW - 60_000, '/api/version?probe=baseline-b', 200);
  insert.run(NOW + 10_000, '/api/version?probe=one', 500);
  insert.run(NOW + 40_000, '/api/version?probe=two', 500);
  insert.run(NOW + 70_000, '/api/version?probe=three', 500);

  try {
    const result = evaluate(db, NOW + 80_000, {
      newSha: NEW_SHA,
      prevSha: PREV_SHA,
      currentSha: NEW_SHA,
      deployStartMs: NOW,
    });
    assert.equal(result.recommendation, RECOMMENDATION.ROLLBACK_RECOMMENDED);
    assert.equal(result.evidence.distinctEndpoints, 1);
  } finally {
    db.close();
  }
});

test('small routine error volume stays in observation', () => {
  const result = assessRollback(fullContext({
    post: [metric('/api/dashboard/summary', { total: 10, c5xx: 2 })],
    baseline: cleanBaseline('/api/dashboard/summary'),
    aggregate: { total: 10, c5xx: 2, distinct5xxEndpoints: 1 },
  }));
  assert.equal(result.recommendation, RECOMMENDATION.OBSERVE);
  assert.equal(result.action, ACTION.NONE);
});

test('approval is personal, allowlisted, release-bound, expiring and one-time', () => {
  const proposal = createApprovalProposal({
    releaseSha: NEW_SHA,
    targetSha: PREV_SHA,
    nowMs: NOW,
    ttlMs: 5 * 60_000,
    proposalId: 'rbp_test_123',
    nonce: 'nonce-test-123',
  });
  const confirmation = {
    source: 'trusted-whatsapp-ingress',
    action: 'CONFIRM_ROLLBACK',
    proposalId: proposal.id,
    nonce: proposal.nonce,
    releaseSha: NEW_SHA,
    targetSha: PREV_SHA,
    senderId: '5562999999999@s.whatsapp.net',
    conversationId: 'conv_personal_owner',
    remoteJid: '5562999999999@s.whatsapp.net',
    receivedAtMs: NOW + 60_000,
  };
  const policy = {
    allowedSenderIds: ['5562999999999@s.whatsapp.net'],
    personalConversationId: 'conv_personal_owner',
    personalApproverJid: '5562999999999@s.whatsapp.net',
  };

  assert.deepEqual(validateApprovalConfirmation(proposal, confirmation, policy, NOW + 60_000), { ok: true, blockers: [] });
  const consumed = consumeApprovalProposal(proposal, confirmation, NOW + 60_000);
  assert.equal(consumed.status, 'consumed');
  assert.equal(validateApprovalConfirmation(consumed, confirmation, policy, NOW + 60_001).ok, false);
});

test('approval rejects groups, wrong releases and expired confirmations', () => {
  const proposal = createApprovalProposal({
    releaseSha: NEW_SHA,
    targetSha: PREV_SHA,
    nowMs: NOW,
    ttlMs: 60_000,
    proposalId: 'rbp_test_456',
    nonce: 'nonce-test-456',
  });
  const policy = {
    allowedSenderIds: ['5562999999999@s.whatsapp.net'],
    personalConversationId: 'conv_personal_owner',
    personalApproverJid: '5562999999999@s.whatsapp.net',
  };
  const base = {
    source: 'trusted-whatsapp-ingress', action: 'CONFIRM_ROLLBACK', proposalId: proposal.id,
    nonce: proposal.nonce, releaseSha: NEW_SHA, targetSha: PREV_SHA,
    senderId: '5562999999999@s.whatsapp.net', conversationId: 'conv_personal_owner',
    remoteJid: '5562999999999@s.whatsapp.net', receivedAtMs: NOW + 30_000,
  };

  assert.equal(validateApprovalConfirmation(proposal, { ...base, remoteJid: '120363000000000000@g.us' }, policy, NOW + 30_000).ok, false);
  assert.equal(validateApprovalConfirmation(proposal, { ...base, releaseSha: '3333333333333333333333333333333333333333' }, policy, NOW + 30_000).ok, false);
  assert.equal(validateApprovalConfirmation(proposal, { ...base, receivedAtMs: NOW + 61_000 }, policy, NOW + 61_000).ok, false);
  for (const remoteJid of [
    'status@broadcast',
    '120363000000000000@newsletter',
    'not-a-whatsapp-jid',
    '5562888888888@s.whatsapp.net',
  ]) {
    assert.equal(
      validateApprovalConfirmation(proposal, { ...base, remoteJid }, policy, NOW + 30_000).ok,
      false,
      remoteJid,
    );
  }
});

test('blocked alert dedupe is persisted only after confirmed delivery', async () => {
  const state = { newSha: NEW_SHA, prevSha: PREV_SHA, lastBlockedAlertKey: null };
  const ev = {
    failureClass: 'catastrophic_signal_not_attributed',
    evidence: { c5xx: 3, total: 3, ratio: 1, windowSec: 90, topEndpoints: ['/api/version'] },
    reasons: ['test signal'],
  };
  let sends = 0;
  let persists = 0;
  const deps = {
    send: async () => {
      sends += 1;
      return sends > 1;
    },
    persist: () => { persists += 1; },
    audit: () => {},
  };

  await alertBlockedOnce(state, ev, 'needs investigation', deps);
  assert.equal(state.lastBlockedAlertKey, null);
  assert.equal(persists, 0);

  await alertBlockedOnce(state, ev, 'needs investigation', deps);
  assert.match(state.lastBlockedAlertKey, /needs investigation/);
  assert.equal(sends, 2);
  assert.equal(persists, 1);

  await alertBlockedOnce(state, ev, 'needs investigation', deps);
  assert.equal(sends, 2, 'confirmed delivery is deduplicated');
});

test('offline replay exercises the real SQLite query and classifies a canary catastrophe', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rollback-policy-'));
  const dbPath = path.join(tmpDir, 'vercel.db');
  const db = new Database(dbPath);
  db.exec('CREATE TABLE vercel_logs (timestamp INTEGER, endpoint TEXT, status_code INTEGER)');
  const insert = db.prepare('INSERT INTO vercel_logs (timestamp, endpoint, status_code) VALUES (?, ?, ?)');
  insert.run(NOW - 240_000, '/api/version', 200);
  insert.run(NOW - 120_000, '/api/version', 200);
  insert.run(NOW + 10_000, '/api/version', 500);
  insert.run(NOW + 40_000, '/api/version', 500);
  insert.run(NOW + 70_000, '/api/version', 500);
  db.close();

  try {
    const watchdog = path.join(__dirname, '..', 'services', 'auto-rollback-watchdog.js');
    const run = spawnSync(process.execPath, [
      watchdog,
      '--replay', new Date(NOW).toISOString(),
      '--cutover', new Date(NOW).toISOString(),
      '--end', new Date(NOW + 120_000).toISOString(),
      '--replay-db', dbPath,
      '--dry-telegram',
    ], { encoding: 'utf8', env: { ...process.env, ROLLBACK_ROLLOUT_PHASE: 'shadow' } });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    assert.match(run.stdout, /CRITICAL\+ATTRIBUTED/);
    assert.match(run.stdout, /WOULD HAVE FIRED/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
