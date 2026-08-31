#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { hydrateCanonicalCheckMetadata } = require('../services/lib/github-review-checks');

const {
  CHECK_NAMES,
  evaluateReviewReadiness,
  getMarkedReviewKind,
  replaceCanonicalChecksWithMetadata,
  summarizeCiChecks,
} = require('../services/lib/review-verdicts');

const REVISION = {
  repo: 'thiagown1/turbo_station',
  prNumber: 1894,
  headSha: 'a'.repeat(40),
  baseSha: 'b'.repeat(40),
  baseAncestryCurrent: true,
};

function check(name, state, startedAt = '2026-08-31T12:00:00Z', extra = {}) {
  const kind = name === CHECK_NAMES.test ? 'test' : name === CHECK_NAMES.security ? 'security' : null;
  const provenance = kind ? {
    head_sha: REVISION.headSha,
    external_id: `review-verdict:v1:${REVISION.repo}:pr:${REVISION.prNumber}:${kind}:head:${REVISION.headSha}:base:${REVISION.baseSha}`,
    app: { slug: 'github-actions' },
    details_url: `https://github.com/${REVISION.repo}/actions/runs/${kind === 'test' ? 101 : 201}/attempts/1`,
    workflowRun: {
      id: kind === 'test' ? 101 : 201,
      event: 'workflow_dispatch',
      status: state === 'SUCCESS' || state === 'FAILURE' || state === 'ACTION_REQUIRED'
        ? 'completed' : 'in_progress',
      conclusion: state === 'SUCCESS' ? 'success'
        : state === 'FAILURE' || state === 'ACTION_REQUIRED' ? 'failure' : null,
      head_branch: 'master',
      path: `.github/workflows/agent-${kind === 'test' ? 'test' : 'sec'}-review.yml`,
      display_title: `${kind === 'test' ? 'Test' : 'Security'} review verdict PR #${REVISION.prNumber} head ${REVISION.headSha} base ${REVISION.baseSha}`,
      run_started_at: startedAt,
    },
  } : {};
  return {
    name,
    state,
    startedAt,
    completedAt: state === 'SUCCESS' ? startedAt : '0001-01-01T00:00:00Z',
    ...provenance,
    ...extra,
  };
}

function review(kind, headSha = REVISION.headSha, extra = {}) {
  return {
    state: 'APPROVED',
    body: `[${kind}-review] approved`,
    commit: { oid: headSha },
    author: { login: 'TurboStation-ai' },
    ...extra,
  };
}

test('canonical review verdict checks approve the current PR revision without labels', () => {
  const result = evaluateReviewReadiness({
    checks: [
      check(CHECK_NAMES.test, 'SUCCESS'),
      check(CHECK_NAMES.security, 'SUCCESS'),
    ],
    labels: [],
    ...REVISION,
  });

  assert.equal(result.approved, true);
  assert.equal(result.source, 'verdict-checks');
  assert.equal(result.test.source, 'check');
  assert.equal(result.security.source, 'check');
});

test('a present verdict check is authoritative and never falls back on an approval label', () => {
  for (const state of ['IN_PROGRESS', 'PENDING', 'NEUTRAL', 'SKIPPED', 'CANCELLED', 'FAILURE']) {
    const result = evaluateReviewReadiness({
      checks: [
        check(CHECK_NAMES.test, state),
        check(CHECK_NAMES.security, 'SUCCESS'),
      ],
      labels: ['reviewed:tests', 'reviewed:security'],
      ...REVISION,
    });

    assert.equal(result.approved, false, `${state} must stay fail-closed`);
    assert.equal(result.test.source, 'check');
  }
});

