#!/usr/bin/env node
/**
 * Task Planner v2 — Budget-Aware Evidence Planner
 *
 * Integrates real Codex quota (from usage-tracker.js) with GitHub issue
 * backlog to record an optimally-sized, prioritized blocked-work plan.
 *
 * The key formula:
 *   budget_remaining → max_tasks_to_run → pick top-N by priority score
 *
 * Usage:
 *   node task-planner.js              # Show plan (dry run)
 *   node task-planner.js --apply      # Sanitize executable state + record evidence
 *   node task-planner.js --status     # Quick status of current plan vs budget
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const {
  OPENCLAW_WRITER_ATTESTATION_VARIABLE,
  canonicalizePrNumber,
} = require('./lib/openclaw-writer-guard');
const {
  blockedTaskIdentity,
  sanitizeCoderTaskState,
  writeJsonAtomic,
  writeWriterEvidence,
} = require('./lib/writer-evidence-store');

const TASK_STATE_PATH = '/home/openclaw/.openclaw/workspace-coder/task-state.json';
const WRITER_EVIDENCE_PATH = path.join(__dirname, '..', 'state', 'writer-repair-evidence-planner.json');
const BUDGET_STATE_PATH = '/home/openclaw/.openclaw/workspace/skills/turbo-station-monitor/data/budget-state.json';
const USAGE_TRACKER = path.join(__dirname, 'usage-tracker.js');
const REPO = 'thiagown1/turbo_station';

// How many "task slots" is each quota-% worth?
// A typical guard test issue uses ~2-3% of 5h window.
// A typical feature issue uses ~4-6%.
// We estimate conservatively: 1 task ≈ 3% of 5h window.
const PCT_PER_TASK = 3;

// Priority scoring weights
const PRIORITY_SCORES = {
  'Priority: P0-critical': 100,
  'Priority: P1-important': 75,
  'Priority: P2-improvement': 50,
  'Priority: P3-nice-to-have': 25,
};

const TYPE_BOOSTS = {
  'type:bug': 20,
  'type:security': 30,
  'type:regression': 25,
  'type:test': 10,
  'type:feature': 5,
  'type:refactor': 0,
  'type:chore': -5,
};

function fetchWriterAttestationValue() {
  try {
    const payload = JSON.parse(execSync(
      `gh api "repos/${REPO}/actions/variables/${OPENCLAW_WRITER_ATTESTATION_VARIABLE}"`,
      { encoding: 'utf-8', timeout: 15000 }
    ));
    return typeof payload.value === 'string' ? payload.value : null;
  } catch {
    return null;
  }
}

// Category labels for estimating cost
const COST_ESTIMATES = {
  'scope:small': 1,   // ~1-2% quota (simple test, config change)
  'scope:medium': 3,  // ~3-4% quota (typical feature/test)
  'scope:large': 6,   // ~5-8% quota (complex multi-file feature)
  'default': 3,       // assume medium if no scope label
};

/**
 * Get fresh budget data from usage-tracker
 */
function getBudget() {
  try {
    // Run usage tracker and read its output file
    execSync(`node ${USAGE_TRACKER} --json`, { encoding: 'utf-8', timeout: 20000 });
    return JSON.parse(fs.readFileSync(BUDGET_STATE_PATH, 'utf-8'));
  } catch (err) {
    console.error(`  ⚠️  Budget fetch failed: ${err.message}`);
    return null;
  }
}

/**
 * Calculate how many task slots are available based on budget
 */
function calculateSlots(budget) {
  if (!budget) return { total: 5, reason: 'Budget unavailable, using default 5 slots' };

  const h5 = budget.windows?.['5h'];
  const weekly = budget.windows?.weekly;

  if (!h5 || !weekly) return { total: 5, reason: 'Incomplete budget data' };

  // How much of the 5h window can we use? Leave 15% buffer.
  const h5Available = Math.max(0, h5.remainingPct - 15);
  const h5Slots = Math.floor(h5Available / PCT_PER_TASK);

  // How much daily budget do we have? (weekly remaining / days left)
  const daysLeft = parseFloat(weekly.resetInDays) || 7;
  const dailyBudget = Math.min(15, weekly.remainingPct / daysLeft);
  const weeklySlots = Math.floor(dailyBudget / PCT_PER_TASK);

  // Use the minimum of both constraints
  const total = Math.max(1, Math.min(h5Slots, weeklySlots, 10));

  const reason = `5h: ${h5.remainingPct}% left (${h5Slots} slots) | daily budget: ${dailyBudget.toFixed(1)}% (${weeklySlots} slots) → ${total} task slots`;

  return { total, h5Slots, weeklySlots, dailyBudget, reason };
}

