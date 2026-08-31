#!/usr/bin/env node
/**
 * Legacy Coder heartbeat audit.
 *
 * Automatic writer boosting is retired. This command is deliberately
 * read-only: it reports whether the known legacy Coder cron is absent or
 * explicitly disabled, and fails closed for enabled, malformed, or unreadable
 * state. It never enables, reschedules, or disables a cron.
 *
 * Usage:
 *   node boost.js --status
 */

'use strict';

const fs = require('fs');

const JOBS_PATH = '/home/openclaw/.openclaw/cron/jobs.json';
const CODER_JOB_ID = 'c0d3r-hb-30m-a1b2c3d4e5f6';

function auditLegacyCoderCron(data) {
  if (!data || !Array.isArray(data.jobs)) {
    return { safe: false, status: 'unknown', reason: 'cron inventory is malformed' };
  }

  const job = data.jobs.find(candidate => candidate && candidate.id === CODER_JOB_ID);
  if (!job) {
    return { safe: true, status: 'absent', reason: 'known legacy Coder cron is absent' };
  }
  if (job.enabled === false) {
    return { safe: true, status: 'disabled', reason: 'known legacy Coder cron is disabled' };
  }

  return {
    safe: false,
    status: 'enabled-or-unknown',
    reason: 'known legacy Coder cron is not explicitly disabled',
  };
}

function readLegacyCoderCronAudit(jobsPath = JOBS_PATH) {
  try {
    return auditLegacyCoderCron(JSON.parse(fs.readFileSync(jobsPath, 'utf8')));
  } catch (error) {
    return {
      safe: false,
      status: 'unknown',
      reason: `cron inventory unavailable: ${error.message}`,
    };
  }
}

function main(args = process.argv.slice(2)) {
  if (args.some(arg => arg !== '--status')) {
    console.error('Automatic Coder boost is retired; only the read-only --status audit is supported.');
    process.exitCode = 1;
    return;
  }

  const audit = readLegacyCoderCronAudit();
  const output = `Legacy Coder cron: ${audit.status} — ${audit.reason}`;
  if (audit.safe) {
    console.log(output);
    return;
  }

  console.error(output);
  process.exitCode = 1;
}

if (require.main === module) main();

module.exports = {
  CODER_JOB_ID,
  auditLegacyCoderCron,
  readLegacyCoderCronAudit,
};