test('legacy approval labels are only a fallback while every canonical check is absent', () => {
  const legacy = evaluateReviewReadiness({
    checks: [],
    labels: ['reviewed:tests', 'reviewed:security'],
    reviews: [review('test'), review('sec')],
    ...REVISION,
  });
  assert.equal(legacy.approved, true);
  assert.equal(legacy.source, 'legacy-labels');

  const mixed = evaluateReviewReadiness({
    checks: [check(CHECK_NAMES.test, 'SUCCESS')],
    labels: ['reviewed:security'],
    reviews: [review('sec')],
    ...REVISION,
  });
  assert.equal(mixed.approved, false);
  assert.equal(mixed.source, 'verdict-checks');
  assert.equal(mixed.hasCanonicalChecks, true);
  assert.equal(mixed.security.source, 'missing');

  const missing = evaluateReviewReadiness({ checks: [], labels: [], ...REVISION });
  assert.equal(missing.approved, false);
  assert.equal(missing.test.status, 'missing');
  assert.equal(missing.security.status, 'missing');
});

test('legacy labels cannot approve without matching marker and exact head review evidence', () => {
  const labels = ['reviewed:tests', 'reviewed:security'];
  const cases = [
    [],
    [review('test'), review('sec', 'old-head')],
    [review('test'), review('security')],
    [review('test'), review('sec', REVISION.headSha, { state: 'COMMENTED' })],
  ];

  for (const reviews of cases) {
    const result = evaluateReviewReadiness({ checks: [], labels, reviews, ...REVISION });
    assert.equal(result.approved, false);
  }
});

test('a later marked changes-requested review overrides an earlier legacy approval', () => {
  const result = evaluateReviewReadiness({
    checks: [],
    labels: ['reviewed:tests', 'reviewed:security'],
    reviews: [
      review('test', REVISION.headSha, { submittedAt: '2026-08-31T12:00:00Z' }),
      review('test', REVISION.headSha, {
        submittedAt: '2026-08-31T12:05:00Z',
        state: 'CHANGES_REQUESTED',
      }),
      review('sec'),
    ],
    ...REVISION,
  });

  assert.equal(result.approved, false);
  assert.equal(result.test.status, 'missing');
});

test('marked review classification rejects ambiguous authors, markers, and stale commits', () => {
  assert.equal(getMarkedReviewKind(review('test'), REVISION.headSha), 'test');
  assert.equal(getMarkedReviewKind(review('sec'), REVISION.headSha), 'security');
  assert.equal(getMarkedReviewKind(review('test', 'old-head'), REVISION.headSha), null);
  assert.equal(getMarkedReviewKind(review('security'), REVISION.headSha), null);
  assert.equal(getMarkedReviewKind(review('test', REVISION.headSha, {
    author: { login: 'untrusted-user' },
  }), REVISION.headSha), null);
});

test('Merge Gate success is redundant while every non-success state blocks', () => {
  const success = evaluateReviewReadiness({
    checks: [check(CHECK_NAMES.merge, 'SUCCESS')],
    labels: ['reviewed:tests', 'reviewed:security'],
    reviews: [review('test'), review('sec')],
    ...REVISION,
  });
  assert.equal(success.approved, true);
  assert.equal(success.source, 'legacy-labels');

  const alone = evaluateReviewReadiness({
    checks: [check(CHECK_NAMES.merge, 'SUCCESS')],
    labels: [],
    ...REVISION,
  });
  assert.equal(alone.approved, false);

  for (const state of ['IN_PROGRESS', 'NEUTRAL', 'SKIPPED', 'CANCELLED', 'FAILURE']) {
    const blocked = evaluateReviewReadiness({
      checks: [check(CHECK_NAMES.merge, state)],
      labels: ['reviewed:tests', 'reviewed:security'],
      ...REVISION,
    });
    assert.equal(blocked.approved, false, `${state} Merge Gate must stay fail-closed`);
    assert.equal(blocked.source, 'merge-gate');
  }
});

test('needs:coder-fix remains an operational blocker even after a successful Merge Gate', () => {
  const result = evaluateReviewReadiness({
    checks: [check(CHECK_NAMES.merge, 'SUCCESS')],
    labels: ['needs:coder-fix'],
    ...REVISION,
  });

  assert.equal(result.approved, false);
  assert.equal(result.status, 'changes_requested');
});

