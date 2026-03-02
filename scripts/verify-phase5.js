#!/usr/bin/env node
/**
 * Phase 5 Verification Script
 * Validates that all maintenance components are working correctly
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const dbPath = path.join(__dirname, 'db', 'logs.db');
const backupDir = path.join(__dirname, 'db', 'backup');

console.log('🔍 Phase 5: Database Maintenance - Verification\n');
console.log('═'.repeat(60));

let allGood = true;

// 1. Check scripts exist
console.log('\n1️⃣  Checking scripts...');
const scripts = [
  'cleanup.js',
  'db-backup.js',
  'disk-usage.js',
  'daily-maintenance.js',
  'setup-cron.sh'
];

scripts.forEach(script => {
  const exists = fs.existsSync(path.join(__dirname, script));
  console.log(`   ${exists ? '✅' : '❌'} ${script}`);
  if (!exists) allGood = false;
});

// 2. Check documentation
console.log('\n2️⃣  Checking documentation...');
const docs = [
  'PHASE5_README.md',
  'CRON_SETUP.md'
];

docs.forEach(doc => {
  const exists = fs.existsSync(path.join(__dirname, doc));
  console.log(`   ${exists ? '✅' : '❌'} ${doc}`);
  if (!exists) allGood = false;
});

// 3. Check database tables
console.log('\n3️⃣  Checking database tables...');
try {
  const db = new Database(dbPath);
  
  // Check logs table
  const logsTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='logs'").get();
  console.log(`   ${logsTable ? '✅' : '❌'} logs table`);
  
  // Check alerts table
  const alertsTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='alerts'").get();
  console.log(`   ${alertsTable ? '✅' : '❌'} alerts table`);
  
  // Check daily_aggregates table
  const aggTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='daily_aggregates'").get();
  console.log(`   ${aggTable ? '✅' : '❌'} daily_aggregates table`);
  
  if (!logsTable || !alertsTable || !aggTable) allGood = false;
  
  db.close();
} catch (error) {
  console.log(`   ❌ Error checking database: ${error.message}`);
  allGood = false;
}

// 4. Check backup directory
console.log('\n4️⃣  Checking backup directory...');
const backupExists = fs.existsSync(backupDir);
console.log(`   ${backupExists ? '✅' : '❌'} db/backup/ directory`);

if (backupExists) {
  const backups = fs.readdirSync(backupDir).filter(f => f.endsWith('.db'));
  console.log(`   ℹ️  ${backups.length} backup(s) found`);
} else {
  allGood = false;
}

// 5. Check scripts are executable
console.log('\n5️⃣  Checking script permissions...');
const execScripts = ['cleanup.js', 'db-backup.js', 'disk-usage.js', 'daily-maintenance.js', 'setup-cron.sh'];

execScripts.forEach(script => {
  const scriptPath = path.join(__dirname, script);
  try {
    const stats = fs.statSync(scriptPath);
    const isExec = (stats.mode & 0o111) !== 0;
    console.log(`   ${isExec ? '✅' : '⚠️ '} ${script} ${isExec ? 'executable' : 'not executable (may still work with node)'}`);
  } catch (error) {
    console.log(`   ❌ ${script} - ${error.message}`);
  }
});

// 6. Test imports
console.log('\n6️⃣  Testing script imports...');
try {
  const { runBackup } = require('./db-backup');
  console.log('   ✅ db-backup.js imports correctly');
} catch (error) {
  console.log(`   ❌ db-backup.js import failed: ${error.message}`);
  allGood = false;
}

try {
  const { runCleanup } = require('./cleanup');
  console.log('   ✅ cleanup.js imports correctly');
} catch (error) {
  console.log(`   ❌ cleanup.js import failed: ${error.message}`);
  allGood = false;
}

try {
  const { checkDiskUsage } = require('./disk-usage');
  console.log('   ✅ disk-usage.js imports correctly');
} catch (error) {
  console.log(`   ❌ disk-usage.js import failed: ${error.message}`);
  allGood = false;
}

try {
  const { runMaintenance } = require('./daily-maintenance');
  console.log('   ✅ daily-maintenance.js imports correctly');
} catch (error) {
  console.log(`   ❌ daily-maintenance.js import failed: ${error.message}`);
  allGood = false;
}

// Final status
console.log('\n' + '═'.repeat(60));
if (allGood) {
  console.log('✅ All checks passed! Phase 5 is ready for production.\n');
  console.log('Next steps:');
  console.log('  1. Run: ./setup-cron.sh (or see CRON_SETUP.md)');
  console.log('  2. Test: node daily-maintenance.js');
  console.log('  3. Monitor: tail -f logs/maintenance.log\n');
} else {
  console.log('⚠️  Some checks failed. Please review errors above.\n');
}

process.exit(allGood ? 0 : 1);
