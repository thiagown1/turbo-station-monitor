'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  OPENCLAW_WRITER_ATTESTATION_VARIABLE,
  buildWriterConcurrencyKey,
  canonicalizePrNumber,
  evaluateWriterAuthorization,
  formatWriterTupleGuard,
} = require('../services/lib/openclaw-writer-guard');
const { sanitizeLegacyTaskState } = require('../services/task-planner');
const { auditLegacyCoderCron, CODER_JOB_ID } = require('../services/boost');

const CURRENT = {
  number: 72,
  state: 'OPEN',
  headRefOid: 'a'.repeat(40),
  baseRefOid: 'b'.repeat(40),
};

function authorize(overrides = {}) {
  return evaluateWriterAuthorization({
    repo: 'thiagown1/turbo-station-monitor',
    prNumber: 72,
    expectedHeadSha: CURRENT.headRefOid,
    expectedBaseSha: CURRENT.baseRefOid,
    variableValue: 'true',
    currentPr: CURRENT,
    ...overrides,
  });
}

test('writer authorization fails closed unless the repository variable is exactly true', () => {
  for (const value of [undefined, '', 'false', 'TRUE', ' true', 'true ']) {
    const result = authorize({ variableValue: value });
    assert.equal(result.authorized, false);
    assert.match(result.reason, new RegExp(OPENCLAW_WRITER_ATTESTATION_VARIABLE));
  }

  assert.equal(authorize().authorized, true);
});

test('PR numbers and concurrency identities are canonical', () => {
  assert.equal(canonicalizePrNumber('00072'), '72');
  assert.equal(canonicalizePrNumber(72), '72');
  assert.equal(canonicalizePrNumber('7.2'), null);
  assert.equal(canonicalizePrNumber('-1'), null);

  assert.equal(
    buildWriterConcurrencyKey({ repo: 'thiagown1/turbo-station-monitor', prNumber: '00072' }),
    'openclaw-writer-v1:thiagown1/turbo-station-monitor:pr:72'
  );
});

test('authorization is bound to the exact latest open PR head and base', () => {
  assert.equal(authorize({ expectedHeadSha: 'c'.repeat(40) }).authorized, false);
  assert.equal(authorize({ expectedBaseSha: 'd'.repeat(40) }).authorized, false);
  assert.equal(authorize({ currentPr: { ...CURRENT, state: 'CLOSED' } }).authorized, false);
  assert.equal(authorize({ currentPr: { ...CURRENT, headRefOid: 'short' } }).authorized, false);
  assert.equal(authorize({ currentPr: { ...CURRENT, number: 73 } }).authorized, false);
});

test('authorization never blind-pins a current snapshot without both expected SHAs', () => {
  assert.equal(authorize({ expectedHeadSha: undefined }).authorized, false);
  assert.equal(authorize({ expectedBaseSha: undefined }).authorized, false);
  assert.equal(authorize({ expectedHeadSha: undefined, expectedBaseSha: undefined }).authorized, false);
});

test('the writer prompt carries the immutable tuple and external CAS instruction', () => {
  const result = authorize();
  const block = formatWriterTupleGuard(result.tuple);
  assert.match(block, /pr_number=72/);
  assert.match(block, new RegExp(`head_sha=${CURRENT.headRefOid}`));
  assert.match(block, new RegExp(`base_sha=${CURRENT.baseRefOid}`));
  assert.match(block, /Before every mutation or push/);
  assert.match(block, /Never merge or deploy/);
});