/**
 * Fetch and score GitHub issues
 */
function fetchAndScoreIssues() {
  let issues = [];
  try {
    const output = execSync(
      `gh issue list --repo ${REPO} --label "agent:coder" --label "auto:implement" --state open --json number,title,labels,createdAt --limit 30`,
      { encoding: 'utf-8', timeout: 15000 }
    );
    issues = JSON.parse(output);
  } catch (err) {
    console.error(`  ⚠️  GitHub fetch failed: ${err.message}`);
    return [];
  }

  // Find issues that already have PRs (skip them)
  let prIssues = new Set();
  try {
    const prs = JSON.parse(execSync(
      `gh pr list --repo ${REPO} --author TurboStation-ai --state open --json headRefName --limit 30`,
      { encoding: 'utf-8', timeout: 15000 }
    ));
    for (const pr of prs) {
      const match = pr.headRefName?.match(/issue-(\d+)/i);
      if (match) prIssues.add(parseInt(match[1]));
    }
  } catch { /* ignore */ }

  return issues
    .filter(i => {
      const labels = i.labels.map(l => l.name);
      return !labels.includes('status:done') &&
             !labels.includes('status:blocked') &&
             !prIssues.has(i.number);
    })
    .map(i => {
      const labels = i.labels.map(l => l.name);
      let score = 0;

      // Priority score
      for (const [label, points] of Object.entries(PRIORITY_SCORES)) {
        if (labels.includes(label)) score += points;
      }

      // Type boost
      for (const [label, boost] of Object.entries(TYPE_BOOSTS)) {
        if (labels.includes(label)) score += boost;
      }

      // Age bonus (max 10 pts for 7+ days old)
      const ageDays = (Date.now() - new Date(i.createdAt).getTime()) / 86400000;
      score += Math.min(10, Math.floor(ageDays));

      // Cost estimate
      let cost = COST_ESTIMATES.default;
      for (const [label, c] of Object.entries(COST_ESTIMATES)) {
        if (label !== 'default' && labels.includes(label)) cost = c;
      }

      // Priority tier
      const pLabel = labels.find(l => l.startsWith('Priority:'));
      const priority = pLabel?.includes('P0') ? 'P0' : pLabel?.includes('P1') ? 'P1' :
                       pLabel?.includes('P2') ? 'P2' : pLabel?.includes('P3') ? 'P3' : 'P2';

      return {
        number: i.number,
        title: i.title,
        labels,
        priority,
        score,
        cost,
        createdAt: i.createdAt,
      };
    })
    .sort((a, b) => b.score - a.score);
}

/**
 * Read current task-state
 */
function readTaskState() {
  try {
    return JSON.parse(fs.readFileSync(TASK_STATE_PATH, 'utf-8'));
  } catch {
    return { schema: 'v2', lastUpdated: new Date().toISOString(), activeTasks: [], queue: [] };
  }
}

/**
 * Build the optimal queue given budget slots and scored issues
 */
function buildPlan() {
  const budget = getBudget();
  const slots = calculateSlots(budget);
  const issues = fetchAndScoreIssues();
  const taskState = readTaskState();

  // Issues already being worked on
  const activeNumbers = new Set(
    (taskState.activeTasks || []).map(t => t.issueNumber).filter(Boolean)
  );
  const activeCount = activeNumbers.size;

  // Filter to new issues only (not already active)
  const available = issues.filter(i => !activeNumbers.has(i.number));

  // How many new tasks can we take on?
  const slotsForNew = Math.max(0, slots.total - activeCount);

  // Fill slots greedily by score, respecting cost budget
  let quotaUsed = 0;
  const dailyBudget = slots.dailyBudget || 15;
  const selected = [];

  for (const issue of available) {
    if (selected.length >= slotsForNew) break;
    if (quotaUsed + issue.cost > dailyBudget) continue; // Skip if too expensive for remaining budget
    selected.push(issue);
    quotaUsed += issue.cost;
  }

  return {
    budget: budget ? {
      h5Remaining: budget.windows?.['5h']?.remainingPct,
      weeklyRemaining: budget.windows?.weekly?.remainingPct,
      codeReviewRemaining: budget.codeReview?.remainingPct,
      sparkAvailable: budget.spark?.primary?.remainingPct,
      status: budget.budget?.status,
    } : null,
    slots,
    activeCount,
    totalBacklog: issues.length,
    selected,
    skipped: available.slice(selected.length),
    all: issues,
  };
}

