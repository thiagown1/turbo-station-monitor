#!/usr/bin/env node
/**
 * Disk Usage Monitor
 * - Checks database and backup directory sizes
 * - Alerts if disk usage exceeds thresholds
 * - Can be called standalone or imported
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const dbPath = path.join(__dirname, 'db', 'logs.db');
const backupDir = path.join(__dirname, 'db', 'backup');

// Thresholds (in MB)
const WARN_THRESHOLD_MB = 500;  // Warning at 500MB
const CRITICAL_THRESHOLD_MB = 1000;  // Critical at 1GB

function log(message) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`);
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

function getDirectorySize(dirPath) {
  let totalSize = 0;
  
  if (!fs.existsSync(dirPath)) {
    return 0;
  }
  
  const files = fs.readdirSync(dirPath);
  
  files.forEach(file => {
    const filePath = path.join(dirPath, file);
    const stats = fs.statSync(filePath);
    
    if (stats.isDirectory()) {
      totalSize += getDirectorySize(filePath);
    } else {
      totalSize += stats.size;
    }
  });
  
  return totalSize;
}

function getDiskUsage() {
  const usage = {
    database: {
      exists: fs.existsSync(dbPath),
      size: 0,
      sizeMB: 0
    },
    backups: {
      exists: fs.existsSync(backupDir),
      size: 0,
      sizeMB: 0,
      count: 0
    },
    total: {
      size: 0,
      sizeMB: 0
    }
  };
  
  // Check database
  if (usage.database.exists) {
    usage.database.size = fs.statSync(dbPath).size;
    usage.database.sizeMB = usage.database.size / (1024 * 1024);
  }
  
  // Check backups
  if (usage.backups.exists) {
    usage.backups.size = getDirectorySize(backupDir);
    usage.backups.sizeMB = usage.backups.size / (1024 * 1024);
    usage.backups.count = fs.readdirSync(backupDir)
      .filter(f => f.endsWith('.db')).length;
  }
  
  // Total
  usage.total.size = usage.database.size + usage.backups.size;
  usage.total.sizeMB = usage.total.size / (1024 * 1024);
  
  return usage;
}

function checkDiskUsage() {
  log('💾 Checking disk usage...');
  
  const usage = getDiskUsage();
  
  log(`📊 Database: ${formatBytes(usage.database.size)}`);
  log(`📁 Backups: ${formatBytes(usage.backups.size)} (${usage.backups.count} files)`);
  log(`📦 Total: ${formatBytes(usage.total.size)}`);
  
  // Check thresholds
  const totalMB = usage.total.sizeMB;
  
  if (totalMB >= CRITICAL_THRESHOLD_MB) {
    log(`🔴 CRITICAL: Disk usage (${totalMB.toFixed(2)} MB) exceeds ${CRITICAL_THRESHOLD_MB} MB!`);
    return { status: 'critical', usage };
  } else if (totalMB >= WARN_THRESHOLD_MB) {
    log(`🟠 WARNING: Disk usage (${totalMB.toFixed(2)} MB) exceeds ${WARN_THRESHOLD_MB} MB`);
    return { status: 'warning', usage };
  } else {
    log(`✅ Disk usage OK (${totalMB.toFixed(2)} MB)`);
    return { status: 'ok', usage };
  }
}

// Run if executed directly
if (require.main === module) {
  const result = checkDiskUsage();
  
  // Exit with error code if critical
  if (result.status === 'critical') {
    process.exit(2);
  } else if (result.status === 'warning') {
    process.exit(1);
  }
  
  process.exit(0);
}

module.exports = { getDiskUsage, checkDiskUsage };
