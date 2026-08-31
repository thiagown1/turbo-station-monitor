'use strict';

const CHECK_NAMES = Object.freeze({
  test: 'Test Review Verdict',
  security: 'Security Review Verdict',
  merge: 'Merge Gate',
});

const LEGACY_APPROVAL_LABELS = Object.freeze({
  test: 'reviewed:tests',
  security: 'reviewed:security',
});

const LEGACY_REVIEW_EVIDENCE = Object.freeze({
  test: {
    marker: '[test-review]',
    authors: new Set(['turbostation-ai', 'test-engineer']),
  },
  security: {
    marker: '[sec-review]',
    authors: new Set(['turbostation-ai', 'secguard']),
  },
});

// These checks describe orchestration/review state, not deterministic product CI.
// They are evaluated by evaluateReviewReadiness instead of summarizeCiChecks.
const REVIEW_CONTROL_CHECK_NAMES = new Set([
  ...Object.values(CHECK_NAMES),
  'test-review',
  'sec-review',
  'reuse-review',
  'Fix requested by reviewer',
  'Rebase merge conflict',
  'ready-to-merge gate',
  'seed',
]);

const PENDING_STATES = new Set([
  '',
  'EXPECTED',
  'IN_PROGRESS',
  'PENDING',
  'QUEUED',
  'REQUESTED',
  'WAITING',
]);

const CHECK_KIND_BY_NAME = Object.freeze({
  [CHECK_NAMES.test]: 'test',
  [CHECK_NAMES.security]: 'security',
  [CHECK_NAMES.merge]: 'merge',
});

const TRUSTED_CHECK_APPS = new Set(['github-actions']);

const VERDICT_WORKFLOW_POLICIES = Object.freeze({
  'thiagown1/turbo_station': Object.freeze({
    defaultBranch: 'master',
    test: Object.freeze({
      path: '.github/workflows/agent-test-review.yml',
      title: ({ prNumber, headSha, baseSha }) =>
        `Test review verdict PR #${prNumber} head ${headSha} base ${baseSha}`,
    }),
    security: Object.freeze({
      path: '.github/workflows/agent-sec-review.yml',
      title: ({ prNumber, headSha, baseSha }) =>
        `Security review verdict PR #${prNumber} head ${headSha} base ${baseSha}`,
    }),
  }),
  'thiagown1/ocpp_server': Object.freeze({
    defaultBranch: 'main',
    test: Object.freeze({
      path: '.github/workflows/agent-test-review.yml',
      title: ({ prNumber, headSha, baseSha }) =>
        `Test review PR #${prNumber} head ${headSha} base ${baseSha}`,
    }),
    security: Object.freeze({
      path: '.github/workflows/agent-sec-review.yml',
      title: ({ prNumber, headSha, baseSha }) =>
        `Security review PR #${prNumber} head ${headSha} base ${baseSha}`,
    }),
  }),
});

function getCheckName(check = {}) {
  return check.name || check.context || 'unknown';
}

function getLabelNames(labels = []) {
  return new Set(labels.map(label => label?.name || label).filter(Boolean));
}

function normalizeState(check = {}) {
  const conclusion = String(check.conclusion || '').toUpperCase();
  if (conclusion) return conclusion;

  const state = String(check.state || '').toUpperCase();
  if (state && state !== 'COMPLETED') return state;

  const status = String(check.status || '').toUpperCase();
  if (status && status !== 'COMPLETED') return status;

  return '';
}

function classifyState(check) {
  const state = normalizeState(check);
  if (state === 'SUCCESS') return { status: 'success', state, approved: true };
  if (PENDING_STATES.has(state)) return { status: 'pending', state: state || 'PENDING', approved: false };
  return { status: 'blocked', state, approved: false };
}

