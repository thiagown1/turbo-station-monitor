# Port map and the rules that keep it honest

Every HTTP service in this repo runs on one box, under one pm2 daemon, behind
one nginx. Ports are the only thing keeping them apart, so they are treated as
part of the contract rather than a detail.

## The map

| Port | Service                  | Env var                   | nginx path              |
|------|--------------------------|---------------------------|-------------------------|
| 3001 | `vercel-drain`           | `VERCEL_DRAIN_PORT`       | `/` (catch-all)         |
| 3002 | `github-webhook`         | `GITHUB_WEBHOOK_PORT`     | `/api/github/webhook`   |
| 3003 | `mobile-telemetry`       | `MOBILE_TELEMETRY_PORT`   | `/api/telemetry/`       |
| 3004 | `pagarme-status-webhook` | `PAGARME_WEBHOOK_PORT`    | `/api/pagarme/status-webhook` |
| 3005 | `support-copilot`        | `SUPPORT_COPILOT_PORT`    | `/api/support/`         |
| 3010 | `vercel-deploy-hook`     | `VERCEL_DEPLOY_HOOK_PORT` | `= /vercel-deploy-hook` |

Source of truth: `ecosystem.config.js`, overridable per-box from `.env`.

## Rules

1. **A service never reads the generic `process.env.PORT`.** It resolves its own
   variable through `services/lib/service-port.js`. A generic `PORT` in the
   environment is logged as a warning and otherwise ignored.
2. **Bind loopback.** `BIND_HOST` defaults to `127.0.0.1`. nginx is the only
   public entry point and it holds the TLS and the auth. Publishing a service on
   `0.0.0.0` puts a webhook receiver on the open internet with nothing but the
   firewall in front of it.
3. **Rapid restarts must stop, not loop.** `max_restarts: 10` + `min_uptime: '30s'`
   so `EADDRINUSE` shows up as `errored` in `pm2 ls` instead of hiding inside a
   five-figure restart counter.
4. **Every `/health` stamps `X-Service: <name>`.** Bodies cannot identify a
   service (two of them answer a bare `OK\n`), so the header is what
   `scripts/check-ports.js` reads to tell which process owns a socket.

## Checking it

```sh
npm run check:ports        # config + nginx + live identity probe
npm run test:ports         # unit tests for the resolution rules
```

`check:ports` exits non-zero on any problem, so it is safe to cron. It probes
each port eight times and fails if a port answers as more than one service —
the signature of two processes sharing a socket.

## Why this file exists — the 2026-07-20 incident

`vercel-drain`, `github-webhook` and `mobile-telemetry` were all running with
`PORT=3002` in their pm2 environment (the ecosystem file was correct; the
running processes had drifted, most likely from a `pm2 restart <name>
--update-env` in a shell that had `PORT` exported). Two of them bound `:3002`
simultaneously and the kernel round-robined connections between them.

Consequences, none of which raised an alarm on their own:

- **~50% of production Vercel logs lost.** Half of every batch hit
  mobile-telemetry's Express 404 handler. Vercel treats `404` as delivered and
  never retries, so those logs are gone. nginx counted 76,163 × `200` against
  76,502 × `404` in a single day.
- **~50% of GitHub webhooks lost**, same mechanism — including the PR-merged
  events the auto-doc worker consumes.
- **Mobile telemetry ingest fully down.** Nothing was left on `:3003`, so
  `/api/telemetry/*` returned `502` for every event.
- **27,652 restarts** of `mobile-telemetry`, crash-looping on `EADDRINUSE` at
  roughly one restart every 3.5 seconds, silently.

What actually surfaced it was an unrelated alert ("Ingest vercel parado/sem
dados", itself a transient Vercel-side delivery pause). The port collision had
been running underneath for far longer. Rules 1-4 above and `check-ports.js`
exist so the next occurrence is caught by a probe rather than by luck.