test('a newer attested pending rerun cannot approve over an older success', () => {
  const pending = check(CHECK_NAMES.test, 'IN_PROGRESS', '2026-08-31T12:05:00Z');
  pending.details_url = `https://github.com/${REVISION.repo}/actions/runs/102/attempts/1`;
  pending.workflowRun.id = 102;
  const result = evaluateReviewReadiness({
    checks: [
      check(CHECK_NAMES.test, 'SUCCESS', '2026-08-31T12:00:00Z'),
      pending,
      check(CHECK_NAMES.security, 'SUCCESS', '2026-08-31T12:00:00Z'),
    ],
    labels: ['reviewed:tests'],
    ...REVISION,
  });

  assert.equal(result.approved, false);
  assert.equal(result.test.status, 'pending');
});

test('checks carrying revision metadata must match both current head and base', () => {
  const expectedExternalId =
    `review-verdict:v1:thiagown1/turbo_station:pr:1894:test:head:${REVISION.headSha}:base:${REVISION.baseSha}`;

  const current = evaluateReviewReadiness({
    checks: [
      check(CHECK_NAMES.test, 'SUCCESS', undefined, {
        headSha: REVISION.headSha,
        externalId: expectedExternalId,
        app: { slug: 'github-actions' },
      }),
      check(CHECK_NAMES.security, 'SUCCESS'),
    ],
    labels: [],
    ...REVISION,
  });
  assert.equal(current.approved, true);

  const incompleteRevision = evaluateReviewReadiness({
    checks: [
      check(CHECK_NAMES.test, 'SUCCESS', undefined, {
        headSha: REVISION.headSha,
        externalId: expectedExternalId,
        app: { slug: 'github-actions' },
      }),
      check(CHECK_NAMES.security, 'SUCCESS'),
    ],
    labels: [],
    ...REVISION,
    baseSha: undefined,
  });
  assert.equal(incompleteRevision.approved, false);
  assert.equal(incompleteRevision.test.state, 'STALE_REVISION');

  const staleBase = evaluateReviewReadiness({
    checks: [
      check(CHECK_NAMES.test, 'SUCCESS', undefined, {
        headSha: 'head-123',
        externalId: expectedExternalId.replace(`base:${REVISION.baseSha}`, 'base:old-base'),
        app: { slug: 'github-actions' },
      }),
      check(CHECK_NAMES.security, 'SUCCESS'),
    ],
    labels: [],
    ...REVISION,
  });
  assert.equal(staleBase.approved, false);
  assert.equal(staleBase.test.status, 'blocked');
  assert.equal(staleBase.test.state, 'STALE_REVISION');

  const missingIdentity = evaluateReviewReadiness({
    checks: [
      check(CHECK_NAMES.test, 'SUCCESS', undefined, { head_sha: REVISION.headSha, external_id: null }),
      check(CHECK_NAMES.security, 'SUCCESS'),
    ],
    labels: ['reviewed:tests'],
    reviews: [review('test')],
    ...REVISION,
  });
  assert.equal(missingIdentity.approved, false);
  assert.equal(missingIdentity.test.state, 'STALE_REVISION');

  const untrustedApp = evaluateReviewReadiness({
    checks: [
      check(CHECK_NAMES.test, 'SUCCESS', undefined, {
        head_sha: REVISION.headSha,
        external_id: expectedExternalId,
        app: { slug: 'unknown-app' },
      }),
      check(CHECK_NAMES.security, 'SUCCESS'),
    ],
    labels: ['reviewed:tests'],
    reviews: [review('test')],
    ...REVISION,
  });
  assert.equal(untrustedApp.approved, false);
  assert.equal(untrustedApp.test.state, 'STALE_REVISION');
});