function checkTimestamp(check = {}) {
  const values = [
    check.updatedAt,
    check.updated_at,
    check.completedAt,
    check.completed_at,
    check.startedAt,
    check.started_at,
  ];

  let latest = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    const timestamp = Date.parse(value || '');
    if (Number.isFinite(timestamp)) latest = Math.max(latest, timestamp);
  }
  return latest;
}

function expectedExternalId(name, revision = {}) {
  const kind = CHECK_KIND_BY_NAME[name];
  if (!kind || !revision.repo || !revision.prNumber || !revision.headSha || !revision.baseSha) return null;
  return `review-verdict:v1:${revision.repo}:pr:${revision.prNumber}:${kind}:head:${revision.headSha}:base:${revision.baseSha}`;
}

function parseWorkflowRunId(detailsUrl, repo) {
  try {
    const url = new URL(detailsUrl);
    const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)(?:\/attempts\/\d+)?\/?$/);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || !match) return null;
    if (`${match[1]}/${match[2]}`.toLowerCase() !== String(repo).toLowerCase()) return null;
    return Number(match[3]);
  } catch {
    return null;
  }
}

function workflowRunTimestamp(check = {}) {
  const run = check.workflowRun;
  if (!run) return Number.NEGATIVE_INFINITY;
  return Date.parse(run.run_started_at || run.created_at || '') || Number.NEGATIVE_INFINITY;
}

function hasAttestedWorkflowRun(check, name, revision = {}) {
  const kind = CHECK_KIND_BY_NAME[name];
  if (kind !== 'test' && kind !== 'security') return true;
  const repoPolicy = VERDICT_WORKFLOW_POLICIES[revision.repo];
  const kindPolicy = repoPolicy?.[kind];
  const run = check.workflowRun;
  const runId = parseWorkflowRunId(check.details_url || check.detailsUrl, revision.repo);
  if (!kindPolicy || !run || !runId || Number(run.id) !== runId) return false;
  if (run.event !== 'workflow_dispatch' || run.head_branch !== repoPolicy.defaultBranch) return false;
  if (run.path !== kindPolicy.path || run.display_title !== kindPolicy.title(revision)) return false;
  const checkState = normalizeState(check);
  if (checkState === 'SUCCESS') return run.status === 'completed' && run.conclusion === 'success';
  if (['FAILURE', 'ACTION_REQUIRED'].includes(checkState)) {
    return run.status === 'completed' && run.conclusion === 'failure';
  }
  return run.status !== 'completed' && !run.conclusion;
}

function matchesRevision(check, name, revision = {}) {
  const checkHeadSha = check.headSha || check.head_sha || check.checkSuite?.headSha || check.check_suite?.head_sha;
  if (revision.headSha && checkHeadSha && checkHeadSha !== revision.headSha) return false;

  const externalId = check.externalId || check.external_id;
  const expected = expectedExternalId(name, revision);
  const kind = CHECK_KIND_BY_NAME[name];
  const hasIdentityMetadata = checkHeadSha || Object.hasOwn(check, 'externalId') || Object.hasOwn(check, 'external_id');
  if (kind && (hasIdentityMetadata || ((kind === 'test' || kind === 'security') && VERDICT_WORKFLOW_POLICIES[revision.repo]))) {
    if (!expected) return false;
    const appSlug = check.app?.slug || check.appSlug || check.app_slug;
    return externalId === expected && TRUSTED_CHECK_APPS.has(appSlug) &&
      hasAttestedWorkflowRun(check, name, revision);
  }

  // statusCheckRollup is already scoped to the PR's current head. It does not
  // expose headSha/externalId, so missing metadata is accepted from that caller.
  return true;
}

