# Turbo Station Monitor

Observability and automation stack for [Turbo Station](https://turbostation.com.br) — the EV charging platform.

Runs on a VPS as a set of PM2-managed Node.js services that collect, store, and alert on data from OCPP chargers, the mobile app, Vercel deployments, GitHub CI, and payment webhooks.

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                        VPS (PM2)                                 │
│                                                                  │
│  ┌─────────────────┐  ┌─────────────────┐  ┌──────────────────┐ │
│  │ ocpp-collector   │  │ vercel-drain     │  │ mobile-telemetry │ │
│  │ (WebSocket+REST) │  │ :3001            │  │ :3003            │ │
│  │    ↓             │  │    ↓             │  │    ↓             │ │
│  │ db/ocpp.db       │  │ db/vercel.db     │  │ db/mobile.db     │ │
│  └─────────────────┘  └─────────────────┘  └──────────────────┘ │
│                                                                  │
│  ┌─────────────────┐  ┌─────────────────┐  ┌──────────────────┐ │
│  │ github-webhook   │  │ pagarme-webhook  │  │ alert-engine     │ │
│  │ :3002            │  │ :3004            │  │ (daemon)         │ │
│  └─────────────────┘  └─────────────────┘  └──────────────────┘ │
│                                                                  │
│  ┌─────────────────┐                                             │
│  │ ocpp-alerts      │  ← reads ocpp.db, sends Telegram alerts   │
│  └─────────────────┘                                             │
└──────────────────────────────────────────────────────────────────┘
```

## Services

| Service | Port | Script | Description |
|---|---|---|---|
| `ocpp-collector` | — | `smart-collector.js` | WebSocket + REST poller for OCPP charger logs → `db/ocpp.db` |
| `ocpp-alerts` | — | `alert-processor.js` | Monitors OCPP events, triggers alerts for faults/recovery |
| `vercel-drain` | 3001 | `vercel-drain.js` | Vercel log drain webhook → `db/vercel.db` |
| `github-webhook` | 3002 | `github-webhook.js` | GitHub CI webhook, auto-fixes failing builds |
| `mobile-telemetry` | 3003 | `mobile-telemetry.js` | Mobile app telemetry ingress → `db/mobile.db` |
| `pagarme-status-webhook` | 3004 | `pagarme-status-webhook.js` | Payment status updates → Telegram notifications |
| `alert-engine` | — | `alert-engine.js` | Advanced alerting with rate limiting, grouping, Telegram |

## Quick Start

```bash
# Install dependencies
npm install

# Start all services
npm start          # or: pm2 start ecosystem.config.js

# Check status
npm run status     # or: pm2 list

# View logs
npm run logs       # or: pm2 logs
```

## Databases

All data is stored in SQLite (WAL mode) under `db/`:

| Database | Size | Contents |
|---|---|---|
| `db/ocpp.db` | ~10 GB | OCPP charger events (`ocpp_raw`, `ocpp_events`) |
| `db/vercel.db` | ~580 MB | Vercel deployment logs |
| `db/mobile.db` | ~3.4 MB | Mobile app telemetry (`mobile_raw`, `mobile_events`) |
| `db/logs.db` | ~30 MB | Legacy shared log table (deprecated) |

## PM2 Commands

```bash
pm2 start ecosystem.config.js   # Start all
pm2 restart mobile-telemetry    # Restart one service
pm2 logs mobile-telemetry       # Tail logs
pm2 monit                       # Real-time dashboard
```

## Maintenance

```bash
npm run maintenance     # Daily cleanup, vacuum DBs
npm run db:backup       # Backup databases
```