test('a successful verdict requires the exact attested workflow run provenance', () => {
  const mutations = [
    verdict => { verdict.details_url = 'https://github.com/other/repo/actions/runs/101'; },
    verdict => { verdict.details_url = `https://github.com/${REVISION.repo}/actions/runs/not-a-number`; },
    verdict => { verdict.workflowRun.id = 999; },
    verdict => { verdict.workflowRun.path = '.github/workflows/other.yml'; },
    verdict => { verdict.workflowRun.event = 'push'; },
    verdict => { verdict.workflowRun.head_branch = 'feature'; },
    verdict => { verdict.workflowRun.display_title += ' spoofed'; },
    verdict => { verdict.workflowRun.status = 'in_progress'; verdict.workflowRun.conclusion = null; },
    verdict => { verdict.workflowRun.conclusion = 'failure'; },
  ];
  for (const mutate of mutations) {
    const verdict = structuredClone(check(CHECK_NAMES.test, 'SUCCESS'));
    mutate(verdict);
    const result = evaluateReviewReadiness({
      checks: [verdict, check(CHECK_NAMES.security, 'SUCCESS')],
      labels: ['reviewed:tests', 'reviewed:security'],
      reviews: [review('test'), review('sec')],
      ...REVISION,
    });
    assert.equal(result.approved, false);
    assert.equal(result.test.status, 'blocked');
  }
});

test('a higher attested run id failure invalidates an older approval regardless of timestamps', () => {
  const older = check(CHECK_NAMES.test, 'SUCCESS', '2026-08-31T14:00:00Z');
  older.workflowRun.run_started_at = '2026-08-31T12:00:00Z';
  const newer = check(CHECK_NAMES.test, 'FAILURE', '2026-08-31T11:00:00Z');
  newer.details_url = `https://github.com/${REVISION.repo}/actions/runs/102/attempts/1`;
  newer.workflowRun.id = 102;
  newer.workflowRun.run_started_at = '2026-08-31T13:00:00Z';
  const result = evaluateReviewReadiness({
    checks: [older, newer, check(CHECK_NAMES.security, 'SUCCESS')],
    ...REVISION,
  });
  assert.equal(result.approved, false);
  assert.equal(result.test.state, 'FAILURE');
});

test('OCPP verdicts use their main-branch workflow contract and never trust Merge Gate alone', () => {
  const revision = { repo: 'thiagown1/ocpp_server', prNumber: 77, headSha: 'c'.repeat(40), baseSha: 'd'.repeat(40), baseAncestryCurrent: true };
  const ocppVerdict = (kind, id) => ({
    name: kind === 'test' ? CHECK_NAMES.test : CHECK_NAMES.security,
    status: 'completed', conclusion: 'success', head_sha: revision.headSha,
    external_id: `review-verdict:v1:${revision.repo}:pr:${revision.prNumber}:${kind}:head:${revision.headSha}:base:${revision.baseSha}`,
    app: { slug: 'github-actions' },
    details_url: `https://github.com/${revision.repo}/actions/runs/${id}/attempts/1`,
    workflowRun: {
      id, event: 'workflow_dispatch', status: 'completed', conclusion: 'success', head_branch: 'main',
      path: `.github/workflows/agent-${kind === 'test' ? 'test' : 'sec'}-review.yml`,
      display_title: `${kind === 'test' ? 'Test' : 'Security'} review PR #${revision.prNumber} head ${revision.headSha} base ${revision.baseSha}`,
      run_started_at: '2026-08-31T12:00:00Z',
    },
  });
  assert.equal(evaluateReviewReadiness({ checks: [ocppVerdict('test', 301), ocppVerdict('security', 302)], ...revision }).approved, true);
  assert.equal(evaluateReviewReadiness({ checks: [check(CHECK_NAMES.merge, 'SUCCESS')], ...revision }).approved, false);
});

