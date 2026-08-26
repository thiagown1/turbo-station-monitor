# Mobile Telemetry Service

Ingests telemetry events from the Turbo Station mobile app and exposes
read-only query endpoints for the dashboard.

## Routes

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/health` `/ping` | — | Liveness probe |
| `GET` | `/api/telemetry/online-users` | `X-Monitor-Secret` | Currently active app users |
| `GET` | `/api/telemetry/heatmap-data?brandId=<tenant>` | `X-Monitor-Secret` | Tenant-scoped aggregated user demand density |
| `POST` | `/api/telemetry/mobile` | `X-Telemetry-Key` | Event ingestion from mobile app |
| `POST` | `/api/telemetry/user-logs` | `X-Telemetry-Key` | User-submitted diagnostic log dump |
| `GET` | `/api/telemetry/user-logs` | `X-Monitor-Secret` | Query stored log dumps |

## Architecture

```
mobile-telemetry/
  index.js              ← Express app + server bootstrap
  lib/
    constants.js        ← env vars, limits, tunables
    db.js               ← SQLite connection, schema, prepared statements
    heatmap-query.js     ← tenant-scoped, timestamp-indexed SQL
    heatmap-query-runner.js ← worker lifecycle + 25s deadline
    heatmap-query-worker.js ← isolated better-sqlite3 reader
    utils.js            ← parseLocation(), deriveSeverity()
  middleware/
    auth.js             ← requireSecret (X-Monitor-Secret validation)
  routes/
    health.js           ← GET /health, /ping
    online-users.js     ← GET /api/telemetry/online-users
    heatmap-data.js     ← GET /api/telemetry/heatmap-data
    ingest.js           ← POST /api/telemetry/mobile
    user-logs.js        ← POST/GET /api/telemetry/user-logs
```

## Adding a New Route

1. Create `routes/my-route.js` — export an Express `Router`
2. Mount it in `index.js`:
   ```js
   app.use('/api/telemetry/my-route', requireSecret, require('./routes/my-route'));
   ```
3. Add it to the route table in this README

## Database

Uses a dedicated SQLite database (`db/mobile.db`) with WAL mode. Two tables:

- **`mobile_raw`** — full ingested payloads for debugging and replay
- **`mobile_events`** — normalised events (one row per event) for querying

Most prepared statements are created once at startup in `lib/db.js` and reused
per request. The heatmap is deliberately different: `better-sqlite3` work runs
in a dedicated worker so a large aggregation cannot block ingestion,
`online-users`, or `/health`. Bounded heatmap periods force the existing
`idx_mobile_events_event_timestamp` index; this avoids a deployment-time index
migration on the production database. A 25-second deadline terminates and
recreates a stuck worker before the outer nginx/Vercel timeout.

### Heatmap tenant contract

`brandId` (or the compatibility spelling `brand_id`) is required. The default
`turbo_station` tenant owns legacy rows whose `brand_id` is null; other brands
receive only their explicitly stamped rows. Missing tenant scope and unknown
period values return HTTP 400 rather than falling back to a cross-brand or
unbounded historical scan. Valid periods are `24h`, `7d`, `30d`, and `all`.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3003` | HTTP port |
| `TELEMETRY_API_KEY` | *(required)* | Mobile app ingestion key |
| `MOBILE_TTL_DAYS` | `180` | Retention for `mobile_events` and `mobile_raw` |
| `MONITOR_API_SECRET` | *(empty)* | Shared secret for dashboard endpoints |

## Local Development

```bash
# From turbo-station-monitor root:
node services/mobile-telemetry/index.js

# Or via PM2:
pm2 restart mobile-telemetry
```
