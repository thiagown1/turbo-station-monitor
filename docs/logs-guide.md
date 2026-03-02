# Turbo Station — Logs: paths & schemas

Objetivo: ter **um mapa único** de onde ficam os logs da Turbo Station.

## SQLite (principal)

**DB:**
- `/home/openclaw/.openclaw/workspace/skills/turbo-station-monitor/db/logs.db`

### Tabela `logs` (eventos genéricos: OCPP + mobile telemetry)

Colunas (principais):
- `timestamp` (INTEGER)
- `source` (TEXT)  
  - ex: `mobile` para mobile telemetry
- `charger_id` (TEXT, nullable)
- `event_type` (TEXT, nullable)
- `category` (TEXT, nullable)
- `severity` (TEXT, nullable)
- `message` (TEXT)
- `logger` (TEXT, nullable)
- `meta` (TEXT JSON)

### Tabela `vercel_logs` (request logs do backend via Vercel Log Drain)

Colunas:
- `id` (INTEGER PK autoincrement)
- `timestamp` (INTEGER)
- `endpoint` (TEXT)
- `method` (TEXT)
- `status_code` (INTEGER)
- `duration_ms` (INTEGER)
- `region` (TEXT)
- `level` (TEXT)
- `request_id` (TEXT)
- `body` (TEXT)
- `meta` (TEXT JSON — payload bruto completo)

Índices:
- `idx_vercel_logs_timestamp`
- `idx_vercel_logs_endpoint_ts`
- `idx_vercel_logs_status_ts`
- `idx_vercel_logs_request_id`

## PM2 logs (fallback)

Quando você precisa ver o que o serviço está fazendo (ou se algo falhou antes de ir pro SQLite):
- `~/.pm2/logs/vercel-drain-out.log`
- `~/.pm2/logs/vercel-drain-error.log`
