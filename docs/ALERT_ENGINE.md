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
  sent_at INTEGER,
  wa_message_id TEXT      -- upstream WhatsApp message id (for late delivery confirmation)
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

### Delivery confirmation + retry (added 2026-07-18)

A 2xx from the support API only means the message was **queued** — Evolution
fires async and the message's `delivery_status` can still flip to `failed`
(e.g. WhatsApp instance disconnected). The engine therefore:

1. POSTs the message, keeps the returned message id (`wa_message_id`).
2. Polls `GET .../conversations/{conv}/messages?limit=50` for that id's
   `delivery_status` with a short backoff (default `500/1000/2000/3000` ms,
   tunable via `WHATSAPP_DELIVERY_POLL_MS`).
3. Marks the alert `sent=1` only on a confirmed `sent`.
4. Unconfirmed/failed alerts stay `sent=0`; each detection tick retries
   alerts younger than 30 min (max 5 per tick). A retried alert with a
   recorded `wa_message_id` is late-confirmed first, so a slow-but-successful
   delivery never produces a duplicate message in the group.

This mirrors `confirmDelivery` in the Next.js `whatsapp-notifier` and closes
the silent-loss window found in the 2026-07-16 cable-theft investigation.

### Cable-theft alert: burst-then-silence (added 2026-07-18)

A cut DC cable severs the connector's temperature sensor, so the charger
reports `Faulted / HighTemperature / DC OverTemp Connector` (recognized by
`isCableTheftSuspectFault`) and **keeps re-reporting it every ~5 min for as
long as it stays broken** — Metrópole Shopping 3 did so from 03:53 to 18:51 BRT
(15h). Under the normal escalating backoff that re-paged the "Turbo Station +
URGENTE" group hourly, then every 6h. Once the team knows the cable is stolen,
those repeats are pure noise.

Cable-theft faults are therefore taken **off the escalating backoff** and gated
by `shouldAlertCableTheft(chargerId, connectorId)` instead:

1. **Fresh incident** (no prior record, OR the connector has recovered since the
   last alert) → send a **burst** of `CABLE_THEFT_BURST_COUNT` messages
   (default 5) `CABLE_THEFT_BURST_INTERVAL_MS` apart (default 10s) to the
   URGENTE group. Each is numbered (`Aviso N/5`); the last states no further
   alerts fire until the station normalizes. The burst is fire-and-forget so
   its spacing never blocks the detection tick.
2. **Ongoing incident** (still faulted, no recovery) → **silent**. No re-burst,
   no re-ping.
3. **Recovery** = the connector reports an OPERATIONAL status again
   (`hasConnectorRecoveredSince`, per-connector so a healthy connector 1 never
   masks a stolen connector 2). A later theft after a recovery is a fresh
   incident and bursts again.

Incident state persists in `history/cable_theft_incidents.json` (survives
restarts; pruned after 30 days). Env overrides:
`ALERT_CABLE_THEFT_BURST_COUNT`, `ALERT_CABLE_THEFT_BURST_INTERVAL_MS`.

The critical **FCM push** for the same fault is a separate, independent path in
the Next.js repo (`high-temp-critical-push.ts`) — the VPS cannot send FCM. The
two detect the same signal via independent pipelines on purpose (see the
drift-warning comments on `isCableTheftSuspectFault` / `isHighTempFault`).

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
