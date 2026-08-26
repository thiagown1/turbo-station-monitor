'use strict';

const crypto = require('crypto');

const ROLLOUT_PHASE = Object.freeze({
  SHADOW: 'shadow',
  APPROVAL_REQUIRED: 'approval-required',
  CATASTROPHIC_AUTO: 'catastrophic-auto',
});

const RECOMMENDATION = Object.freeze({
  OBSERVE: 'observe',
  ALERT_INVESTIGATE: 'alert_investigate',
  ROLLBACK_RECOMMENDED: 'rollback_recommended',
});

const ACTION = Object.freeze({
  NONE: 'none',
  SHADOW_REPORT: 'shadow_report',
  ALERT_INVESTIGATE: 'alert_investigate',
  PROPOSAL_REQUIRED: 'proposal_required',
  DIRECT_ROLLBACK_PERMITTED: 'direct_rollback_permitted',
});

const HEIGHTENED_WINDOW_MS = 10 * 60_000;
const PRE_CUTOVER_ELEVATED_RATIO = 0.3;
const CATASTROPHIC_MIN_FAILURES = 3;
const CATASTROPHIC_MIN_SPAN_MS = 30_000;
const CRITICAL_ROUTE_MIN_FAILURES = 2;
const CRITICAL_ROUTE_MIN_RATIO = 0.5;
const ROUTINE_MIN_TOTAL = 20;
const ROUTINE_MIN_5XX = 10;
const ROUTINE_MIN_RATIO = 0.5;
const ROUTINE_MIN_ENDPOINTS = 3;
const MAX_APPROVAL_TTL_MS = 5 * 60_000;

const DETERMINISTIC_INTERNAL_CANARIES = new Set(['/api/version', '/api/health']);
const EXTERNAL_PREFIXES = ['/api/webhook/', '/api/webhooks/', '/api/nfse', '/api/fiscal'];
const FINANCIAL_PREFIXES = ['/api/payments', '/api/payment', '/api/pagarme', '/api/credits'];
const CHARGING_PREFIXES = ['/api/recharge/', '/api/events/charger/', '/api/ocpp/'];