test('monitor repair paths are manual and leave executable writer queues empty', () => {
  const root = path.join(__dirname, '..');
  const webhook = fs.readFileSync(path.join(root, 'services', 'github-webhook.js'), 'utf8');
  const reconcile = fs.readFileSync(path.join(root, 'services', 'reconcile.js'), 'utf8');
  const sweep = fs.readFileSync(path.join(root, 'services', 'sweep-orchestrator.js'), 'utf8');
  const planner = fs.readFileSync(path.join(root, 'services', 'task-planner.js'), 'utf8');

  assert.doesNotMatch(webhook, /agentId:\s*'coder'/);
  assert.doesNotMatch(webhook, /authorizeOpenClawWriter/);

  assert.match(reconcile, /writerAttestationValues\[task\.repo\]/);
  assert.match(reconcile, /manual exact-tuple repair required/);
  assert.match(reconcile, /sanitizeCoderTaskState/);
  assert.doesNotMatch(reconcile, /queue: plan\.todo\.slice\(0, 5\)/);
  assert.match(reconcile, /writeWriterEvidence/);

  assert.doesNotMatch(sweep, /invokeOpenClawCoder/);
  assert.doesNotMatch(sweep, /assertOpenClawWriterAttested/);
  assert.doesNotMatch(sweep, /['"]coder['"]/);
  assert.doesNotMatch(sweep, /const labels = '[^']*(?:agent:coder|auto:implement)/);
  assert.doesNotMatch(sweep, /--label "auto:implement"/);
  assert.doesNotMatch(sweep, /--add-label "needs:(?:test|sec)-review"/);
  assert.match(sweep, /auto:none,white-label/);
  assert.match(sweep, /sanitizeCoderTaskState/);
  assert.match(sweep, /manual_rebase_required/);
  assert.match(sweep, /concurrencyKey: `openclaw-writer-v1:/);
  assert.match(planner, /fetchWriterAttestationValue\(\) === 'true'/);
  assert.match(planner, /sanitizeCoderTaskState/);
  assert.doesNotMatch(planner, /taskState\.queue = plan\.selected\.map/);
});

test('legacy executable planner state is quarantined even with no new selection', () => {
  const sanitized = sanitizeLegacyTaskState({
    schema: 'v2',
    queue: [{ action: 'fix_ci', prNumber: 10, repo: 'thiagown1/turbo_station' }],
    activeTasks: [{ action: 'implement', issueNumber: 11 }],
    blockedWriterQueue: [{ action: 'rebase', prNumber: 12 }],
    completedToday: [{ action: 'fix_review', prNumber: 9 }],
    ciFixAttempts: { evil: { queue: [{ action: 'fix_ci', prNumber: 13 }] } },
    blockedPRs: [{ action: 'fix_review', prNumber: 14 }],
    lastHeartbeat: { queue: [{ action: 'implement', issueNumber: 15 }] },
    unknownTaskField: { nested: { action: 'fix_ci', prNumber: 16 } },
  }, {
    selected: [],
    slots: { total: 0 },
    budget: null,
  }, false, '2026-08-31T00:00:00.000Z');

  assert.deepEqual(sanitized.taskState.queue, []);
  assert.deepEqual(sanitized.taskState.activeTasks, []);
  assert.equal(Object.hasOwn(sanitized.taskState, 'blockedWriterQueue'), false);
  assert.equal(Object.hasOwn(sanitized.taskState, 'completedToday'), false);
  assert.equal(Object.hasOwn(sanitized.taskState, 'ciFixAttempts'), false);
  assert.equal(Object.hasOwn(sanitized.taskState, 'blockedPRs'), false);
  assert.equal(Object.hasOwn(sanitized.taskState, 'unknownTaskField'), false);
  assert.equal(sanitized.taskState.lastHeartbeat, '2026-08-31T00:00:00.000Z');
  assert.deepEqual(
    Object.keys(sanitized.taskState).sort(),
    ['activeTasks', 'lastHeartbeat', 'queue', 'schema']
  );
  assert.equal(sanitized.evidenceTasks.length, 3);
  assert.deepEqual(
    new Set(sanitized.evidenceTasks.map(task => task.quarantinedFrom).filter(Boolean)),
    new Set(['queue', 'activeTasks', 'blockedWriterQueue'])
  );
});

test('blocked writer details are stored outside the Coder workspace', () => {
  const root = path.join(__dirname, '..');
  for (const file of ['reconcile.js', 'task-planner.js', 'sweep-orchestrator.js']) {
    const source = fs.readFileSync(path.join(root, 'services', file), 'utf8');
    assert.match(source, /writer-repair-evidence-/);
    assert.match(source, /sanitizeCoderTaskState/);
  }
  const store = fs.readFileSync(path.join(root, 'services', 'lib', 'writer-evidence-store.js'), 'utf8');
  assert.match(store, /executable: false/);
  assert.match(store, /queue: \[\]/);
  assert.match(store, /activeTasks: \[\]/);
});

test('current CI is read-only and future writer isolation is documented', () => {
  const root = path.join(__dirname, '..');
  const ci = fs.readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
  const docs = fs.readFileSync(path.join(root, 'docs', 'REVIEW_VERDICT_COMPATIBILITY.md'), 'utf8');

  assert.match(ci, /permissions:\s*\n\s*contents: read/);
  assert.doesNotMatch(ci, /(?:contents|pull-requests|issues|checks):\s*write/);
  assert.match(docs, /`openclaw-writer-v1` is reserved as a dedicated/);
  assert.match(docs, /No host may receive that\s+label before/);
  assert.match(docs, /does not create or configure that variable/);
});

test('legacy Coder boost is retired and cron state fails closed', () => {
  assert.equal(auditLegacyCoderCron({ jobs: [] }).safe, true);
  assert.equal(auditLegacyCoderCron({ jobs: [{ id: CODER_JOB_ID, enabled: false }] }).safe, true);
  assert.equal(auditLegacyCoderCron({ jobs: [{ id: CODER_JOB_ID, enabled: true }] }).safe, false);
  assert.equal(auditLegacyCoderCron({ jobs: [{ id: CODER_JOB_ID }] }).safe, false);
  assert.equal(auditLegacyCoderCron({}).safe, false);

  const root = path.join(__dirname, '..');
  const boost = fs.readFileSync(path.join(root, 'services', 'boost.js'), 'utf8');
  const reconcile = fs.readFileSync(path.join(root, 'services', 'reconcile.js'), 'utf8');
  assert.doesNotMatch(boost, /writeFileSync|nextRunAtMs|schedule\.everyMs\s*=/);
  assert.doesNotMatch(reconcile, /boost\.js/);
});

test('Scout receives a monitor-prepared immutable snapshot contract', () => {
  const sweep = fs.readFileSync(
    path.join(__dirname, '..', 'services', 'sweep-orchestrator.js'),
    'utf8'
  );
  assert.match(sweep, /function prepareScoutSnapshot\(\)/);
  assert.match(sweep, /`\+refs\/heads\/\$\{TARGET_BRANCH\}:refs\/remotes\/origin\/\$\{TARGET_BRANCH\}`/);
  assert.match(sweep, /buildSweepPrompt\(snapshotSha\)/);
  assert.match(sweep, /SNAPSHOT SHA: \$\{snapshotSha\}/);
  assert.match(sweep, /Não execute fetch, checkout, pull, commit, push/);
  assert.doesNotMatch(sweep, /cd \$\{SCOUT_DIR\} && git fetch/);
});

test('PR comments and reviews cannot auto-dispatch the Coder', () => {
  const webhook = fs.readFileSync(
    path.join(__dirname, '..', 'services', 'github-webhook.js'),
    'utf8'
  );
  assert.doesNotMatch(webhook, /name: 'Codex Review'/);
  assert.doesNotMatch(webhook, /name: 'GitHub Turbo Station'/);
  assert.doesNotMatch(webhook, /--add-label', 'needs:coder-fix'/);
  assert.doesNotMatch(webhook, /sendOpenClawWake/);
  assert.match(webhook, /PR feedback recorded; manual exact-tuple repair required/);
});

test('merged-PR cleanup cannot revive writer state or interpolate branch names into a shell', () => {
  const webhook = fs.readFileSync(
    path.join(__dirname, '..', 'services', 'github-webhook.js'),
    'utf8'
  );
  assert.doesNotMatch(webhook, /cleanupScript|WORKTREE=\$\(/);
  assert.doesNotMatch(webhook, /taskState\.queue|taskState\.activeTasks/);
  assert.match(webhook, /\['-C', TURBO_STATION_CODER_WORKSPACE, 'worktree', 'remove', '--force', worktree\]/);
  assert.match(webhook, /webhookEvent\.repository === TURBO_STATION_REPO/);
});
