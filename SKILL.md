---
name: turbo-station-monitor
description: Monitoramento e debug da Turbo Station (OCPP, mobile telemetry e Vercel/Next.js). Use para: investigar incidentes rapidamente, saber onde os logs são salvos (SQLite/PM2), consultar schema/tabelas (`logs`, `vercel_logs`), entender paths e componentes do pipeline de observabilidade.
---

# Turbo Station Monitor

## Mapa de logs (paths + schemas)

Leia: `references/logs-guide.md`

## Componentes principais (paths)

- Root: `/home/openclaw/.openclaw/workspace/skills/turbo-station-monitor/`
- Vercel drain server: `vercel-drain.js`
- DB SQLite: `db/logs.db`
- Queue GitHub webhook: `github-webhook-queue.jsonl`
- History buffers: `history/`