function normalizeEndpoint(value) {
  if (!value) return '';
  let endpoint = String(value).trim();
  try {
    if (/^https?:\/\//i.test(endpoint)) endpoint = new URL(endpoint).pathname;
  } catch { /* keep the raw path and sanitize below */ }
  endpoint = endpoint.split('?')[0].split('#')[0];
  if (!endpoint.startsWith('/')) endpoint = `/${endpoint}`;
  if (endpoint.length > 1) endpoint = endpoint.replace(/\/+$/, '');
  return endpoint.toLowerCase();
}

function startsWithAny(endpoint, prefixes) {
  return prefixes.some((prefix) => endpoint === prefix.replace(/\/$/, '') || endpoint.startsWith(prefix));
}

function classifyEndpoint(value) {
  const endpoint = normalizeEndpoint(value);
  if (DETERMINISTIC_INTERNAL_CANARIES.has(endpoint)) {
    return { endpoint, kind: 'deterministic_internal_canary', critical: true, directCandidate: true };
  }
  if (startsWithAny(endpoint, EXTERNAL_PREFIXES)) {
    return { endpoint, kind: 'external_dependency', critical: true, directCandidate: false };
  }
  if (startsWithAny(endpoint, FINANCIAL_PREFIXES)) {
    return { endpoint, kind: 'critical_financial', critical: true, directCandidate: false };
  }
  if (startsWithAny(endpoint, CHARGING_PREFIXES)) {
    return { endpoint, kind: 'critical_charging', critical: true, directCandidate: false };
  }
  return { endpoint, kind: 'routine', critical: false, directCandidate: false };
}

function normalizeRolloutPhase(value) {
  return Object.values(ROLLOUT_PHASE).includes(value) ? value : ROLLOUT_PHASE.SHADOW;
}

function safeRatio(part, total) {
  return total > 0 ? part / total : 0;
}

function aggregateMetrics(rows) {
  return (rows || []).reduce((acc, row) => {
    acc.total += Number(row.total || 0);
    acc.c5xx += Number(row.c5xx || 0);
    acc.success += Number(row.success || 0);
    return acc;
  }, { total: 0, c5xx: 0, success: 0 });
}

function metricFor(rows, endpoint) {
  return (rows || []).find((row) => normalizeEndpoint(row.endpoint) === endpoint) || null;
}

function deployAttributionBlockers(input, baselineSummary) {
  const blockers = [];
  const deploy = input.deploy || {};
  const nowMs = Number(input.nowMs || Date.now());
  if (!deploy.newSha || !deploy.previousSha || deploy.newSha === deploy.previousSha) {
    blockers.push('release identity is incomplete or previous and new SHA are equal');
  }
  if (!deploy.currentSha || deploy.currentSha !== deploy.newSha) {
    blockers.push('new candidate is not confirmed as the current production SHA');
  }
  if (!Number.isFinite(deploy.cutoverMs) || deploy.cutoverMs <= 0 || nowMs < deploy.cutoverMs) {
    blockers.push('cutover timestamp is missing or invalid');
  } else if (nowMs - deploy.cutoverMs > HEIGHTENED_WINDOW_MS) {
    blockers.push('signal is outside the ten-minute post-cutover attribution window');
  }
  if (baselineSummary.total < 2) {
    blockers.push('pre-cutover baseline has fewer than two observations');
  }
  if (safeRatio(baselineSummary.c5xx, baselineSummary.total) >= PRE_CUTOVER_ELEVATED_RATIO) {
    blockers.push('pre-cutover baseline was already elevated');
  }
  return blockers;
}

function directEligibilityBlockers(input, catastrophicMetric, attributionBlockers) {
  const blockers = [...attributionBlockers];
  const baseline = metricFor(input.baseline, normalizeEndpoint(catastrophicMetric && catastrophicMetric.endpoint));
  const candidate = input.rollbackCandidate || {};
  const safety = input.changeSafety || {};
  const guards = input.guardrails || {};

  if (!baseline || Number(baseline.total || 0) < 2 || Number(baseline.c5xx || 0) !== 0) {
    blockers.push('same-route baseline lacks at least two clean pre-cutover observations');
  }
  if (safety.candidateConfirmed !== true) blockers.push('release candidate confirmation is missing');
  if (safety.noExternalDependency !== true) blockers.push('external dependency exclusion is not proven');
  if (safety.noFinancialAmbiguity !== true) blockers.push('financial ambiguity exclusion is not proven');
  if (safety.noIrreversibleActivation !== true) blockers.push('irreversible activation exclusion is not proven');
  if (safety.noMigration !== true) blockers.push('migration exclusion is not proven');
  if (safety.noRuntimeFlagChange !== true) blockers.push('runtime flag-change exclusion is not proven');
  if (candidate.ready !== true || candidate.shaMatches !== true) blockers.push('previous rollback candidate is not READY with the expected SHA');
  if (candidate.smokeVerified !== true || Number(candidate.smokeStatus) !== 200 || candidate.smokeSha !== (input.deploy || {}).previousSha) {
    blockers.push('previous candidate smoke is not verified as HTTP 200 with the expected SHA');
  }
  if (guards.killSwitchAllows !== true) blockers.push('kill switch does not allow direct rollback');
  if (guards.dedupeAvailable !== true) blockers.push('durable dedupe is unavailable');
  if (guards.alreadyActedForRelease === true) blockers.push('one rollback was already attempted for this release');
  if (guards.cooldownElapsed !== true) blockers.push('rollback cooldown has not elapsed');
  return [...new Set(blockers)];
}

function assessRollback(input = {}) {
  const post = input.post || [];
  const baselineSummary = aggregateMetrics(input.baseline || []);
  const aggregate = input.aggregate || aggregateMetrics(post);
  const phase = normalizeRolloutPhase(input.rolloutPhase);
  const blockers = deployAttributionBlockers(input, baselineSummary);
  const reasons = [];

  const catastrophic = post.find((row) => {
    const cls = classifyEndpoint(row.endpoint);
    const failures = Number(row.c5xx || 0);
    const successes = Number(row.success || 0);
    const span = Number(row.last5xxMs || 0) - Number(row.first5xxMs || 0);
    return cls.directCandidate && failures >= CATASTROPHIC_MIN_FAILURES && successes === 0 &&
      safeRatio(failures, Number(row.total || 0)) === 1 && span >= CATASTROPHIC_MIN_SPAN_MS;
  });

  const ambiguousCritical = post.find((row) => {
    const cls = classifyEndpoint(row.endpoint);
    const failures = Number(row.c5xx || 0);
    return cls.critical && !cls.directCandidate && failures >= CRITICAL_ROUTE_MIN_FAILURES &&
      safeRatio(failures, Number(row.total || 0)) >= CRITICAL_ROUTE_MIN_RATIO;
  });

  const routineAggregate = Number(aggregate.total || 0) >= ROUTINE_MIN_TOTAL &&
    Number(aggregate.c5xx || 0) >= ROUTINE_MIN_5XX &&
    safeRatio(Number(aggregate.c5xx || 0), Number(aggregate.total || 0)) >= ROUTINE_MIN_RATIO &&
    Number(aggregate.distinct5xxEndpoints || 0) >= ROUTINE_MIN_ENDPOINTS;

  if (ambiguousCritical) {
    const cls = classifyEndpoint(ambiguousCritical.endpoint);
    reasons.push(`${cls.kind} crossed the sensitive critical-route threshold`);
    return {
      recommendation: RECOMMENDATION.ALERT_INVESTIGATE,
      failureClass: cls.kind === 'critical_financial' ? 'critical_financial_or_external_ambiguity' : 'critical_external_or_operational_ambiguity',
      action: ACTION.ALERT_INVESTIGATE,
      reasons,
      blockers: [...new Set([...blockers, 'financial, external, or OCPP ambiguity forbids direct rollback'])],
      directEligibility: { eligible: false, blockers: ['route class is never eligible for direct rollback'] },
    };
  }

  if (catastrophic) {
    reasons.push(`${normalizeEndpoint(catastrophic.endpoint)} had at least ${CATASTROPHIC_MIN_FAILURES} consecutive 5xx-only observations spanning ${CATASTROPHIC_MIN_SPAN_MS / 1000}s`);
    if (blockers.length > 0) {
      return {
        recommendation: RECOMMENDATION.ALERT_INVESTIGATE,
        failureClass: 'catastrophic_signal_not_attributed',
        action: ACTION.ALERT_INVESTIGATE,
        reasons,
        blockers,
        directEligibility: { eligible: false, blockers },
      };
    }
    const directBlockers = directEligibilityBlockers(input, catastrophic, blockers);
    const eligible = directBlockers.length === 0;
    const action = phase === ROLLOUT_PHASE.SHADOW
      ? ACTION.SHADOW_REPORT
      : phase === ROLLOUT_PHASE.CATASTROPHIC_AUTO && eligible
        ? ACTION.DIRECT_ROLLBACK_PERMITTED
        : ACTION.PROPOSAL_REQUIRED;
    return {
      recommendation: RECOMMENDATION.ROLLBACK_RECOMMENDED,
      failureClass: 'catastrophic_deterministic_release_failure',
      action,
      reasons,
      blockers: [],
      directEligibility: { eligible, blockers: directBlockers },
    };
  }

  if (routineAggregate) {
    reasons.push(`aggregate 5xx threshold crossed: ${aggregate.c5xx}/${aggregate.total} across ${aggregate.distinct5xxEndpoints} endpoints`);
    if (blockers.length > 0) {
      return {
        recommendation: RECOMMENDATION.ALERT_INVESTIGATE,
        failureClass: 'aggregate_signal_not_attributed',
        action: ACTION.ALERT_INVESTIGATE,
        reasons,
        blockers,
        directEligibility: { eligible: false, blockers: ['aggregate failures are never eligible for direct rollback'] },
      };
    }
    return {
      recommendation: RECOMMENDATION.ROLLBACK_RECOMMENDED,
      failureClass: 'aggregate_release_regression',
      action: phase === ROLLOUT_PHASE.SHADOW ? ACTION.SHADOW_REPORT : ACTION.PROPOSAL_REQUIRED,
      reasons,
      blockers: [],
      directEligibility: { eligible: false, blockers: ['aggregate failures require explicit human confirmation'] },
    };
  }

  return {
    recommendation: RECOMMENDATION.OBSERVE,
    failureClass: 'below_threshold',
    action: ACTION.NONE,
    reasons: ['no deterministic critical-route or aggregate threshold was crossed'],
    blockers: [],
    directEligibility: { eligible: false, blockers: ['no rollback recommendation'] },
  };
}

function createApprovalProposal({ releaseSha, targetSha, nowMs = Date.now(), ttlMs = MAX_APPROVAL_TTL_MS, proposalId, nonce } = {}) {
  if (!releaseSha || !targetSha || releaseSha === targetSha) throw new Error('distinct releaseSha and targetSha are required');
  const boundedTtl = Math.min(Math.max(Number(ttlMs) || 0, 1), MAX_APPROVAL_TTL_MS);
  return {
    id: proposalId || `rbp_${crypto.randomUUID()}`,
    nonce: nonce || crypto.randomBytes(18).toString('base64url'),
    releaseSha,
    targetSha,
    status: 'pending',
    createdAtMs: nowMs,
    expiresAtMs: nowMs + boundedTtl,
    consumedAtMs: null,
  };
}

function validateApprovalConfirmation(proposal, confirmation, policy = {}, nowMs = Date.now()) {
  const blockers = [];
  if (!proposal || proposal.status !== 'pending' || proposal.consumedAtMs) blockers.push('proposal is not pending and unused');
  if (!confirmation || confirmation.source !== 'trusted-whatsapp-ingress') blockers.push('confirmation did not come from the trusted WhatsApp ingress');
  if (!confirmation || confirmation.action !== 'CONFIRM_ROLLBACK') blockers.push('confirmation action is not explicit');
  if (!confirmation || confirmation.proposalId !== proposal?.id || confirmation.nonce !== proposal?.nonce) blockers.push('proposal id or nonce mismatch');
  if (!confirmation || confirmation.releaseSha !== proposal?.releaseSha || confirmation.targetSha !== proposal?.targetSha) blockers.push('release or rollback target mismatch');
  if (!confirmation || !policy.allowedSenderIds?.includes(confirmation.senderId)) blockers.push('sender is not allowlisted');
  if (!confirmation || confirmation.conversationId !== policy.personalConversationId) blockers.push('conversation is not the allowlisted personal conversation');
  if (!confirmation || !confirmation.remoteJid || confirmation.remoteJid.endsWith('@g.us')) blockers.push('group or unknown WhatsApp destination is forbidden');
  const receivedAtMs = Number(confirmation && confirmation.receivedAtMs);
  if (!Number.isFinite(receivedAtMs) || receivedAtMs < Number(proposal?.createdAtMs) || receivedAtMs > Number(proposal?.expiresAtMs) || nowMs > Number(proposal?.expiresAtMs)) {
    blockers.push('confirmation is outside the proposal validity window');
  }
  return { ok: blockers.length === 0, blockers: [...new Set(blockers)] };
}

function consumeApprovalProposal(proposal, confirmation, nowMs = Date.now()) {
  return {
    ...proposal,
    status: 'consumed',
    consumedAtMs: nowMs,
    consumedBy: confirmation.senderId,
    confirmationSource: confirmation.source,
  };
}

module.exports = {
  ROLLOUT_PHASE,
  RECOMMENDATION,
  ACTION,
  classifyEndpoint,
  normalizeRolloutPhase,
  assessRollback,
  createApprovalProposal,
  validateApprovalConfirmation,
  consumeApprovalProposal,
};
