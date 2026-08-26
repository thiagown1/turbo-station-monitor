#!/usr/bin/env node
/**
 * Usage Tracker — Codex OAuth Real-Time Quota Monitor
 *
 * Queries the Codex backend API (chatgpt.com/backend-api/wham/usage)
 * with the OAuth token to get live percentage-based quota data.
 *
 * Usage:
 *   node usage-tracker.js              # Full dashboard report
 *   node usage-tracker.js --summary    # One-line for Coder heartbeat
 *   node usage-tracker.js --json       # Raw JSON for automation
 *   node usage-tracker.js --check      # Budget health check (exit 0=ok, 1=warn, 2=pause)
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const AUTH_PROFILES_PATH = '/home/openclaw/.openclaw/agents/main/agent/auth-profiles.json';
const BUDGET_STATE_PATH = '/home/openclaw/.openclaw/workspace/skills/turbo-station-monitor/data/budget-state.json';

// Budget thresholds (percentage used)
const THRESHOLDS = {
  '5h': { warn: 70, pause: 90 },      // 5-hour rolling window
  weekly: { warn: 80, pause: 95 },     // Weekly window
  codeReview: { warn: 85, pause: 95 }, // Code review budget
};

// Daily target: spread weekly evenly, never exceed 15%/day of weekly quota
const DAILY_MAX_WEEKLY_PCT = 15;

/**
 * Read the fresh OAuth token from auth-profiles.json
 */
function getCodexToken() {
  try {
    const d = JSON.parse(fs.readFileSync(AUTH_PROFILES_PATH, 'utf-8'));
    const profiles = d.profiles || d;
    const codex = profiles['openai-codex:default'] || {};
    return codex.access || '';
  } catch (err) {
    console.error(`[usage-tracker] Failed to read auth: ${err.message}`);
    return '';
  }
}

/**
 * Fetch usage from Codex backend API
 */
