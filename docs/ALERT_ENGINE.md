# Alert Engine - Phase 4

## Overview

The Alert Engine is a proactive monitoring system that queries the unified SQLite logs database to detect Vercel backend issues and correlate them with OCPP charger events.

## Features

### Detection Queries

1. **Vercel 5xx Errors** (`vercel_5xx`)
   - Detects HTTP 500-599 errors on OCPP webhook endpoints
   - Groups by endpoint to avoid spam
   - Severity: **critical**

2. **Vercel Timeouts** (`vercel_timeout`)
   - Detects requests with NULL/0 status and duration >10s
   - Indicates cold starts, infinite loops, or platform timeouts
   - Severity: **critical**

3. **High Latency** (`vercel_latency`)
   - Detects successful requests (2xx/3xx) with latency >2s
   - Only alerts if ≥3 occurrences to avoid false positives
   - Severity: **warning**

4. **OCPP+Vercel Correlation** (`ocpp_vercel_correlation`)
   - Correlates charger errors with backend errors within ±30s window
   - Helps identify backend-caused charger failures
   - Severity: **critical**

## Debounce Logic

- **Problem alerts:** 1 hour debounce window
- **Cache cleanup:** Automatic after 24 hours
- **Cache file:** `history/alert_engine_debounce.json`

## Alert Storage

All detected alerts are saved to the `alerts` table in SQLite:

```sql
CREATE TABLE alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  charger_id TEXT,
  severity TEXT CHECK(severity IN ('critical', 'warning', 'info')),
  title TEXT NOT NULL,
  description TEXT,
  ocpp_log_ids TEXT,      -- JSON array of related OCPP log IDs
  vercel_log_ids TEXT,    -- JSON array of related Vercel log IDs
  sent BOOLEAN DEFAULT 0,
  sent_at INTEGER
);
```

This enables:
- Alert history and auditing
- Traceability back to raw logs
- Future dashboard/analytics

## WhatsApp Integration

Alerts are sent to the OCPP Alerts WhatsApp group using the existing alert formatter pattern:

```
🔴 *Erro 500 no backend OCPP*

📋 3 erro(s) 5xx em /api/ocpp/webhook nos últimos 5 minutos
🌐 Endpoint: `/api/ocpp/webhook`
❌ Status: 500
🔢 Ocorrências: 3
🕐 01:10

⚡ Ação: Verificar logs Vercel e backend
```

## Performance

- **Query window:** Last 5 minutes (300,000ms)
- **Query efficiency:** Uses indexes on `timestamp`, `status_code`, `endpoint`
- **Correlation window:** ±30 seconds
- **Execution:** ~50-200ms per detection run
- **PM2 schedule:** Every 2 minutes via `cron_restart`

## Files

- **`alert-engine.js`** - Main engine (detection + formatting + sending)
- **`test-alert-engine.js`** - Test script with sample data
- **`history/alert_engine_debounce.json`** - Debounce cache
- **`logs/alert-engine-out.log`** - PM2 stdout logs
- **`logs/alert-engine-error.log`** - PM2 error logs

## Usage

### Start with PM2

```bash
pm2 start ecosystem.config.js --only alert-engine
pm2 logs alert-engine
```

### Run manually (test)

```bash
node alert-engine.js
```

### Test detection

```bash
./test-alert-engine.js
```

### Check alerts in database

```bash
node -e "
  const db = require('better-sqlite3')('db/logs.db');
  console.log(db.prepare('SELECT * FROM alerts ORDER BY created_at DESC LIMIT 10').all());
  db.close();
"
```

## Integration with Existing System

The Alert Engine **does NOT duplicate OCPP alerts**. It focuses exclusively on:

1. **Vercel-specific issues** (5xx, timeouts, latency)
2. **Cross-system correlations** (OCPP + Vercel)

The existing `alert-processor.js` continues to handle:
- Charger faults
- Transaction failures
- Auth rejections
- Charger recovery notifications

Both systems write to the same WhatsApp group but monitor different problem domains.

## Future Enhancements

- [ ] Adaptive thresholds (learn normal latency patterns)
- [ ] Weekly summary reports
- [ ] Integration with Vercel deployment events (correlate errors with deploys)
- [ ] Slack/Discord notifications
- [ ] Alert escalation (if not resolved in X hours)

## Monitoring

Check PM2 status:
```bash
pm2 status alert-engine
```

View recent logs:
```bash
pm2 logs alert-engine --lines 50
```

Restart manually:
```bash
pm2 restart alert-engine
```

## Troubleshooting

**No alerts being sent:**
- Check if logs exist in database: `SELECT COUNT(*) FROM logs WHERE source='vercel'`
- Check debounce cache: `cat history/alert_engine_debounce.json`
- Run test script: `./test-alert-engine.js`

**Too many alerts (spam):**
- Increase `DEBOUNCE_WINDOW` in `alert-engine.js`
- Adjust detection thresholds (e.g., require more occurrences)

**Alerts not reaching WhatsApp:**
- Check PM2 logs: `pm2 logs alert-engine --err`
- Test WhatsApp connection: `openclaw message send --channel whatsapp --target '120363423472541295@g.us' --message 'Test'`

---

**Built:** 2026-02-12 04:08 UTC  
**Status:** ✅ Production Ready  
**Next Phase:** Maintenance & Cleanup (Phase 5)
