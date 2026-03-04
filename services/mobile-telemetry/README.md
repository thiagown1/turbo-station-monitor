# Mobile Telemetry Service

Ingests telemetry events from the Turbo Station mobile app and exposes
read-only query endpoints for the dashboard.

## Routes

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/health` `/ping` | — | Liveness probe |
| `GET` | `/api/telemetry/online-users` | `X-Monitor-Secret` | Currently active app users |
| `GET` | `/api/telemetry/heatmap-data` | `X-Monitor-Secret` | Aggregated user demand density |
| `POST` | `/api/telemetry/mobile` | *(disabled)* | Event ingestion from mobile app |
| `POST` | `/api/telemetry/user-logs` | — | User-submitted diagnostic log dump |
| `GET` | `/api/telemetry/user-logs` | `X-Monitor-Secret` | Query stored log dumps |

## Architecture

```
mobile-telemetry/
  index.js              ← Express app + server bootstrap
  lib/
    constants.js        ← env vars, limits, tunables
    db.js               ← SQLite connection, schema, prepared statements
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

Prepared statements are created once at startup in `lib/db.js` and reused
per request for performance.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3003` | HTTP port |
| `TELEMETRY_API_KEY` | *(hardcoded)* | Mobile app auth key (currently disabled) |
| `MONITOR_API_SECRET` | *(empty)* | Shared secret for dashboard endpoints |

## Local Development

```bash
# From turbo-station-monitor root:
node services/mobile-telemetry/index.js

# Or via PM2:
pm2 restart mobile-telemetry
```
