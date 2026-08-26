#!/usr/bin/env node
/**
 * Coder Boost Mode — Adjusts heartbeat frequency based on workload
 *
 * When there's active work (todo > 0), decreases heartbeat interval
 * to process tasks faster. When idle, returns to normal.
 *
 * Usage:
 *   node boost.js              # Check current mode and adjust if needed
 *   node boost.js --on         # Force boost mode ON (10m heartbeat)
 *   node boost.js --off        # Force boost mode OFF (30m heartbeat)
 *   node boost.js --status     # Show current mode
 */

const fs = require('fs');
const path = require('path');

const JOBS_PATH = '/home/openclaw/.openclaw/cron/jobs.json';
const CODER_JOB_ID = 'c0d3r-hb-30m-a1b2c3d4e5f6';
const RECONCILE = path.join(__dirname, 'reconcile.js');

const NORMAL_INTERVAL_MS = 1800000;  // 30 minutes
const BOOST_INTERVAL_MS = 600000;    // 10 minutes

function readJobs() {
  return JSON.parse(fs.readFileSync(JOBS_PATH, 'utf-8'));
}

function writeJobs(data) {
  fs.writeFileSync(JOBS_PATH, JSON.stringify(data, null, 2) + '\n');
}

function getCoderJob(data) {
  return data.jobs.find(j => j.id === CODER_JOB_ID);
}

function getCurrentMode(job) {
  if (!job) return 'missing';
  const interval = job.schedule?.everyMs || NORMAL_INTERVAL_MS;
  return interval <= BOOST_INTERVAL_MS ? 'boost' : 'normal';
}

function setMode(mode) {
  const data = readJobs();
  const job = getCoderJob(data);
  if (!job) {
    console.error('❌ Coder heartbeat job not found in jobs.json');
    process.exit(1);
  }

  const interval = mode === 'boost' ? BOOST_INTERVAL_MS : NORMAL_INTERVAL_MS;
  const prev = job.schedule.everyMs;

  if (prev === interval) {
    console.log(`Already in ${mode} mode (${interval / 60000}m)`);
    return;
  }

  job.schedule.everyMs = interval;
  job.updatedAtMs = Date.now();

  // If switching to boost, set next run to ~1 minute from now
  if (mode === 'boost') {
    job.state.nextRunAtMs = Date.now() + 60000;
  }

  writeJobs(data);
  console.log(`${mode === 'boost' ? '🚀' : '🐢'} Switched to ${mode} mode: ${prev / 60000}m → ${interval / 60000}m`);
}

function autoAdjust() {
  // Run reconcile --status to check workload
  const { execSync } = require('child_process');
  let status;
  try {
    status = execSync(`node ${RECONCILE} --status`, { encoding: 'utf-8', timeout: 30000 }).trim();
  } catch {
    console.error('⚠️ Could not check reconcile status');
    return;
  }

  // Parse todo count from status line
  const todoMatch = status.match(/todo:(\d+)/);
  const todoCount = todoMatch ? parseInt(todoMatch[1]) : 0;

  const data = readJobs();
  const job = getCoderJob(data);
  const currentMode = getCurrentMode(job);

  console.log(`Status: ${status}`);
  console.log(`Current mode: ${currentMode} | TODO items: ${todoCount}`);

  if (todoCount > 0 && currentMode !== 'boost') {
    setMode('boost');
    console.log('⚡ Work detected — boosting heartbeat to 10m');
  } else if (todoCount === 0 && currentMode === 'boost') {
    setMode('normal');
    console.log('✅ All done — returning to normal 30m heartbeat');
  } else {
    console.log(`No change needed (${currentMode} mode, ${todoCount} items)`);
  }
}

// CLI
const args = process.argv.slice(2);

if (args.includes('--on')) {
  setMode('boost');
} else if (args.includes('--off')) {
  setMode('normal');
} else if (args.includes('--status')) {
  const data = readJobs();
  const job = getCoderJob(data);
  const mode = getCurrentMode(job);
  const interval = (job?.schedule?.everyMs || NORMAL_INTERVAL_MS) / 60000;
  console.log(`Mode: ${mode} (${interval}m) | ${mode === 'boost' ? '🚀' : '🐢'}`);
} else {
  autoAdjust();
}
