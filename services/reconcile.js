#!/usr/bin/env node
/**
 * Reconcile v1 — Stateless GitHub-Based Work Planner
 *
 * Replaces task-planner.js with a live reconciliation approach.
 * Instead of maintaining persistent local state, this script queries
 * GitHub + git on every run to build a prioritized work plan.
 *
 * Core principle: GitHub + `git worktree list` are the source of truth.
 * task-state.json only stores what can't be derived (ciFixAttempts, blockedPRs).
 *
 * Usage:
 *   node reconcile.js                # Show current state (dry run)
 *   node reconcile.js --apply        # Write minimal task-state + cleanup stale worktrees
 *   node reconcile.js --status       # One-line status for heartbeat
 *   node reconcile.js --json         # Machine-readable output
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ─── Config ────────────────────────────────────────────────────────
const TASK_STATE_PATH = '/home/openclaw/.openclaw/workspace-coder/task-state.json';
const TURBO_STATION_DIR = '/home/openclaw/.openclaw/workspace-coder/turbo_station';
const WORKTREES_DIR = '/home/openclaw/.openclaw/workspace-coder/worktrees';
const BUDGET_STATE_PATH = '/home/openclaw/.openclaw/workspace/skills/turbo-station-monitor/data/budget-state.json';
const USAGE_TRACKER = path.join(__dirname, 'usage-tracker.js');

const REPOS = ['thiagown1/turbo_station', 'thiagown1/ocpp_server'];
const BOT_AUTHOR = 'TurboStation-ai';

// PR-only mode: env var `ACCEPT_NEW_ISSUES=false` disables new-issue discovery.
// Default stays true so manual `--status`/`--apply` calls still see the queue.
// The coder heartbeat cron passes ACCEPT_NEW_ISSUES=false to keep agent focused
// on existing PRs only (fix_review / fix_ci / rebase) and avoid the duplicate
// issue-spawn pathology from commit 1a0f6c153.
const ACCEPT_NEW_ISSUES = process.env.ACCEPT_NEW_ISSUES !== 'false';
const MAX_OPEN_PRS = 20;         // Soft cap — warn but don't block (human reviews)
const MAX_WORKTREES = 5;         // Ephemeral worktrees at any time (raised for batch fixes)
const MAX_CI_FIX_ATTEMPTS = 5;   // Then mark as blocked
const PR_ISSUE_PATTERN = /issue-(\d+)/i;

// Priority scoring
const PRIORITY_SCORES = {
  'Priority: P0-critical': 100,
  'Priority: P1-important': 75,
  'Priority: P2-improvement': 50,
  'Priority: P3-nice-to-have': 25,
};
const PRIORITY_VARIANTS = {
  P0: ['Priority: P0-critical', 'priority:P0', 'Priority:P0', 'P0'],
  P1: ['Priority: P1-important', 'priority:P1', 'Priority:P1', 'P1'],
  P2: ['Priority: P2-improvement', 'priority:P2', 'Priority:P2', 'P2'],
  P3: ['Priority: P3-nice-to-have', 'priority:P3', 'Priority:P3', 'P3'],
};
const TYPE_BOOSTS = {
  'type:bug': 20, 'type:security': 30, 'type:regression': 25,
  'type:test': 10, 'type:feature': 5, 'type:refactor': 0, 'type:chore': -5,
};

// ─── Helpers ───────────────────────────────────────────────────────

function exec(cmd, opts = {}) {
  try {
    return execSync(cmd, { encoding: 'utf-8', timeout: 30000, ...opts }).trim();
  } catch (err) {
    if (opts.allowFail) return '';
    throw err;
  }
}

function gh(args, repo) {
  const repoFlag = repo ? `--repo ${repo}` : '';
  return JSON.parse(exec(`gh ${args} ${repoFlag} --limit 30`, { allowFail: false }) || '[]');
}

function hasLabel(pr, name) {
  return (pr.labels || []).some(l => (l.name || l) === name);
}

function detectPriority(labelNames = []) {
  for (const [tier, variants] of Object.entries(PRIORITY_VARIANTS)) {
    if (variants.some(label => labelNames.includes(label))) return tier;
  }
  return 'P2';
}

function extractIssueNumber(branchName) {
  const match = branchName?.match(PR_ISSUE_PATTERN);
  return match ? parseInt(match[1]) : null;
}

function getChecksSummary(pr) {
  const checks = pr.statusCheckRollup || [];
  if (checks.length === 0) return { status: 'no_checks', failing: [], pending: [] };

  // Keep only the latest run per check name so old failed attempts do not block
  // the current status when a newer run passed.
  const latestPerName = new Map();
  for (const check of checks) {
    const name = check.name || check.context || 'unknown';
    const ts = new Date(check.completedAt || check.updatedAt || check.updated_at || '1970-01-01T00:00:00Z').getTime();
    const current = latestPerName.get(name);
    const currentTs = current
      ? new Date(current.completedAt || current.updatedAt || current.updated_at || '1970-01-01T00:00:00Z').getTime()
      : -1;

    if (!current || ts >= currentTs) {
      latestPerName.set(name, check);
    }
  }

  const latestChecks = Array.from(latestPerName.values());
  const failing = [];
  const pending = [];
  const passing = [];

  for (const check of latestChecks) {
    const name = check.name || check.context || 'unknown';
    if (check.status === 'COMPLETED' || check.state) {
      const conclusion = check.conclusion || check.state;
      if (conclusion === 'SUCCESS' || conclusion === 'NEUTRAL' || conclusion === 'SKIPPED') {
        passing.push(name);
      } else if (conclusion === 'FAILURE' || conclusion === 'ERROR' || conclusion === 'TIMED_OUT') {
        failing.push(name);
      } else if (conclusion === 'CANCELLED') {
        // Ignore cancelled checks
      } else {
        passing.push(name); // e.g. Vercel SUCCESS state
      }
    } else {
      pending.push(name);
    }
  }

  if (pending.length > 0) return { status: 'pending', failing, pending, passing };
  if (failing.length > 0) return { status: 'failing', failing, pending, passing };
  return { status: 'green', failing, pending, passing };
}

// ─── Data Collection ───────────────────────────────────────────────

function fetchOpenPRs() {
  const allPRs = [];
  const seenNumbers = new Set();

  for (const repo of REPOS) {
    try {
      // 1. Fetch bot's own PRs
      const botPRs = gh(
        `pr list --author ${BOT_AUTHOR} --state open --json number,title,headRefName,mergeable,labels,statusCheckRollup,updatedAt`,
        repo
      );
      for (const pr of botPRs) {
        pr.repo = repo;
        pr.labelNames = (pr.labels || []).map(l => l.name || l);
        pr.issueNumber = extractIssueNumber(pr.headRefName);
        pr.checks = getChecksSummary(pr);
        allPRs.push(pr);
        seenNumbers.add(pr.number);
      }

      // 2. Also fetch PRs from ANY author with needs:coder-fix (e.g. human PRs)
      const coderFixPRs = gh(
        `pr list --label "needs:coder-fix" --state open --json number,title,headRefName,mergeable,labels,statusCheckRollup,updatedAt`,
        repo
      );
      for (const pr of coderFixPRs) {
        if (seenNumbers.has(pr.number)) continue; // skip duplicates
        pr.repo = repo;
        pr.labelNames = (pr.labels || []).map(l => l.name || l);
        pr.issueNumber = extractIssueNumber(pr.headRefName);
        pr.checks = getChecksSummary(pr);
        allPRs.push(pr);
        seenNumbers.add(pr.number);
      }
    } catch (err) {
      console.error(`  ⚠️  Failed to fetch PRs for ${repo}: ${err.message}`);
    }
  }
  return allPRs;
}

function fetchNewIssues(existingIssueNumbers) {
  const allIssues = [];
  for (const repo of REPOS) {
    try {
      const issues = gh(
        `issue list --label "agent:coder" --label "auto:implement" --label "white-label" --state open --json number,title,labels,createdAt`,
        repo
      );
      for (const issue of issues) {
        issue.repo = repo;
        issue.labelNames = (issue.labels || []).map(l => l.name || l);
        // Skip issues that already have PRs or are blocked/done
        if (existingIssueNumbers.has(issue.number)) continue;
        if (issue.labelNames.includes('status:done')) continue;
        if (issue.labelNames.includes('status:blocked')) continue;
        allIssues.push(issue);
      }
    } catch (err) {
      console.error(`  ⚠️  Failed to fetch issues for ${repo}: ${err.message}`);
    }
  }
  return scoreIssues(allIssues);
}

function scoreIssues(issues) {
  return issues.map(i => {
    let score = 0;
    const priorityTier = detectPriority(i.labelNames);
    if (priorityTier === 'P0') score += PRIORITY_SCORES['Priority: P0-critical'];
    else if (priorityTier === 'P1') score += PRIORITY_SCORES['Priority: P1-important'];
    else if (priorityTier === 'P2') score += PRIORITY_SCORES['Priority: P2-improvement'];
    else if (priorityTier === 'P3') score += PRIORITY_SCORES['Priority: P3-nice-to-have'];

    for (const [label, boost] of Object.entries(TYPE_BOOSTS)) {
      if (i.labelNames.includes(label)) score += boost;
    }
    if (i.labelNames.includes('white-label')) score += 15;
    if (/tenant|isolation|cross[- ]?tenant/i.test(i.title || '')) score += 20;
    if (/payment|fallback|routingpaymentgateway|pix/i.test(i.title || '')) score += 10;

    // Age bonus (max 10 pts for 7+ days old)
    const ageDays = (Date.now() - new Date(i.createdAt).getTime()) / 86400000;
    score += Math.min(10, Math.floor(ageDays));

    i.priority = priorityTier;
    i.score = score;
    return i;
  }).sort((a, b) => b.score - a.score);
}

function getWorktrees() {
  const output = exec(`cd ${TURBO_STATION_DIR} && git worktree list --porcelain`, { allowFail: true });
  if (!output) return [];

  const worktrees = [];
  let current = {};

  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current.path) worktrees.push(current);
      current = { path: line.replace('worktree ', '') };
    } else if (line.startsWith('branch ')) {
      current.branch = line.replace('branch refs/heads/', '');
    } else if (line === 'bare') {
      current.bare = true;
    } else if (line.startsWith('HEAD ')) {
      current.head = line.replace('HEAD ', '');
    }
  }
  if (current.path) worktrees.push(current);

  // Exclude the main clone
  return worktrees.filter(w => !w.bare && w.path !== TURBO_STATION_DIR);
}

function readTaskState() {
  try {
    return JSON.parse(fs.readFileSync(TASK_STATE_PATH, 'utf-8'));
  } catch {
    return { schema: 'v3', ciFixAttempts: {}, blockedPRs: [], lastHeartbeat: null };
  }
}

function getBudgetStatus() {
  try {
    exec(`node ${USAGE_TRACKER} --json`, { timeout: 20000 });
    const budget = JSON.parse(fs.readFileSync(BUDGET_STATE_PATH, 'utf-8'));
    const h5 = budget.windows?.['5h'];
    const weekly = budget.windows?.weekly;
    if (!h5 || !weekly) return 'OK';
    if (h5.remainingPct < 10 || weekly.remainingPct < 5) return 'PAUSE';
    return 'OK'; // Liberado para torrar cota (reset amanhã)
  } catch {
    return 'OK'; // Default to OK if budget check fails
  }
}

// ─── Reconciliation Logic ──────────────────────────────────────────

function reconcile() {
  const taskState = readTaskState();
  const ciFixAttempts = taskState.ciFixAttempts || {};
  const blockedPRs = new Set(taskState.blockedPRs || []);

  // 1. Fetch live data from GitHub
  const openPRs = fetchOpenPRs();
  const worktrees = getWorktrees();

  // 2. Categorize PRs
  const categories = {
    needsCoderFix: [],   // Priority 1: reviewer said fix something
    ciFailing: [],       // Priority 2: CI is red
    conflicting: [],     // Priority 3: merge conflicts
    ciPending: [],       // Waiting: CI still running
    readyToMerge: [],    // Done: all green + reviewed, waiting for human/auto-merge
    blocked: [],         // Blocked: too many CI fix attempts or explicitly blocked
  };

  for (const pr of openPRs) {
    const prKey = String(pr.number);

    // Skip explicitly blocked PRs
    if (blockedPRs.has(pr.number) || hasLabel(pr, 'status:blocked')) {
      categories.blocked.push(pr);
      continue;
    }

    // Check CI fix attempts
    const attempts = ciFixAttempts[prKey] || 0;
    if (attempts >= MAX_CI_FIX_ATTEMPTS) {
      categories.blocked.push(pr);
      continue;
    }

    // Categorize by state — conflicts are HIGHEST priority (block everything)
    if (pr.mergeable === 'CONFLICTING') {
      categories.conflicting.push(pr);
    } else if (hasLabel(pr, 'needs:coder-fix')) {
      categories.needsCoderFix.push(pr);
    } else if (pr.checks.status === 'failing') {
      categories.ciFailing.push(pr);
    } else if (pr.checks.status === 'pending') {
      categories.ciPending.push(pr);
    } else if (pr.checks.status === 'green') {
      // All checks pass — is it reviewed?
      const hasTestReview = hasLabel(pr, 'reviewed:tests');
      const hasSecReview = hasLabel(pr, 'reviewed:security');
      if (hasTestReview && hasSecReview) {
        categories.readyToMerge.push(pr);
      } else {
        // CI green but missing reviews — nothing for coder to do
        categories.ciPending.push(pr); // treat as "waiting"
      }
    } else {
      categories.ciPending.push(pr); // no checks = waiting
    }
  }

  // 3. Map worktrees to PRs to find stale ones
  const prBranches = new Set(openPRs.map(pr => pr.headRefName));
  const staleWorktrees = worktrees.filter(wt => !prBranches.has(wt.branch));
  const activeWorktrees = worktrees.filter(wt => prBranches.has(wt.branch));

  // 4. Check for new issues (only if under PR cap)
  const issuesWithPRs = new Set(openPRs.map(pr => pr.issueNumber).filter(Boolean));
  const actionablePRCount = openPRs.length - categories.blocked.length;
  const canTakeNewWork = ACCEPT_NEW_ISSUES && actionablePRCount < MAX_OPEN_PRS;
  const newIssues = canTakeNewWork ? fetchNewIssues(issuesWithPRs) : [];

  // 5. Build prioritized TODO list for this heartbeat
  const todo = [];

  // Priority 1: Coder fix requests from reviewers
  for (const pr of categories.needsCoderFix) {
    todo.push({
      action: 'fix_review',
      pr: pr.number,
      repo: pr.repo,
      branch: pr.headRefName,
      title: pr.title,
      reason: 'Reviewer requested changes (needs:coder-fix)',
      priority: 100,
    });
  }

  // Priority 2: CI failures (only if no checks pending)
  for (const pr of categories.ciFailing) {
    const attempts = ciFixAttempts[String(pr.number)] || 0;
    todo.push({
      action: 'fix_ci',
      pr: pr.number,
      repo: pr.repo,
      branch: pr.headRefName,
      title: pr.title,
      failingChecks: pr.checks.failing,
      attempts,
      reason: `CI failing: ${pr.checks.failing.join(', ')} (attempt ${attempts + 1}/${MAX_CI_FIX_ATTEMPTS})`,
      priority: 90 - attempts * 5,
    });
  }

  // Priority 1: Merge conflicts (highest — blocks everything else)
  for (const pr of categories.conflicting) {
    todo.push({
      action: 'rebase',
      pr: pr.number,
      repo: pr.repo,
      branch: pr.headRefName,
      title: pr.title,
      reason: 'PR has merge conflicts — must rebase before anything else',
      priority: 110,
    });
  }

  // Priority 4: New issues (if under PR cap)
  for (const issue of newIssues.slice(0, MAX_OPEN_PRS - actionablePRCount)) {
    todo.push({
      action: 'implement',
      issue: issue.number,
      repo: issue.repo,
      title: issue.title,
      score: issue.score,
      priority: issue.score,
      reason: `New issue [${issue.priority}] score=${issue.score}`,
    });
  }

  // Sort by priority
  todo.sort((a, b) => b.priority - a.priority);

  // 6. Budget check
  const budgetStatus = getBudgetStatus();

  return {
    timestamp: new Date().toISOString(),
    budgetStatus,
    openPRs: {
      total: openPRs.length,
      actionable: actionablePRCount,
      readyToMerge: categories.readyToMerge.length,
      needsCoderFix: categories.needsCoderFix.length,
      ciFailing: categories.ciFailing.length,
      conflicting: categories.conflicting.length,
      ciPending: categories.ciPending.length,
      blocked: categories.blocked.length,
    },
    worktrees: {
      total: worktrees.length,
      stale: staleWorktrees.length,
      active: activeWorktrees.length,
      staleList: staleWorktrees.map(w => ({ path: w.path, branch: w.branch })),
    },
    canTakeNewWork,
    newIssuesAvailable: newIssues.length,
    todo,
    categories: {
      readyToMerge: categories.readyToMerge.map(pr => ({ number: pr.number, title: pr.title?.substring(0, 50), repo: pr.repo })),
      blocked: categories.blocked.map(pr => ({ number: pr.number, title: pr.title?.substring(0, 50), repo: pr.repo })),
    },
    ciFixAttempts,
    blockedPRs: [...blockedPRs],
  };
}

// ─── Apply ─────────────────────────────────────────────────────────

function applyPlan(plan) {
  // 1. Clean up stale worktrees
  for (const wt of plan.worktrees.staleList) {
    try {
      console.log(`  🗑️  Removing stale worktree: ${path.basename(wt.path)} (${wt.branch})`);
      exec(`cd ${TURBO_STATION_DIR} && git worktree remove --force "${wt.path}"`, { allowFail: true });
    } catch (err) {
      console.error(`  ⚠️  Failed to remove ${wt.path}: ${err.message}`);
    }
  }
  exec(`cd ${TURBO_STATION_DIR} && git worktree prune`, { allowFail: true });

  // 2. Write minimal task-state.json (v3)
  const newState = {
    schema: 'v3',
    ciFixAttempts: plan.ciFixAttempts,
    blockedPRs: plan.blockedPRs,
    lastHeartbeat: plan.timestamp,
    // Queue the top items for the coder to pick up (batch fix)
    queue: plan.todo.slice(0, 5).map(t => ({
      action: t.action,
      number: t.pr || t.issue,
      repo: t.repo,
      branch: t.branch,
      title: t.title,
      reason: t.reason,
    })),
  };

  fs.writeFileSync(TASK_STATE_PATH, JSON.stringify(newState, null, 2) + '\n');
  return newState;
}

// ─── Output ────────────────────────────────────────────────────────

function printPlan(plan) {
  console.log('═══════════════════════════════════════════════');
  console.log('  🔄 RECONCILE — Live GitHub State');
  console.log(`  ${plan.timestamp}`);
  console.log('═══════════════════════════════════════════════\n');

  // Budget
  const budgetIcon = { OK: '🟢', SLOW_DOWN: '🟡', PAUSE: '🔴' }[plan.budgetStatus] || '⚪';
  console.log(`  ${budgetIcon} Budget: ${plan.budgetStatus}\n`);

  // PR overview
  const p = plan.openPRs;
  console.log(`  📊 Open PRs: ${p.total} (${p.actionable} actionable)`);
  if (p.readyToMerge > 0) console.log(`     ✅ Ready to merge: ${p.readyToMerge}`);
  if (p.needsCoderFix > 0) console.log(`     🔧 Needs coder fix: ${p.needsCoderFix}`);
  if (p.ciFailing > 0) console.log(`     ❌ CI failing: ${p.ciFailing}`);
  if (p.conflicting > 0) console.log(`     ⚔️  Merge conflicts: ${p.conflicting}`);
  if (p.ciPending > 0) console.log(`     ⏳ CI pending/waiting: ${p.ciPending}`);
  if (p.blocked > 0) console.log(`     🚫 Blocked: ${p.blocked}`);

  // Worktrees
  const w = plan.worktrees;
  console.log(`\n  📁 Worktrees: ${w.total} (${w.stale} stale, ${w.active} for open PRs)`);
  for (const wt of plan.worktrees.staleList) {
    console.log(`     🗑️  Stale: ${path.basename(wt.path)} → ${wt.branch}`);
  }

  // TODO
  console.log(`\n  📋 TODO (${plan.todo.length} items):`);
  if (plan.todo.length === 0) {
    console.log('     Nothing to do — all PRs are waiting for review/CI/merge.');
  }
  for (const t of plan.todo.slice(0, 5)) {
    const icon = { fix_review: '🔧', fix_ci: '❌', rebase: '⚔️', implement: '🆕' }[t.action] || '📝';
    const ref = t.pr ? `PR #${t.pr}` : `Issue #${t.issue}`;
    console.log(`     ${icon} [${t.priority}] ${t.action} ${ref}: ${t.reason}`);
  }
  if (plan.todo.length > 5) console.log(`     ... and ${plan.todo.length - 5} more`);

  // Ready to merge (for human awareness)
  if (plan.categories.readyToMerge.length > 0) {
    console.log(`\n  🎉 Ready to merge (need human/auto-merge):`);
    for (const pr of plan.categories.readyToMerge) {
      console.log(`     #${pr.number} ${pr.title}`);
    }
  }

  // New work available
  if (!plan.canTakeNewWork) {
    console.log(`\n  🛑 PR cap reached (${plan.openPRs.actionable}/${MAX_OPEN_PRS}) — focus on fixing/merging existing PRs`);
  } else if (plan.newIssuesAvailable > 0) {
    console.log(`\n  📬 ${plan.newIssuesAvailable} new issues available for implementation`);
  }

  console.log('\n═══════════════════════════════════════════════');
}

function printStatus(plan) {
  const budgetIcon = { OK: '🟢', SLOW_DOWN: '🟡', PAUSE: '🔴' }[plan.budgetStatus] || '⚪';
  const parts = [
    `${budgetIcon} PRs:${plan.openPRs.total}`,
    `merge:${plan.openPRs.readyToMerge}`,
    `fix:${plan.openPRs.needsCoderFix}`,
    `ci:${plan.openPRs.ciFailing}`,
    `conflict:${plan.openPRs.conflicting}`,
    `wt:${plan.worktrees.total}(${plan.worktrees.stale}stale)`,
    `todo:${plan.todo.length}`,
    `new:${plan.newIssuesAvailable}`,
  ];
  console.log(parts.join(' | '));
}

// ─── CLI ───────────────────────────────────────────────────────────

const args = process.argv.slice(2);

try {
  const plan = reconcile();

  if (args.includes('--json')) {
    console.log(JSON.stringify(plan, null, 2));
  } else if (args.includes('--status')) {
    printStatus(plan);
  } else if (args.includes('--apply')) {
    printPlan(plan);
    console.log('\n  Applying...');
    const result = applyPlan(plan);
    console.log(`  ✅ Cleaned ${plan.worktrees.stale} stale worktrees`);
    console.log(`  ✅ task-state.json updated (v3, ${plan.todo.length} queued items)`);

    // Auto-adjust heartbeat frequency based on workload
    try {
      const boostScript = path.join(__dirname, 'boost.js');
      if (fs.existsSync(boostScript)) {
        exec(`node ${boostScript}`, { allowFail: true, timeout: 10000 });
      }
    } catch { /* ignore boost errors */ }
  } else {
    printPlan(plan);
    console.log('  (Dry run — use --apply to clean up + write state)');
  }
} catch (err) {
  console.error(`❌ Reconcile failed: ${err.message}`);
  process.exit(1);
}
