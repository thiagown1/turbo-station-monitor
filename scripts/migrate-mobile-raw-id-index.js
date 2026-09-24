#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const {
  RAW_ID_INDEX,
  hasRawIdIndex,
} = require('../services/mobile-telemetry/lib/retention-index');

function inspectPlan(database) {
  return database.prepare(`
    EXPLAIN QUERY PLAN
    DELETE FROM mobile_raw
    WHERE rowid IN (
      SELECT rowid FROM mobile_raw
      WHERE received_at < ?
      LIMIT 5000
    )
  `).all(0).map((row) => row.detail);
}

function migrateRawIdIndex({ dbPath, apply = false, log = console.log } = {}) {
  if (!dbPath) throw new Error('dbPath is required');
  const resolvedPath = path.resolve(dbPath);
  const lockPath = `${resolvedPath}.raw-id-index.lock`;
  let lockFd;
  let database;
  try {
    if (apply) {
      lockFd = fs.openSync(lockPath, 'wx');
      fs.writeFileSync(lockFd, `${process.pid}\n${new Date().toISOString()}\n`);
    }
    database = new Database(resolvedPath, { readonly: !apply, fileMustExist: true });
    database.pragma('busy_timeout = 5000');
    database.pragma('foreign_keys = ON');

    const existed = hasRawIdIndex(database);
    if (apply && !existed) {
      log(`[mobile-telemetry] creating ${RAW_ID_INDEX}; this can take time on a large database`);
      database.exec(`CREATE INDEX ${RAW_ID_INDEX} ON mobile_events(raw_id)`);
    }
    const ready = hasRawIdIndex(database);
    const plan = ready ? inspectPlan(database) : [];
    if (ready && plan.some((detail) => detail.includes('SCAN mobile_events'))) {
      throw new Error(`migration verification failed: ${plan.join(' | ')}`);
    }
    return { dbPath: resolvedPath, apply, existed, ready, plan };
  } finally {
    try { database?.close(); } catch {}
    if (lockFd !== undefined) {
      try { fs.closeSync(lockFd); } catch {}
      try { fs.unlinkSync(lockPath); } catch {}
    }
  }
}

function parseArgs(argv) {
  let dbPath = process.env.MOBILE_DB_PATH || path.join(__dirname, '..', 'db', 'mobile.db');
  let apply = false;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--apply') apply = true;
    else if (argv[index] === '--db' && argv[index + 1]) dbPath = argv[++index];
    else throw new Error(`unknown or incomplete argument: ${argv[index]}`);
  }
  return { dbPath, apply };
}

if (require.main === module) {
  try {
    const result = migrateRawIdIndex(parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify(result, null, 2));
    if (!result.ready) {
      console.log(`[mobile-telemetry] dry-run: ${RAW_ID_INDEX} is missing; use --apply only in an authorized maintenance window`);
    }
  } catch (error) {
    console.error(`[mobile-telemetry] raw_id index migration failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { inspectPlan, migrateRawIdIndex, parseArgs };
