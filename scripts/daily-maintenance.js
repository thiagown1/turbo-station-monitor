#!/usr/bin/env node
/**
 * Daily Maintenance Runner
 * Runs in sequence:
 * 1. Backup database
 * 2. Cleanup old logs
 * 3. Check disk usage
 * 
 * To be executed daily at 03:00 BRT via cron
 */

const { runBackup } = require('./db-backup');
const { runCleanup } = require('./cleanup');
const { checkDiskUsage } = require('./disk-usage');

function log(message) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`);
}

async function runMaintenance() {
  log('🔧 Starting daily maintenance...');
  log('━'.repeat(60));
  
  try {
    // Step 1: Backup
    log('');
    log('STEP 1/3: Database Backup');
    log('─'.repeat(60));
    await runBackup();
    
    // Step 2: Cleanup
    log('');
    log('STEP 2/3: Database Cleanup');
    log('─'.repeat(60));
    await runCleanup();
    
    // Step 3: Disk Usage Check
    log('');
    log('STEP 3/3: Disk Usage Check');
    log('─'.repeat(60));
    const diskResult = checkDiskUsage();
    
    log('');
    log('━'.repeat(60));
    log('✅ Daily maintenance completed successfully!');
    log('━'.repeat(60));
    
    // Return disk status for potential alerting
    return diskResult;
    
  } catch (error) {
    log('');
    log('━'.repeat(60));
    log(`❌ Maintenance failed: ${error.message}`);
    log('━'.repeat(60));
    throw error;
  }
}

// Run if executed directly
if (require.main === module) {
  runMaintenance()
    .then(() => process.exit(0))
    .catch(err => {
      console.error(err);
      process.exit(1);
    });
}

module.exports = { runMaintenance };