test('REST metadata hydration fails closed when canonical check identity is unavailable', () => {
  const rollup = [
    check(CHECK_NAMES.test, 'SUCCESS'),
    check('Unit Tests', 'SUCCESS'),
  ];
  const hydrated = replaceCanonicalChecksWithMetadata(rollup, null);
  const result = evaluateReviewReadiness({
    checks: hydrated,
    labels: ['reviewed:tests', 'reviewed:security'],
    reviews: [review('test'), review('sec')],
    ...REVISION,
  });

  assert.equal(result.approved, false);
  assert.equal(result.test.state, 'STALE_REVISION');
  assert.equal(summarizeCiChecks(hydrated).status, 'green');
});

test('canonical checks are hydrated from the current head and require trusted REST identity', () => {
  const headSha = 'a'.repeat(40);
  const baseSha = 'b'.repeat(40);
  const repo = 'thiagown1/turbo_station';
  const pr = {
    number: 1894,
    headRefOid: headSha,
    baseRefOid: baseSha,
    statusCheckRollup: [check(CHECK_NAMES.merge, 'SUCCESS')],
  };
  let command = '';

  hydrateCanonicalCheckMetadata(pr, {
    repo,
    run: (cmd) => {
      command = cmd;
      if (cmd.includes('/compare/')) return JSON.stringify({ behind_by: 0 });
      return JSON.stringify([{
        name: CHECK_NAMES.merge,
        status: 'completed',
        conclusion: 'success',
        head_sha: headSha,
        external_id: `review-verdict:v1:${repo}:pr:1894:merge:head:${headSha}:base:${baseSha}`,
        app: { slug: 'github-actions' },
        started_at: '2026-08-31T12:00:00Z',
        completed_at: '2026-08-31T12:01:00Z',
      }]);
    },
  });

  assert.match(command, new RegExp(`/commits/${headSha}/check-runs`));
  const result = evaluateReviewReadiness({
    checks: pr.statusCheckRollup,
    labels: [],
    repo,
    prNumber: 1894,
    headSha,
    baseSha,
    baseAncestryCurrent: pr.baseAncestryCurrent,
  });
  assert.equal(result.approved, false);
  assert.equal(result.source, 'missing');

  const unavailable = {
    number: 1894,
    headRefOid: headSha,
    baseRefOid: baseSha,
    statusCheckRollup: [check(CHECK_NAMES.merge, 'SUCCESS')],
  };
  let unavailableCalls = 0;
  hydrateCanonicalCheckMetadata(unavailable, {
    repo,
    run: cmd => cmd.includes('/compare/') ? JSON.stringify({ behind_by: 0 }) : '',
    onUnavailable: () => { unavailableCalls++; },
  });
  assert.equal(unavailableCalls, 1);
  assert.equal(evaluateReviewReadiness({
    checks: unavailable.statusCheckRollup,
    repo,
    prNumber: 1894,
    headSha,
    baseSha,
    baseAncestryCurrent: unavailable.baseAncestryCurrent,
  }).approved, false);
});

test('base ancestry compare must prove the head contains the current base', () => {
  for (const compareResult of [{ behind_by: 1 }, null, { status: 'unknown' }]) {
    const pr = {
      number: REVISION.prNumber,
      headRefOid: REVISION.headSha,
      baseRefOid: REVISION.baseSha,
      statusCheckRollup: [],
    };
    hydrateCanonicalCheckMetadata(pr, {
      repo: REVISION.repo,
      run: () => compareResult ? JSON.stringify(compareResult) : '',
    });
    const readiness = evaluateReviewReadiness({
      checks: [],
      labels: ['reviewed:tests', 'reviewed:security'],
      reviews: [review('test'), review('sec')],
      ...REVISION,
      baseAncestryCurrent: pr.baseAncestryCurrent,
    });
    assert.equal(readiness.approved, false);
    assert.equal(readiness.source, 'base-ancestry');
  }
});

