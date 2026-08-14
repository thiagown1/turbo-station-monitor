# Contador — WhatsApp accounting agent

## Responsibility and data flow

The WhatsApp socket is entirely in this repository:

1. PM2 process `whatsapp-gateway` connects to WhatsApp with Baileys and keeps
   its auth state under `services/whatsapp-gateway/auth/`.
2. The gateway downloads inbound media and posts an Evolution-compatible
   `messages.upsert` webhook to `support-copilot` on port 3005.
3. `routes/ingest-evolution.js` authenticates, deduplicates and stores the
   conversation/message in SQLite. Only the configured accounting group is
   offered to the Contador router; other groups keep the existing suggestion
   flow.
4. Deterministically accepted work is persisted in `contador_jobs` before the
   Contador model or Next call. For centrally classified media, the successful
   `agent_media_analyses` row and its deferred `contador_jobs` row commit in the
   same SQLite transaction; a cached classification can also recover a missing
   job without another paid model call. The worker retries transient failures
   and recovers jobs interrupted by a PM2 restart.
5. PDF/structured-photo registration, draft completion and all accounting reads go through the Turbo Station Next
   APIs. The VPS never reads or writes Firestore directly.
6. Outbound replies return through the local gateway and are persisted with
   `messages.source = 'contador'` for audit and reply detection.

Operational ownership is therefore split as follows:

- `whatsapp-gateway`: WhatsApp/Baileys connection, media download and outbound transport.
- `support-copilot`: group allow-list, one paid media classification, durable outbox, model orchestration, history, daily heartbeat and monthly scheduler.
- Turbo Station Next app: secret/kill switch, PDF parsing, structured-photo validation, UC resolution, audited draft completion, accounting validation, Firestore writes and read-only tool shapes.
- Operator (currently Thiago): production activation, group id, secret rotation, OpenClaw agent provisioning and review of blocked/failed jobs.

## Safety defaults

The Contador is inert unless all of these are true:

- `CONTADOR_ENABLED=true`;
- `CONTADOR_GROUP_CONVERSATION_ID` is non-empty and exactly matches the WhatsApp group JID;
- `CONTADOR_NEXT_BASE_URL` is configured;
- `CONTADOR_NEXT_SECRET` (or `ENERGY_BILL_INTAKE_SECRET`) is configured;
- the Next `feature_flags/energy_bill_intake` document is explicitly enabled
  for the same group and brand.

There are two independent kill switches: the local `CONTADOR_ENABLED` and the
Next feature flag. Both fail closed. Deploying this code does not activate
messages or accounting writes.

The model can call only the eight read-only tools exposed by
`/api/accounting/energy-agent/query`, with at most five tool calls per turn.
The only writes are the deterministic intake keyed by the original WhatsApp
message id and an exact `resolve_draft` action for a quoted operator reply.
The latter names one draft and optionally one station/field patch; the Next
boundary revalidates group, brand, production station and `energyPaidBy` before
writing. Context sent to the model is capped at 30 messages and masks email
addresses and long numeric identifiers. Structured amounts and tariffs are
queried on demand, never read from memory files.

## Runtime configuration

| Variable | Required to activate | Default / purpose |
|---|---:|---|
| `CONTADOR_ENABLED` | yes | `false`; master kill switch |
| `CONTADOR_GROUP_CONVERSATION_ID` | yes | exact group JID, e.g. `...@g.us` |
| `CONTADOR_NEXT_BASE_URL` | yes | Turbo Station app origin, no trailing slash |
| `CONTADOR_NEXT_SECRET` | yes | scoped Bearer secret; can fall back to `ENERGY_BILL_INTAKE_SECRET` |
| `CONTADOR_INSTANCE` | no | gateway instance, default `turbostation`; set it explicitly to the existing Baileys instance name in production |
| `CONTADOR_OPENCLAW_AGENT` | no | dedicated agent id, default `contador` |
| `CONTADOR_OPENCLAW_MODEL` | no | default `claude-cli/claude-opus-4-8` |
| `CONTADOR_SESSION_ID` | no | persistent group session, default `contador-contas` |
| `CONTADOR_HEARTBEAT_HOUR` | no | local São Paulo hour, default `8` |
| `CONTADOR_MONTHLY_DAY` | no | monthly closing day, default `3` (clamped to 1..28) |
| `SUPPORT_COPILOT_MEDIA_DIR` | no | shared media directory; must be readable by ingest and worker |

