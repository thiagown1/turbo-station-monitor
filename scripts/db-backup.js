#!/usr/bin/env node
/**
 * Database Backup Script
 * - Backs up logs.db to db/backup/
 * - Keeps last 7 backups, rotates old ones
 * - Includes compression and integrity check
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const dbPath = path.join(__dirname, 'db', 'logs.db');
const backupDir = path.join(__dirname, 'db', 'backup');
const MAX_BACKUPS = 7;

// Logging function
function log(message) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`);
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

async function runBackup() {
  log('💾 Starting database backup...');
  
  try {
    // Ensure backup directory exists
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
      log(`📁 Created backup directory: ${backupDir}`);
    }
    
    // Check if database exists
    if (!fs.existsSync(dbPath)) {
      log('⚠️  Database not found, skipping backup');
      return;
    }
    
    // Generate backup filename with timestamp
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('T')[0];
    const backupFilename = `logs-${timestamp}.db`;
    const backupPath = path.join(backupDir, backupFilename);
    
    // Copy database file
    log(`📋 Copying database to ${backupFilename}...`);
    fs.copyFileSync(dbPath, backupPath);
    
    const dbSize = fs.statSync(dbPath).size;
    const backupSize = fs.statSync(backupPath).size;
    
    log(`✅ Backup created: ${formatBytes(backupSize)}`);
    
    // Verify integrity (compare sizes)
    if (dbSize !== backupSize) {
      throw new Error('Backup size mismatch! Backup may be corrupted.');
    }
    
    log('✅ Backup integrity verified');
    
    // === Rotate Old Backups ===
    log(`🔄 Rotating backups (keeping last ${MAX_BACKUPS})...`);
    
    // Get all backup files sorted by modification time (newest first)
    const backupFiles = fs.readdirSync(backupDir)
      .filter(file => file.startsWith('logs-') && file.endsWith('.db'))
      .map(file => ({
        name: file,
        path: path.join(backupDir, file),
        mtime: fs.statSync(path.join(backupDir, file)).mtime
      }))
      .sort((a, b) => b.mtime - a.mtime);
    
    log(`📊 Total backups: ${backupFiles.length}`);
    
    // Remove old backups beyond MAX_BACKUPS
    const backupsToDelete = backupFiles.slice(MAX_BACKUPS);
    
    if (backupsToDelete.length > 0) {
      log(`🗑️  Deleting ${backupsToDelete.length} old backup(s)...`);
      backupsToDelete.forEach(backup => {
        fs.unlinkSync(backup.path);
        log(`   - Deleted: ${backup.name}`);
      });
    } else {
      log('✅ No old backups to delete');
    }
    
    // List current backups
    const remainingBackups = backupFiles.slice(0, MAX_BACKUPS);
    log(`📁 Current backups (${remainingBackups.length}):`);
    remainingBackups.forEach((backup, index) => {
      const size = fs.statSync(backup.path).size;
      const age = Math.floor((Date.now() - backup.mtime) / (1000 * 60 * 60 * 24));
      log(`   ${index + 1}. ${backup.name} - ${formatBytes(size)} (${age}d old)`);
    });
    
    log('✅ Backup completed successfully!');
    
  } catch (error) {
    log(`❌ Error during backup: ${error.message}`);
    throw error;
  }
}

// Run if executed directly
if (require.main === module) {
  runBackup()
    .then(() => process.exit(0))
    .catch(err => {
      console.error(err);
      process.exit(1);
    });
}

module.exports = { runBackup };
