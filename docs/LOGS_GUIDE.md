# Turbo Station Logs — Guia rápido (OCPP + Mobile + Vercel)

Objetivo: **achar problemas rápido** sem “ficar lendo log bruto”.

Este guia descreve **onde cada tipo de log mora** e como consultar.

> DB padrão: `skills/turbo-station-monitor/db/logs.db` (SQLite)

---

## 1) OCPP / Alertas / Eventos (charger)

**Fonte:** coletor OCPP + alert engine (processos PM2)

**Armazenamento:**
- SQLite: tabela `logs` e/ou tabelas auxiliares (ex: `alerts`, `problem_analyses` dependendo do caso)
- Em geral: `logs.source` não é `vercel`; costuma ser algo do pipeline OCPP.

**Consultas típicas:**
- Por charger/estação (quando existe `charger_id`)
- Por categoria/event_type

---

## 2) Mobile Telemetry (app Flutter)

**Fonte:** endpoint `POST /api/telemetry/mobile` (recebido pelo `vercel-drain.js`)

**Armazenamento atual (hoje):**
- SQLite: tabela `logs`
  - `source = 'mobile'`
  - colunas usadas: `timestamp, charger_id, event_type, category, severity, message, logger, meta`

**Consultas típicas:**
- Por `event_type` (ex: `transaction_error`)
- Por `session_id` dentro de `meta`

---

## 3) Vercel Logs (backend / Next.js API)

**Fonte:** Vercel Log Drain (NDJSON) recebido no endpoint `/vercel-drain`

**Estado atual:**
- O código tenta inserir em SQLite, mas o schema atual da tabela `logs` não comporta os campos da Vercel (ex: `endpoint`, `status_code`, `duration_ms`, `region`).
- Na prática, quando falha salvar em SQLite, ainda fica rastreável via PM2 logs do processo.

**PM2 (fallback, sempre existe):**
- `~/.pm2/logs/vercel-drain-out.log`
- `~/.pm2/logs/vercel-drain-error.log`

**Decisão recomendada:**
- Criar **tabela separada** `vercel_logs` para request logs (endpoint/status/duration/request_id/body/meta).
- Motivo: consultas de incidentes são quase sempre “por endpoint + status + janela de tempo”, e isso pede índices próprios.

**Consultas típicas desejadas (quando `vercel_logs` existir):**
- `endpoint LIKE '/api/users/%'` numa janela de tempo
- `status_code >= 400` agrupado por endpoint
- picos de `duration_ms`

---

## Como isso ajuda a “achar problema rápido”

- **OCPP**: problemas físicos / conectividade / comportamento do charger.
- **Mobile telemetry**: o que o app fez / o que o usuário viu / onde falhou no fluxo.
- **Vercel logs**: o que a API respondeu (erro real, stack trace, status code, latência).

A melhor investigação costuma ser:
1) Vercel (erro + endpoint) → 2) Mobile (contexto do usuário) → 3) OCPP (se o erro encosta no charger).

---

## Próximo passo (implementação)

Quando você aprovar, eu faço:
1) Migration: criar `vercel_logs` (e índices)
2) Patch no `vercel-drain.js` para gravar em `vercel_logs`
3) Restart do PM2 `vercel-drain`
4) Verificação: inserir 1 evento de teste e checar query no SQLite
