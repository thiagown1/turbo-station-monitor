# Quick Reference - Phase 5 Database Maintenance

## 🚀 Quick Start

```bash
# Test all maintenance scripts
cd /home/openclaw/.openclaw/workspace/skills/turbo-station-monitor
node verify-phase5.js

# Run manual maintenance
node daily-maintenance.js

# Set up automated daily runs (03:00 BRT)
./setup-cron.sh
```

## 📋 Common Commands

### Manual Operations
```bash
# Backup database
node db-backup.js

# Clean old logs (>30 days)
node cleanup.js

# Check disk usage
node disk-usage.js

# Full maintenance cycle
node daily-maintenance.js
```

### Monitoring
```bash
# View maintenance logs
tail -f logs/maintenance.log

# Check last maintenance run
tail -20 logs/maintenance.log

# List backups
ls -lh db/backup/

# Database size
du -h db/logs.db
```

### Database Queries
```bash
# Note: sqlite3 CLI not available, use Node.js scripts instead

# View aggregate stats (create a script)
node -e "
const Database = require('better-sqlite3');
const db = new Database('db/logs.db');
console.log('Total aggregates:', db.prepare('SELECT COUNT(*) as c FROM daily_aggregates').get());
console.log('Recent aggregates:');
db.prepare('SELECT date, source, COUNT(*) as c FROM daily_aggregates GROUP BY date, source ORDER BY date DESC LIMIT 10').all().forEach(r => console.log(r));
db.close();
"
```

## 📊 Key Files

| File | Purpose |
|------|---------|
| `daily-maintenance.js` | Main runner (use this for automation) |
| `cleanup.js` | Cleanup + aggregation |
| `db-backup.js` | Backup with rotation |
| `disk-usage.js` | Disk monitoring |
| `logs/maintenance.log` | All maintenance activity |
| `db/backup/` | Backup storage |

## 🔧 Cron Setup

### Recommended: PM2 Cron
```bash
pm2 install pm2-cron

# Add to ecosystem.config.js:
{
  name: 'db-maintenance',
  script: 'daily-maintenance.js',
  cron_restart: '0 6 * * *',  // 06:00 UTC = 03:00 BRT
  autorestart: false
}
```

### Alternative: Manual Crontab
```bash
crontab -e

# Add this line:
0 6 * * * cd /home/openclaw/.openclaw/workspace/skills/turbo-station-monitor && /usr/bin/node daily-maintenance.js >> logs/maintenance.log 2>&1
```

## 🚨 Troubleshooting

### Cleanup not running
```bash
# Check cron
crontab -l | grep maintenance

# Test manually
node daily-maintenance.js

# Check logs
tail logs/maintenance.log
```

### Database locked
```bash
# Check active processes
pm2 status

# Stop collectors temporarily
pm2 stop smart-collector

# Run maintenance
node daily-maintenance.js

# Restart
pm2 start smart-collector
```

### Disk full
```bash
# Check space
df -h

# Manual cleanup
node cleanup.js

# Check backup count
ls db/backup/ | wc -l

# Remove old backups manually if needed
rm db/backup/logs-2026-01-*.db
```

## 📈 Expected Behavior

### Daily Maintenance Cycle
1. **Backup** (06:00 UTC)
   - Creates `db/backup/logs-YYYY-MM-DD.db`
   - Rotates old backups (keeps 7)
   
2. **Cleanup**
   - Finds logs older than 30 days
   - Creates daily aggregates
   - Deletes old logs
   - Runs VACUUM

3. **Disk Check**
   - Reports database size
   - Reports backup size
   - Alerts if > 500 MB

### Log Output
```
[timestamp] 🔧 Starting daily maintenance...
[timestamp] STEP 1/3: Database Backup
[timestamp] ✅ Backup created: XX.XX MB
[timestamp] STEP 2/3: Database Cleanup
[timestamp] 📊 Logs to delete: X total
[timestamp] ✅ Deleted X rows
[timestamp] 💾 Space freed: XX.XX MB
[timestamp] STEP 3/3: Disk Usage Check
[timestamp] ✅ Disk usage OK (XX.XX MB)
[timestamp] ✅ Daily maintenance completed successfully!
```

## 🎯 Success Indicators

✅ Backups created daily in `db/backup/`  
✅ Maintenance log shows "completed successfully"  
✅ Database size stays under ~500 MB  
✅ `daily_aggregates` table growing  
✅ Old logs being deleted (check with date range query)  

## 📚 Documentation

- **PHASE5_README.md** - Full guide
- **CRON_SETUP.md** - Scheduling options
- **PHASE5_SUMMARY.md** - Implementation details
- **INTEGRATION.md** - Project overview

## 🆘 Need Help?

1. Run verification: `node verify-phase5.js`
2. Check logs: `tail -50 logs/maintenance.log`
3. Test manually: `node daily-maintenance.js`
4. Review docs: `cat PHASE5_README.md`

---

**Last Updated:** 2026-02-12 04:10 UTC  
**Status:** ✅ Production Ready
