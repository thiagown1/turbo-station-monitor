# Phase 5: Database Maintenance - README

## Overview

Complete database maintenance system for OCPP+Vercel SQLite integration with:
- ✅ Automatic cleanup of logs older than 30 days
- ✅ Daily aggregates creation before deletion
- ✅ Automated backups with rotation (7 backups max)
- ✅ Disk usage monitoring and alerts
- ✅ Scheduled daily execution via cron

## Scripts

### 1. `cleanup.js` - Database Cleanup
Deletes logs older than 30 days and creates daily aggregates.

**Features:**
- Creates aggregates before deletion (no data loss)
- Transactional deletes (safe from corruption)
- VACUUM after cleanup to reclaim disk space
- Detailed statistics logging

**Aggregates created:**
- OCPP: Event count by charger/day/event_type
- Vercel: Request count, error count, avg/max latency by endpoint/day

**Manual run:**
```bash
cd /home/openclaw/.openclaw/workspace/skills/turbo-station-monitor
node cleanup.js
```

### 2. `db-backup.js` - Database Backup
Creates backups of logs.db with automatic rotation.

**Features:**
- Timestamped backups (logs-YYYY-MM-DD.db)
- Keeps last 7 backups, deletes older ones
- Integrity verification (file size check)
- Size reporting

**Manual run:**
```bash
node db-backup.js
```

**Backup location:** `db/backup/`

### 3. `disk-usage.js` - Disk Usage Monitor
Monitors database and backup sizes with threshold alerts.

**Thresholds:**
- 🟢 OK: < 500 MB
- 🟠 Warning: ≥ 500 MB
- 🔴 Critical: ≥ 1000 MB

**Manual run:**
```bash
node disk-usage.js
```

**Exit codes:**
- 0: OK
- 1: Warning
- 2: Critical

### 4. `daily-maintenance.js` - Main Runner
Executes all maintenance tasks in sequence:
1. Backup database
2. Cleanup old logs
3. Check disk usage

**Manual run:**
```bash
node daily-maintenance.js
```

**Log file:** `logs/maintenance.log`

## Automated Scheduling

### Recommended: Cron Job
Run daily at **03:00 BRT (06:00 UTC)**

See `CRON_SETUP.md` for detailed setup instructions with multiple options:
- User crontab (manual setup)
- PM2 cron module
- Systemd timer

**Quick setup:**
```bash
./setup-cron.sh
```

## Database Schema Changes

New table created automatically by `cleanup.js`:

```sql
CREATE TABLE daily_aggregates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  source TEXT NOT NULL,
  
  -- OCPP aggregates
  charger_id TEXT,
  event_type TEXT,
  event_count INTEGER,
  
  -- Vercel aggregates
  endpoint TEXT,
  request_count INTEGER,
  error_count INTEGER,
  avg_duration_ms REAL,
  max_duration_ms INTEGER,
  
  created_at INTEGER NOT NULL,
  UNIQUE(date, source, charger_id, event_type, endpoint)
);
```

## Data Retention Policy

- **Raw logs:** 30 days (deleted after aggregation)
- **Daily aggregates:** Indefinite (kept forever)
- **Backups:** 7 most recent (rotating)

## Monitoring

### Check Maintenance Logs
```bash
tail -f logs/maintenance.log
```

### Verify Aggregates
```bash
sqlite3 db/logs.db "SELECT COUNT(*) FROM daily_aggregates;"
sqlite3 db/logs.db "SELECT date, source, SUM(event_count + request_count) as total FROM daily_aggregates GROUP BY date ORDER BY date DESC LIMIT 10;"
```

### Check Backup Status
```bash
ls -lh db/backup/
```

### Current Disk Usage
```bash
node disk-usage.js
```

## Troubleshooting

### Cleanup not running?
1. Check if cron is configured: `crontab -l | grep maintenance`
2. Check maintenance logs: `tail logs/maintenance.log`
3. Test manually: `node daily-maintenance.js`

### Database locked error?
- Ensure no other processes are using the database
- Check if smart-collector.js is running: `pm2 status`
- SQLite allows concurrent reads but only one writer

### Disk usage too high?
1. Check current size: `du -h db/`
2. Verify cleanup ran: `grep "Cleanup completed" logs/maintenance.log | tail -1`
3. Manual cleanup: `node cleanup.js`
4. Check aggregates table size: `sqlite3 db/logs.db ".schema daily_aggregates"`

### Backups failing?
1. Check disk space: `df -h`
2. Verify backup directory exists: `ls -ld db/backup/`
3. Check permissions: `ls -l db/`
4. Manual backup test: `node db-backup.js`

## Performance Notes

Based on estimates from INTEGRATION.md:

**Expected growth:**
- ~15.5 MB/day (0.5 MB OCPP + 15 MB Vercel)
- ~465 MB/month (with 30-day retention)

**Cleanup impact:**
- Deletes ~15.5 MB/day on average
- VACUUM reclaims space immediately
- Aggregates add ~100-200 KB/day

**Backup storage:**
- 7 backups × ~60 MB each = ~420 MB
- Total DB + backups ≈ 500-600 MB

## Testing

All scripts have been tested and verified:

```bash
# Test cleanup (ran on test data)
node cleanup.js
✅ Created 2 aggregates, deleted 2 old logs, freed 64 KB

# Test backup
node db-backup.js
✅ Created backup: 60 KB, verified integrity

# Test disk usage
node disk-usage.js
✅ Total: 120 KB (0.12 MB) - OK

# Test full maintenance
node daily-maintenance.js
✅ All 3 steps completed successfully
```

## Next Steps

1. **Set up cron:** Run `./setup-cron.sh` or follow `CRON_SETUP.md`
2. **Monitor first run:** Check `logs/maintenance.log` after 06:00 UTC
3. **Adjust thresholds:** Edit `disk-usage.js` if needed
4. **Add alerting:** Integrate disk usage alerts with WhatsApp (future)

## Files Created

```
cleanup.js              - Cleanup + aggregation script
db-backup.js            - Backup with rotation
disk-usage.js           - Disk monitoring
daily-maintenance.js    - Main runner
setup-cron.sh           - Cron installer
CRON_SETUP.md          - Cron documentation
PHASE5_README.md       - This file
```

---

**Phase 5 Status:** ✅ **COMPLETE**

All requirements met and tested. System ready for production use.