function latestChecksByName(checks = [], revision = {}) {
  const latest = new Map();

  checks.forEach((check, index) => {
    const name = getCheckName(check);
    if (!matchesRevision(check, name, revision)) return;

    const kind = CHECK_KIND_BY_NAME[name];
    const timestamp = kind === 'test' || kind === 'security'
      ? workflowRunTimestamp(check)
      : checkTimestamp(check);
    const candidate = { check, timestamp, runId: Number(check.workflowRun?.id || 0), index };
    const current = latest.get(name);
    if (!current || candidate.timestamp > current.timestamp ||
        (candidate.timestamp === current.timestamp && candidate.runId > current.runId) ||
        (candidate.timestamp === current.timestamp && candidate.runId === current.runId && candidate.index > current.index)) {
      latest.set(name, candidate);
    }
  });

  return new Map(Array.from(latest, ([name, value]) => [name, value.check]));
}

function evaluateNamedCheck(latestChecks, name, seenNames = new Set()) {
  const check = latestChecks.get(name);
  if (!check) {
    if (seenNames.has(name)) {
      return { name, status: 'blocked', state: 'STALE_REVISION', approved: false, source: 'check' };
    }
    return { name, status: 'missing', state: 'MISSING', approved: false, source: 'missing' };
  }

  return { name, ...classifyState(check), source: 'check', check };
}

function getMarkedReviewKind(review, headSha) {
  if (!headSha) return null;
  const author = String(review.author?.login || review.user?.login || '').toLowerCase();
  const body = String(review.body || '').trimStart().toLowerCase();
  const commitSha = review.commit?.oid || review.commit_id || review.commitId;
  if (commitSha !== headSha) return null;

  for (const [kind, policy] of Object.entries(LEGACY_REVIEW_EVIDENCE)) {
    if (policy.authors.has(author) && body.startsWith(policy.marker)) return kind;
  }
  return null;
}

function hasLegacyReviewEvidence(reviews, kind, headSha) {
  let latest = null;
  reviews.forEach((review, index) => {
    if (getMarkedReviewKind(review, headSha) !== kind) return;
    const timestamp = Date.parse(review.submittedAt || review.submitted_at || '') || Number.NEGATIVE_INFINITY;
    if (!latest || timestamp > latest.timestamp ||
        (timestamp === latest.timestamp && index > latest.index)) {
      latest = { review, timestamp, index };
    }
  });
  return String(latest?.review?.state || '').toUpperCase() === 'APPROVED';
}

function withLegacyFallback(result, labels, legacyLabel, hasReviewEvidence) {
  if (result.status !== 'missing') return result;
  if (!labels.has(legacyLabel) || !hasReviewEvidence) return result;
  return {
    ...result,
    status: 'success',
    state: 'LEGACY_LABEL',
    approved: true,
    source: 'legacy-label',
    legacyLabel,
  };
}

function evaluateReviewReadiness({ checks = [], labels = [], reviews = [], ...revision } = {}) {
  const labelNames = getLabelNames(labels);
  const seenNames = new Set(checks.map(getCheckName));
  const latestChecks = latestChecksByName(checks, revision);
  const mergeGate = evaluateNamedCheck(latestChecks, CHECK_NAMES.merge, seenNames);
  const testCheck = evaluateNamedCheck(latestChecks, CHECK_NAMES.test, seenNames);
  const securityCheck = evaluateNamedCheck(latestChecks, CHECK_NAMES.security, seenNames);
  const hasCanonicalChecks = [CHECK_NAMES.test, CHECK_NAMES.security].some(name => seenNames.has(name));
  // The legacy path is all-or-nothing. Once any canonical check exists, a
  // missing sibling cannot be supplied by a label from the old state machine.
  const test = hasCanonicalChecks ? testCheck : withLegacyFallback(
    testCheck,
    labelNames,
    LEGACY_APPROVAL_LABELS.test,
    hasLegacyReviewEvidence(reviews, 'test', revision.headSha)
  );
  const security = hasCanonicalChecks ? securityCheck : withLegacyFallback(
    securityCheck,
    labelNames,
    LEGACY_APPROVAL_LABELS.security,
    hasLegacyReviewEvidence(reviews, 'security', revision.headSha)
  );
  const needsCoderFix = labelNames.has('needs:coder-fix');

  if (needsCoderFix) {
    return {
      approved: false,
      status: 'changes_requested',
      source: mergeGate.status === 'missing' ? 'operational-label' : 'merge-gate',
      needsCoderFix,
      hasCanonicalChecks,
      mergeGate,
      test,
      security,
    };
  }

  if (mergeGate.status !== 'missing' && !mergeGate.approved) {
    return {
      approved: false,
      status: mergeGate.status,
      source: 'merge-gate',
      needsCoderFix,
      hasCanonicalChecks,
      mergeGate,
      test,
      security,
    };
  }

  const approved = test.approved && security.approved;
  const sources = new Set([test.source, security.source]);
  let source = hasCanonicalChecks ? 'verdict-checks' : 'missing';
  if (!hasCanonicalChecks && sources.size === 1 && sources.has('legacy-label')) source = 'legacy-labels';

  const hasBlockedVerdict = [test, security].some(result => result.status === 'blocked');
  return {
    approved,
    status: approved ? 'success' : hasBlockedVerdict ? 'blocked' : 'pending',
    source,
    needsCoderFix,
    hasCanonicalChecks,
    mergeGate,
    test,
    security,
  };
}