Provision the dedicated OpenClaw agent with a workspace based on
`contador-workspace/`. Copy the template after `openclaw agents add` as well,
so the generated generic `AGENTS.md` cannot replace the Contador protocol. Its
identity and long-term notes live there; the SQLite conversation and fixed
session id provide short-term continuity. Do not copy secrets or structured
monthly values into the workspace.

## Implemented behavior

- deterministic gate for PDF, accounting questions, explicit mentions and
  replies to a prior Contador message;
- ordinary group chatter is ignored without invoking Opus;
- PDF bytes are read from the local media directory and forwarded to the Next
  intake; its `replyMessage` is sent verbatim;
- an image/PDF in the accounting group is classified exactly once by the
  central media router. For an energy photo, the configured vision provider
  receives the image and returns a minimal typed extraction; the raw image is
  not forwarded to Next. kWh and amount bounds match the ledger contract, and
  implausible fields fail closed at both boundaries;
- a quoted reply such as “é do Galois” can consult `estacoes` and submit one
  exact `draftId + stationId` only when the quoted outbound message carries the
  same draft prompt metadata. Quoting another Contador heartbeat, summary or
  draft cannot authorize the write. Confirmed UC mappings are persisted and
  replaying the reply does not duplicate the original entry. If OCR did not
  produce a stable UC, the operator may provide it literally in the quoted
  reply before registration;
- natural-language questions use the read-only tool loop and Claude Opus in a
  persistent OpenClaw session;
- daily heartbeat queries upcoming bills, open drafts and current-month
  pendencies; it is silent if all three are empty and has a once-per-day ledger;
- once the day-3 heartbeat schedule has passed, a separate once-per-month
  ledger closes the previous month (including catch-up after a deploy/outage)
  using `resumo_contabil`, `resumo_energia`, `pendencias` and
  `drafts_abertos`, enriched with `contas_a_vencer`; it replaces that day's
  ordinary heartbeat so the group receives at most one proactive summary and
  stays silent without trusted data;
- failed model/API work is visible in `contador_jobs` with attempts and a
  redacted error, and transient failures use bounded backoff.

## Expense receipts and recurrence

The central router may extract supplier, category, competency, currency and the
settled BRL amount from an expense receipt. When the dashboard explicitly
enables WhatsApp expense confirmation, the Contador asks whether to register
the charge once, register it and mark it monthly recurring, or ignore it.

The reply must cite the Contador prompt containing `EXP-XXXXXXXX`, originate in
the configured accounting group and carry an allowlisted stable `senderId`.
The Next boundary revalidates all of those controls before any financial write.
A recurring rule creates only an expectation for another receipt; it never
copies a charge into a future month.

The router never calculates foreign exchange. If a foreign-currency document
does not show the final amount settled in BRL, the Contador asks for `valor R$
...`. That reply only fills the review; the user must still make a second,
explicit register-once or register-recurring decision.

## Remaining product boundary

Future accounting context remains tracked here: a brand-scoped read-only API
for complete company expenses (not only energy) is still out of scope.

## Activation and rollback runbook

Activation is a separate production change and requires explicit approval.

1. Deploy the reviewed commit with `CONTADOR_ENABLED=false` and verify both PM2
   services, `/health`, SQLite migrations and gateway connection state.
2. Provision the `contador` OpenClaw agent/workspace and run an offline prompt
   smoke test without sending WhatsApp messages.
3. Verify the exact group JID and that the Next feature flag is enabled for the
   same group/brand. Test the Next query, PDF/photo intake and draft completion with a non-production
   fixture or approved dry run.
4. Set the local config and enable `CONTADOR_ENABLED=true` in a separate step;
   restart only `support-copilot` and observe `contador_jobs` plus both PM2 logs.
5. Test one question, one approved PDF, one photo and one quoted draft reply.
   Confirm one outbound message per inbound id, the resulting dashboard entry,
   the UC mapping and both scheduler ledgers.

Rollback: set `CONTADOR_ENABLED=false` and restart `support-copilot`. If the
Next half must also stop, disable `feature_flags/energy_bill_intake`. Do not
delete SQLite jobs or WhatsApp auth state during rollback.