test('REST hydration resolves workflow run evidence from the verdict details URL', () => {
  const pr = { number: REVISION.prNumber, headRefOid: REVISION.headSha, baseRefOid: REVISION.baseSha, statusCheckRollup: [check(CHECK_NAMES.test, 'SUCCESS')] };
  const commands = [];
  const restCheck = check(CHECK_NAMES.test, 'SUCCESS');
  delete restCheck.workflowRun;
  hydrateCanonicalCheckMetadata(pr, {
    repo: REVISION.repo,
    run: command => {
      commands.push(command);
      if (command.includes('/compare/')) return JSON.stringify({ behind_by: 0 });
      return command.includes('/check-runs') ? JSON.stringify([restCheck]) : JSON.stringify(check(CHECK_NAMES.test, 'SUCCESS').workflowRun);
    },
  });
  assert.equal(commands.length, 3);
  assert.match(commands[2], /actions\/runs\/101/);
  assert.equal(evaluateReviewReadiness({ checks: pr.statusCheckRollup, ...REVISION }).approved, false);
  assert.equal(evaluateReviewReadiness({ checks: [...pr.statusCheckRollup, check(CHECK_NAMES.security, 'SUCCESS')], ...REVISION }).approved, true);
});

test('CI summary is green only when every deterministic check is explicitly successful', () => {
  assert.equal(summarizeCiChecks([]).status, 'no_checks');
  assert.equal(summarizeCiChecks([check('Unit Tests', 'IN_PROGRESS')]).status, 'pending');

  for (const state of ['NEUTRAL', 'SKIPPED', 'CANCELLED', 'FAILURE', 'TIMED_OUT']) {
    const summary = summarizeCiChecks([check('Unit Tests', state)]);
    assert.equal(summary.status, 'failing', `${state} must not count as green`);
    assert.deepEqual(summary.failing, ['Unit Tests']);
  }

  assert.equal(summarizeCiChecks([check('Unit Tests', 'SUCCESS')]).status, 'green');
});

test('review workers are excluded from deterministic CI while canonical verdicts stay fail-closed', () => {
  const summary = summarizeCiChecks([
    check('test-review', 'SKIPPED'),
    check('sec-review', 'CANCELLED'),
    check('Fix requested by reviewer', 'IN_PROGRESS'),
    check('Unit Tests', 'SUCCESS'),
  ]);

  assert.equal(summary.status, 'green');
  assert.deepEqual(summary.passing, ['Unit Tests']);

  const verdict = evaluateReviewReadiness({
    checks: [check(CHECK_NAMES.test, 'SKIPPED')],
    labels: ['reviewed:tests', 'reviewed:security'],
    ...REVISION,
  });
  assert.equal(verdict.approved, false);
});

test('reconcile, sweep, and webhook stay wired to the fail-closed compatibility contract', () => {
  const root = path.join(__dirname, '..');
  const reconcile = fs.readFileSync(path.join(root, 'services', 'reconcile.js'), 'utf8');
  const sweep = fs.readFileSync(path.join(root, 'services', 'sweep-orchestrator.js'), 'utf8');
  const webhook = fs.readFileSync(path.join(root, 'services', 'github-webhook.js'), 'utf8');

  assert.match(reconcile, /evaluateReviewReadiness/);
  assert.match(reconcile, /labels,reviews,statusCheckRollup/);
  assert.match(reconcile, /`\$\{repo\}#\$\{pr\.number\}`/);
  assert.match(sweep, /getPullRequestReviewReadiness/);
  assert.doesNotMatch(sweep, /--json name,state,conclusion/);
  assert.match(sweep, /f\.prNumber && !f\.merged && f\.prStatus === 'reviewed'/);
  assert.doesNotMatch(sweep, /f\.prStatus === 'reviewed' \|\| f\.prStatus === 'ci_green'/);
  assert.doesNotMatch(webhook, /reviewed:tests|reviewed:security/);
  assert.doesNotMatch(webhook, /--add-label', 'needs:coder-fix'/);
  assert.match(webhook, /CHANGES_REQUESTED recorded as evidence only/);
});