function hasCanonicalReviewChecks(checks = []) {
  return checks.some(check => CHECK_KIND_BY_NAME[getCheckName(check)]);
}

function replaceCanonicalChecksWithMetadata(checks = [], checkRuns) {
  const expectedNames = new Set(
    checks.map(getCheckName).filter(name => CHECK_KIND_BY_NAME[name])
  );
  if (expectedNames.size === 0) return checks;

  const nonCanonical = checks.filter(check => !CHECK_KIND_BY_NAME[getCheckName(check)]);
  const canonicalRuns = Array.isArray(checkRuns)
    ? checkRuns.filter(check => CHECK_KIND_BY_NAME[getCheckName(check)])
    : [];
  const returnedNames = new Set(canonicalRuns.map(getCheckName));

  for (const name of expectedNames) {
    if (!returnedNames.has(name)) {
      canonicalRuns.push({
        name,
        status: 'COMPLETED',
        conclusion: 'ACTION_REQUIRED',
        state: 'ACTION_REQUIRED',
        metadataUnavailable: true,
      });
    }
  }

  return [...nonCanonical, ...canonicalRuns];
}

function summarizeCiChecks(checks = [], revision = {}) {
  const latestChecks = latestChecksByName(checks, revision);
  const deterministic = Array.from(latestChecks.entries())
    .filter(([name]) => !REVIEW_CONTROL_CHECK_NAMES.has(name));

  if (deterministic.length === 0) {
    return { status: 'no_checks', failing: [], pending: [], passing: [] };
  }

  const failing = [];
  const pending = [];
  const passing = [];

  for (const [name, check] of deterministic) {
    const result = classifyState(check);
    if (result.status === 'success') passing.push(name);
    else if (result.status === 'pending') pending.push(name);
    else failing.push(name);
  }

  // Wait for the run to settle before asking the coder to repair failures.
  if (pending.length > 0) return { status: 'pending', failing, pending, passing };
  if (failing.length > 0) return { status: 'failing', failing, pending, passing };
  return { status: 'green', failing, pending, passing };
}

module.exports = {
  CHECK_NAMES,
  LEGACY_APPROVAL_LABELS,
  LEGACY_REVIEW_EVIDENCE,
  REVIEW_CONTROL_CHECK_NAMES,
  TRUSTED_CHECK_APPS,
  VERDICT_WORKFLOW_POLICIES,
  evaluateReviewReadiness,
  getMarkedReviewKind,
  hasCanonicalReviewChecks,
  latestChecksByName,
  parseWorkflowRunId,
  replaceCanonicalChecksWithMetadata,
  summarizeCiChecks,
};
