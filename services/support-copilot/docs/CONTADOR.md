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
4. `contador-runtime.js` persists accepted work in `contador_jobs` before any
   model or network call. The worker retries transient failures and recovers
   jobs interrupted by a PM2 restart.
5. PDF registration and all accounting reads go through the Turbo Station Next
   APIs. The VPS never reads or writes Firestore directly.
6. Outbound replies return through the local gateway and are persisted with
   `messages.source = 'contador'` for audit and reply detection.

Operational ownership is therefore split as follows:

- `whatsapp-gateway`: WhatsApp/Baileys connection, media download and outbound transport.
- `support-copilot`: group allow-list, durable outbox, model orchestration, history and daily heartbeat.
- Turbo Station Next app: secret/kill switch, PDF parsing, UC resolution, accounting validation, Firestore writes and read-only tool shapes.
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
The only write is the deterministic PDF intake keyed by the original WhatsApp
message id. Context sent to the model is capped at 30 messages and masks email
addresses and long numeric identifiers. Structured amounts and tariffs are
queried on demand, never read from memory files.

## Runtime configuration

| Variable | Required to activate | Default / purpose |
|---|---:|---|
| `CONTADOR_ENABLED` | yes | `false`; master kill switch |
| `CONTADOR_GROUP_CONVERSATION_ID` | yes | exact group JID, e.g. `...@g.us` |
| `CONTADOR_NEXT_BASE_URL` | yes | Turbo Station app origin, no trailing slash |
| `CONTADOR_NEXT_SECRET` | yes | scoped Bearer secret; can fall back to `ENERGY_BILL_INTAKE_SECRET` |
| `CONTADOR_INSTANCE` | no | gateway instance, default `turbostation` |
| `CONTADOR_OPENCLAW_AGENT` | no | dedicated agent id, default `contador` |
| `CONTADOR_OPENCLAW_MODEL` | no | default `claude-cli/claude-opus-4-8` |
| `CONTADOR_SESSION_ID` | no | persistent group session, default `contador-contas` |
| `CONTADOR_HEARTBEAT_HOUR` | no | local São Paulo hour, default `8` |
| `SUPPORT_COPILOT_MEDIA_DIR` | no | shared media directory; must be readable by ingest and worker |

Provision the dedicated OpenClaw agent with a workspace based on
`contador-workspace/`. Its identity and long-term notes live there; the SQLite
conversation and fixed session id provide short-term continuity. Do not copy
secrets or structured monthly values into the workspace.

## Implemented behavior

- deterministic gate for PDF, accounting questions, explicit mentions and
  replies to a prior Contador message;
- ordinary group chatter is ignored without invoking Opus;
- PDF bytes are read from the local media directory and forwarded to the Next
  intake; its `replyMessage` is sent verbatim;
- natural-language questions use the read-only tool loop and Claude Opus in a
  persistent OpenClaw session;
- daily heartbeat queries upcoming bills, open drafts and current-month
  pendencies; it is silent if all three are empty and has a once-per-day ledger;
- failed model/API work is visible in `contador_jobs` with attempts and a
  redacted error, and transient failures use bounded backoff.

## Known contract gaps

Two items in the original v1 plan cannot safely be completed with the currently
merged Next contract:

1. `/api/accounting/energy-bill-intake` accepts only a real PDF whose bytes
   start with `%PDF-`. Images are parked as `blocked / image_intake_not_supported`;
   the agent does not fabricate a PDF or bypass server validation.
2. The query route lists open drafts but exposes no write that maps a human
   answer such as “é do Galois” back to the draft. The Contador can ask/read,
   but cannot complete that draft until a scoped, audited completion endpoint
   exists.

The “day 3 monthly summary enrichment” also has no corresponding monthly job in
this repository. The daily heartbeat is implemented; monthly integration must
be attached to an identified, owned scheduler before activation.

Future accounting context remains tracked here: a brand-scoped read-only API
for complete company expenses (not only energy) is still out of scope.

## Activation and rollback runbook

Activation is a separate production change and requires explicit approval.

1. Deploy the reviewed commit with `CONTADOR_ENABLED=false` and verify both PM2
   services, `/health`, SQLite migrations and gateway connection state.
2. Provision the `contador` OpenClaw agent/workspace and run an offline prompt
   smoke test without sending WhatsApp messages.
3. Verify the exact group JID and that the Next feature flag is enabled for the
   same group/brand. Test the Next query and PDF intake with a non-production
   fixture or approved dry run.
4. Set the local config and enable `CONTADOR_ENABLED=true` in a separate step;
   restart only `support-copilot` and observe `contador_jobs` plus both PM2 logs.
5. Test one question and one approved PDF. Confirm one outbound message per
   inbound id and the resulting dashboard entry.

Rollback: set `CONTADOR_ENABLED=false` and restart `support-copilot`. If the
Next half must also stop, disable `feature_flags/energy_bill_intake`. Do not
delete SQLite jobs or WhatsApp auth state during rollback.