function sanitizeLegacyTaskState(currentState, plan, attested, now = new Date().toISOString()) {
  const selected = (Array.isArray(plan.selected) ? plan.selected : []).map(issue => ({
    repo: REPO,
    issueNumber: issue.number,
    issueTitle: issue.title,
    concurrencyKey: `openclaw-writer-v1:${REPO}:issue:${canonicalizePrNumber(issue.number)}`,
    blockedReason: attested
      ? 'manual writer dispatch required; legacy task-state queue is evidence-only'
      : `${OPENCLAW_WRITER_ATTESTATION_VARIABLE} is not exactly true`,
  }));
  return sanitizeCoderTaskState({
    currentState,
    currentTasks: selected,
    generatedAt: now,
  });
}

/**
 * Apply an evidence-only plan and quarantine every legacy executable task.
 */
function applyPlan(plan) {
  const sanitized = sanitizeLegacyTaskState(
    readTaskState(),
    plan,
    fetchWriterAttestationValue() === 'true'
  );

  writeJsonAtomic(TASK_STATE_PATH, sanitized.taskState);
  const evidence = writeWriterEvidence({
    filePath: WRITER_EVIDENCE_PATH,
    source: 'legacy-planner',
    tasks: sanitized.evidenceTasks,
    generatedAt: sanitized.taskState.lastHeartbeat,
  });

  return { taskState: sanitized.taskState, evidence };
}

function printPlan(plan) {
  console.log('═══════════════════════════════════════════════');
  console.log('  📋 TASK PLANNER — Budget-Aware Evidence Planner');
  console.log(`  ${new Date().toISOString()}`);
  console.log('═══════════════════════════════════════════════\n');

  // Budget section
  if (plan.budget) {
    const b = plan.budget;
    console.log(`  💰 Budget:  5h: ${b.h5Remaining}%  weekly: ${b.weeklyRemaining}%  review: ${b.codeReviewRemaining}%  spark: ${b.sparkAvailable}%`);
    console.log(`  📐 Slots:   ${plan.slots.reason}`);
  }

  console.log(`  📊 Backlog: ${plan.totalBacklog} issues | ${plan.activeCount} legacy active | ${plan.selected.length} to record\n`);

  // Selected tasks
  if (plan.selected.length > 0) {
    console.log('  🔒 Selected as blocked evidence (by priority score):');
    for (const i of plan.selected) {
      console.log(`     #${i.number} [${i.priority}|${i.score}pts|~${i.cost}%] ${i.title.substring(0, 55)}`);
    }
  } else {
    console.log('  📭 No new tasks to record (all known or budget depleted)');
  }

  // Skipped
  if (plan.skipped.length > 0) {
    console.log(`\n  ⏳ Waiting (${plan.skipped.length} issues, will be picked next cycle):`);
    for (const i of plan.skipped.slice(0, 5)) {
      console.log(`     #${i.number} [${i.priority}|${i.score}pts] ${i.title.substring(0, 55)}`);
    }
    if (plan.skipped.length > 5) console.log(`     ... and ${plan.skipped.length - 5} more`);
  }

  console.log('\n═══════════════════════════════════════════════');
}

function main(args = process.argv.slice(2)) {
  const plan = buildPlan();

  if (args.includes('--status')) {
    const b = plan.budget;
    const statusIcon = { OK: '🟢', SLOW_DOWN: '🟡', PAUSE: '🔴' }[b?.status] || '⚪';
    console.log(`${statusIcon} slots:${plan.slots.total} active:${plan.activeCount} queued:${plan.selected.length} backlog:${plan.totalBacklog} | 5h:${b?.h5Remaining ?? '?'}% weekly:${b?.weeklyRemaining ?? '?'}%`);
  } else if (args.includes('--apply')) {
    printPlan(plan);
    console.log('\n  Applying...');
    const result = applyPlan(plan);
    console.log(`  ✅ Executable queue: ${result.taskState.queue.length} | Active: ${result.taskState.activeTasks.length} | Monitor evidence: ${result.evidence.tasks.length}`);
  } else {
    printPlan(plan);
    console.log('  (Dry run — use --apply to sanitize executable state and record blocked evidence)');
  }
}

if (require.main === module) main();

module.exports = {
  applyPlan,
  blockedTaskIdentity,
  sanitizeLegacyTaskState,
};