function fetchCodexUsage(token) {
  return new Promise((resolve, reject) => {
    const url = new URL('https://chatgpt.com/backend-api/wham/usage');
    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'GET',
      timeout: 15000,
      headers: {
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'CodexBar',
        'Accept': 'application/json',
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}: ${parsed.error?.message || 'Unknown error'}`));
            return;
          }
          resolve(parsed);
        } catch (err) {
          reject(new Error(`Failed to parse response: ${err.message}`));
        }
      });
    });

    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    req.on('error', reject);
    req.end();
  });
}

/**
 * Parse usage data into a structured report
 */
function parseUsage(data) {
  const report = {
    timestamp: new Date().toISOString(),
    plan: data.plan_type,
    windows: {},
    codeReview: null,
    spark: null,
    credits: data.credits,
    budget: { status: 'OK', reasons: [] },
  };

  // Primary window (5h)
  if (data.rate_limit?.primary_window) {
    const pw = data.rate_limit.primary_window;
    const windowHours = Math.round((pw.limit_window_seconds || 18000) / 3600);
    report.windows['5h'] = {
      label: `${windowHours}h`,
      usedPct: pw.used_percent || 0,
      remainingPct: 100 - (pw.used_percent || 0),
      resetAt: pw.reset_at ? new Date(pw.reset_at * 1000).toISOString() : null,
      resetInMinutes: pw.reset_after_seconds ? Math.round(pw.reset_after_seconds / 60) : null,
    };
  }

  // Secondary window (weekly)
  if (data.rate_limit?.secondary_window) {
    const sw = data.rate_limit.secondary_window;
    report.windows.weekly = {
      label: 'Weekly',
      usedPct: sw.used_percent || 0,
      remainingPct: 100 - (sw.used_percent || 0),
      resetAt: sw.reset_at ? new Date(sw.reset_at * 1000).toISOString() : null,
      resetInDays: sw.reset_after_seconds ? (sw.reset_after_seconds / 86400).toFixed(1) : null,
    };
  }

  // Code review
  if (data.code_review_rate_limit?.primary_window) {
    const cr = data.code_review_rate_limit.primary_window;
    report.codeReview = {
      usedPct: cr.used_percent || 0,
      remainingPct: 100 - (cr.used_percent || 0),
      resetAt: cr.reset_at ? new Date(cr.reset_at * 1000).toISOString() : null,
      resetInDays: cr.reset_after_seconds ? (cr.reset_after_seconds / 86400).toFixed(1) : null,
    };
  }

  // Additional limits (Spark etc)
  if (data.additional_rate_limits) {
    for (const al of data.additional_rate_limits) {
      if (al.limit_name?.includes('Spark')) {
        const rl = al.rate_limit || {};
        report.spark = {
          name: al.limit_name,
          primary: rl.primary_window ? {
            usedPct: rl.primary_window.used_percent || 0,
            remainingPct: 100 - (rl.primary_window.used_percent || 0),
          } : null,
          secondary: rl.secondary_window ? {
            usedPct: rl.secondary_window.used_percent || 0,
            remainingPct: 100 - (rl.secondary_window.used_percent || 0),
          } : null,
        };
      }
    }
  }

  // Budget analysis
  const h5 = report.windows['5h'];
  const weekly = report.windows.weekly;
  const cr = report.codeReview;

  if (h5 && h5.usedPct >= THRESHOLDS['5h'].pause) {
    report.budget.status = 'PAUSE';
    report.budget.reasons.push(`5h window at ${h5.usedPct}% (pause threshold: ${THRESHOLDS['5h'].pause}%)`);
  } else if (h5 && h5.usedPct >= THRESHOLDS['5h'].warn) {
    report.budget.status = 'SLOW_DOWN';
    report.budget.reasons.push(`5h window at ${h5.usedPct}% (warn threshold: ${THRESHOLDS['5h'].warn}%)`);
  }

  if (weekly && weekly.usedPct >= THRESHOLDS.weekly.pause) {
    report.budget.status = 'PAUSE';
    report.budget.reasons.push(`Weekly at ${weekly.usedPct}% (pause threshold: ${THRESHOLDS.weekly.pause}%)`);
  } else if (weekly && weekly.usedPct >= THRESHOLDS.weekly.warn) {
    if (report.budget.status !== 'PAUSE') report.budget.status = 'SLOW_DOWN';
    report.budget.reasons.push(`Weekly at ${weekly.usedPct}% (warn threshold: ${THRESHOLDS.weekly.warn}%)`);
  }

  // Daily pacing check: calculate daily budget based on days remaining
  if (weekly) {
    const daysRemaining = parseFloat(weekly.resetInDays) || 7;
    const weeklyRemaining = weekly.remainingPct;
    const dailyBudget = Math.min(DAILY_MAX_WEEKLY_PCT, weeklyRemaining / daysRemaining);
    report.budget.dailyBudget = Math.round(dailyBudget * 10) / 10;
    report.budget.daysRemaining = daysRemaining;
  }

  return report;
}

function printReport(report) {
  const statusIcon = { OK: '🟢', SLOW_DOWN: '🟡', PAUSE: '🔴', CAUTION: '🟠' }[report.budget.status] || '⚪';

  console.log('═══════════════════════════════════════════════');
  console.log(`  📊 CODEX USAGE — Plan: ${report.plan?.toUpperCase() || '?'}`);
  console.log(`  ${report.timestamp}`);
  console.log(`  Budget: ${statusIcon} ${report.budget.status}`);
  console.log('═══════════════════════════════════════════════\n');

  const h5 = report.windows['5h'];
  const weekly = report.windows.weekly;
  const cr = report.codeReview;
  const spark = report.spark;

  if (h5) {
    const bar = makeBar(h5.usedPct);
    console.log(`  5h rolling:    ${bar} ${h5.usedPct}% used (${h5.remainingPct}% left)  resets in ${h5.resetInMinutes}min`);
  }
  if (weekly) {
    const bar = makeBar(weekly.usedPct);
    console.log(`  Weekly:        ${bar} ${weekly.usedPct}% used (${weekly.remainingPct}% left)  resets in ${weekly.resetInDays}d`);
  }
  if (cr) {
    const bar = makeBar(cr.usedPct);
    console.log(`  Code Review:   ${bar} ${cr.usedPct}% used (${cr.remainingPct}% left)  resets in ${cr.resetInDays}d`);
  }
  if (spark) {
    console.log(`  Spark 5h:      ${makeBar(spark.primary?.usedPct || 0)} ${spark.primary?.usedPct || 0}% used`);
    console.log(`  Spark Weekly:  ${makeBar(spark.secondary?.usedPct || 0)} ${spark.secondary?.usedPct || 0}% used`);
  }

  console.log('');
  if (report.budget.dailyBudget) {
    console.log(`  📐 Daily budget: ~${report.budget.dailyBudget}% of weekly per day (${report.budget.daysRemaining}d left)`);
  }
  if (report.budget.reasons.length > 0) {
    console.log('  ⚠️  Warnings:');
    for (const r of report.budget.reasons) console.log(`    - ${r}`);
  }
  console.log('\n═══════════════════════════════════════════════');
}

function makeBar(usedPct) {
  const width = 20;
  const filled = Math.round(usedPct / 100 * width);
  const empty = width - filled;
  const color = usedPct >= 90 ? '🔴' : usedPct >= 70 ? '🟡' : '🟢';
  return `${color} ${'█'.repeat(filled)}${'░'.repeat(empty)}`;
}

function saveBudgetState(report) {
  const dir = path.dirname(BUDGET_STATE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(BUDGET_STATE_PATH, JSON.stringify(report, null, 2));
}

// Main
(async () => {
  const args = process.argv.slice(2);

  const token = getCodexToken();
  if (!token) {
    console.error('No Codex OAuth token found');
    process.exit(1);
  }

  try {
    const data = await fetchCodexUsage(token);
    const report = parseUsage(data);
    saveBudgetState(report);

    if (args.includes('--json')) {
      console.log(JSON.stringify(report, null, 2));
    } else if (args.includes('--summary')) {
      const h5 = report.windows['5h'];
      const weekly = report.windows.weekly;
      const cr = report.codeReview;
      const statusIcon = { OK: '🟢', SLOW_DOWN: '🟡', PAUSE: '🔴' }[report.budget.status] || '⚪';
      console.log(`${statusIcon} 5h:${h5?.remainingPct ?? '?'}% weekly:${weekly?.remainingPct ?? '?'}% review:${cr?.remainingPct ?? '?'}% | status:${report.budget.status} | daily_budget:${report.budget.dailyBudget ?? '?'}%`);
    } else if (args.includes('--check')) {
      const exitCode = report.budget.status === 'PAUSE' ? 2 : report.budget.status === 'SLOW_DOWN' ? 1 : 0;
      console.log(JSON.stringify({ status: report.budget.status, ...report.budget }));
      process.exit(exitCode);
    } else {
      printReport(report);
    }
  } catch (err) {
    console.error(`[usage-tracker] API error: ${err.message}`);
    // Fallback: output a safe default
    if (args.includes('--summary')) {
      console.log('⚪ API unavailable — status:UNKNOWN');
    }
    process.exit(1);
  }
})();
