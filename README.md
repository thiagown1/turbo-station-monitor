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
| `github-webhook` | 3002 | `github-webhook.js` | GitHub CI/review webhook and evidence capture |
| `mobile-telemetry` | 3003 | `mobile-telemetry.js` | Mobile app telemetry ingress → `db/mobile.db` |
| `pagarme-status-webhook` | 3004 | `pagarme-status-webhook.js` | Payment status updates → Telegram notifications |
| `alert-engine` | — | `alert-engine.js` | Advanced alerting with rate limiting, grouping, Telegram |

GitHub review automation follows the fail-closed dual-read contract documented
in [`docs/REVIEW_VERDICT_COMPATIBILITY.md`](docs/REVIEW_VERDICT_COMPATIBILITY.md).
Canonical checks are authoritative; legacy approval labels are accepted only
with a marked native review on the exact current PR head.
The monitor does not auto-dispatch write-capable OpenClaw repair. See the same
document for the fail-closed attestation, dedicated-runner, immutable PR tuple,
and separate activation requirements that apply to any future writer.

## Quick Start

```bash
# Install dependencies
npm install

# Required by ocpp-collector. Put this in the managed production `.env`, which
# ecosystem.config.js injects into PM2; never commit the real value.
OCPP_LOGS_TOKEN='<read-only monitor token>'

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
| `db/ocpp.db` | large; measure on host | OCPP charger events (`ocpp_raw`, `ocpp_events`) |
| `db/vercel.db` | ~580 MB | Vercel deployment logs |
| `db/mobile.db` | ~3.4 MB | Mobile app telemetry (`mobile_raw`, `mobile_events`) |
| `db/logs.db` | ~30 MB | Legacy shared log table (deprecated) |

### OCPP collection and retention

The collector uses WebSocket as the primary transport. Only after 30 seconds
without an actual log payload does it enable REST recovery. Recovery calls the
bounded `/api/logs/recent` endpoint every five seconds, schedules each poll
from completion, coalesces concurrent calls, honors `Retry-After`, and backs off
exponentially. During a rolling OCPP deployment only, a `404` falls back to
`/api/logs/history`; other errors never trigger a deep-history fallback.
Each HTTP request, including JSON body consumption, is aborted after ten
seconds. A busy bounded tail is drained oldest-page-first with zero delay
between pages. The initial bootstrap `start_time` is frozen across every page
and retry until the tail is fully drained; an advancing wall clock cannot move
the lower bound past undispatched records. If the raw cap was exhausted,
the collector logs an explicit continuity gap, consumes the available rows and
reanchors from server metadata instead of retrying the same page forever.

`ocpp_raw` defaults to 48 hours and `ocpp_events` to seven days. SQLite runs in
WAL mode with `busy_timeout=5000`; each TTL cycle deletes at most four batches
of 5,000 rows. A saturated cycle schedules another pass through `setImmediate`,
yielding the event loop and SQLite writer lock between bounded passes until the
expired backlog is drained. Do not run `VACUUM` in the hot path.

The database is a derived observability store for alerts, trend analysis and
suggestions. The Turbo Station dashboard continues to query the OCPP service's
per-charger files, so a monitor/SQLite outage does not break operator history.

Before changing indexes or retention on an existing production database,
capture these read-only measurements on the monitor host:

```bash
sqlite3 db/ocpp.db 'PRAGMA journal_mode; PRAGMA busy_timeout; PRAGMA page_count; PRAGMA freelist_count;'
sqlite3 db/ocpp.db 'SELECT "ocpp_raw",count(*),min(timestamp),max(timestamp) FROM ocpp_raw UNION ALL SELECT "ocpp_events",count(*),min(timestamp),max(timestamp) FROM ocpp_events;'
sqlite3 db/ocpp.db 'EXPLAIN QUERY PLAN SELECT * FROM ocpp_events WHERE charger_id=? AND timestamp>=? ORDER BY timestamp DESC LIMIT 100;'
```

Create a composite index only if the real query plan/latency shows it is needed,
using an explicit off-peak migration and rollback plan. Never build a large
index opportunistically during collector startup.

## Payment-credit release signal

`GET /api/telemetry/funnel-counts` accepts `start_ms`, `end_ms`, and the
optional `payment_credit_grace_ms` (two minutes by default). In addition to the
existing request totals, `payments` exposes four aggregate counters used by the
Turbo Station release watch:

- `providerPaidAfterGrace`: unique provider-paid references older than grace;
- `creditsSucceeded`: unique correlated wallet-credit completions;
- `paidWithoutCreditAfterGrace`: old paid references without settlement evidence;
- `creditClaimRegistryUnavailable`: CreditClaim registry failures, de-duplicated per request.

The monitor correlates identifiers internally across checkout, Pagar.me webhook,
PIX polling, and Auto Add logs, but returns counts only. It never exposes a user
or payment identifier and keeps the Vercel database connection read-only.

## PM2 Commands

```bash
pm2 start ecosystem.config.js   # Start all
pm2 restart mobile-telemetry    # Restart one service
pm2 logs mobile-telemetry       # Tail logs
pm2 monit                       # Real-time dashboard
```

## Automatic production deploy

A signed GitHub `push` webhook for `main` starts `scripts/deploy-monitor.js` as
an independent worker. The worker waits for the exact commit's `CI` push run to
finish successfully, fetches and fast-forwards the production checkout, runs a
clean dependency install, restarts only affected PM2 services, verifies their
health endpoints, and records the deployed SHA. If `ocpp-collector` is among
the affected services, the worker first requires a non-empty
`OCPP_LOGS_TOKEN`/`OCPP_DASHBOARD_TOKEN` from the managed `.env` before changing
the checkout. After restart it requires two stable PM2 `online` samples; a
missing secret therefore blocks before merge/install/restart instead of leaving
the collector in a crash loop or reporting a false-success deploy.

The production checkout must be clean. Local source edits make the deploy fail
closed so operational hotfixes cannot be overwritten silently. See
[`docs/AUTO_DEPLOY.md`](docs/AUTO_DEPLOY.md) for recovery and verification.

`deploy-autowatch` is unrelated: it watches OCPP server versions after an OCPP
production release; it does not publish this repository.

## Maintenance

```bash
npm run maintenance     # Daily cleanup, vacuum DBs
npm run db:backup       # Backup databases
```
