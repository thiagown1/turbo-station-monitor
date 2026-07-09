#!/usr/bin/env node
/**
 * Budget Guardian Service — PM2-friendly interval runner
 *
 * Runs budget-guardian.js every 15 minutes as a long-lived process.
 * Designed to be managed by PM2 alongside the other services.
 */

const { execSync } = require('child_process');
const path = require('path');

const GUARDIAN_SCRIPT = path.join(__dirname, 'budget-guardian.js');
const INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

function runGuardian() {
  const ts = new Date().toISOString();
  try {
    const output = execSync(`node ${GUARDIAN_SCRIPT}`, {
      encoding: 'utf-8',
      timeout: 30000,
      cwd: '/home/openclaw/.openclaw',
    });
    console.log(output.trim());
  } catch (err) {
    console.error(`[${ts}] Guardian error: ${err.message}`);
  }
}

// Run immediately on start
console.log(`[${new Date().toISOString()}] Budget Guardian Service started (interval: ${INTERVAL_MS / 60000}min)`);
runGuardian();

// Then every 15 minutes
setInterval(runGuardian, INTERVAL_MS);

// Keep alive
process.on('SIGINT', () => {
  console.log('Budget Guardian shutting down');
  process.exit(0);
});
