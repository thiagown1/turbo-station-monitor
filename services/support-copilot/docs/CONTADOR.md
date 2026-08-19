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
   Contador model or Next call. Central media classification is first persisted
   in `agent_media_jobs`, before the webhook is acknowledged, and is recovered
   after a PM2 restart. The successful
   `agent_media_analyses` row and its deferred `contador_jobs` row commit in the
   same SQLite transaction; a cached classification can also recover a missing
   job without another paid model call. Configuration fetch failures and model
   failures remain retryable; they do not create an extraction-less Contador
   job. Media work stops after five failed attempts. Explicitly skipped work
   completes only after the Contador or suggestion fallback has run. Successful
   `station_support`, `support_attention` and `other` group work uses the source
   message as the unique identity for its richer support suggestion across
   recovery. One-to-one fallback enrichment stores a
   checkpoint in the same transaction as the message update, while successful
   media analysis appends its summary idempotently before completion. The worker
   recovers jobs interrupted by a PM2 restart. If the process stops after the
   inbound message commit but before that durable media job is created, the
   provider's duplicate webhook replays the idempotent routing step for both
   groups and one-to-one conversations instead of discarding the attachment or
   a quoted Contador draft correction as an already-seen message. A one-to-one
   legacy fallback that returns no
   description stays retryable rather than completing silently.
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

## Where the Contador may speak (group scoping)

The agent is scoped to the configured accounting group on every axis, and the
inbound gate is duplicated so a single missed check cannot open it:

- **Inbound**: `classifyInbound` drops anything whose `groupJid` is not exactly
  `CONTADOR_GROUP_CONVERSATION_ID` (`lib/contador.js`), and
  `canRouteContadorEvent` repeats the check before a job is queued
  (`lib/contador-runtime.js`). A DM or another group never reaches the model.
  Inside the group, ordinary chatter is still ignored unless it is a PDF/image,
  an accounting keyword, or a reply to the Contador.
- **Outbound**: the daily heartbeat and the monthly closing pass
  `config.groupConversationId` explicitly; job replies carry the `groupJid` that
  already passed the inbound gate.
- **Expense decisions (`EXP-` quoted replies)**: this path is reachable from any
  chat that quotes a bot message carrying the code, so it checks
  `accountingGroupConversationIds` FIRST and returns `{ silent: true }` outside
  them — the ingest route then sends nothing at all. Inside an accounting
  conversation a non-allowlisted sender still gets the refusal, because the
  operator needs to know why their decision did nothing.
- **Writes are revalidated in Next**, independently of this box:
  `/api/agents/expense-decisions` enforces conversation allowlist (403), sender
  allowlist (403) and decision-code match (409); `/api/accounting/energy-bill-intake`
  rejects a `groupConversationId` that differs from the configured one (403) and
  re-checks it against the stored draft on every step.

Note the read-only tool surface `/api/accounting/energy-agent/query` has **no**
group check by design — its gates are the scoped bearer secret plus the
`energy_bill_intake` kill switch, both fail-closed. That secret is therefore the
asset to rotate if this box is ever suspect.

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
| `CONTADOR_REGULARIZACAO_DIAS` | no | intervalo mínimo entre cobranças de regularização, em dias (default `3`) |

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
- an image/PDF in the accounting group is durably queued and classified exactly
  once by the
  central media router. For an energy photo, the configured vision provider
  receives the image and returns a minimal typed extraction; the raw image is
  not forwarded to Next. kWh and amount bounds match the ledger contract, and
  literal zero consumption/tariffs remain valid while implausible fields fail
  closed at both boundaries;
- when the central router skips a one-to-one image/document, the same durable
  job runs the legacy media description before it can complete; restart or
  fallback failure therefore retries instead of silently losing the attachment;
- a quoted reply such as “é do Galois” must consult `estacoes` and can submit one
  exact `draftId + stationId` only when that station id appeared in the trusted
  tool result and the quoted outbound message carries the
  same draft prompt metadata. Quoting another Contador heartbeat, summary or
  draft cannot authorize the write. This quoted-draft path bypasses generic
  station triage, while Next still revalidates the stable sender allowlist.
  Confirmed UC mappings are persisted and
  numeric corrections must be labeled by side/type (for example,
  `distribuidora: 812 kWh; solar: 650 kWh`); matching a number elsewhere in the
  message is insufficient. Brazilian dotted kWh is normalized once as a
  thousands value (`6.173 kWh` means `6173`, never both),
  replaying the reply does not duplicate the original entry. If OCR did not
  produce a stable UC, the operator may provide it literally in the quoted
  reply before registration. Literal UC/numeric/date values are extracted by
  deterministic, field-labeled code; generic digit sequences are excluded from
  the model prompt so redacted CPF/CNPJ/phone identifiers cannot be reconstructed.
  Every model-proposed field must match the quoted text before it can reach Next.
  If the Contador needs one more clarification, its
  next prompt keeps the same draft metadata so the following quoted answer can
  complete only that draft;
- quoted `EXP-...` expense decisions contain configuration/API failures inside
  the decision flow and answer with a safe retry instruction; a temporary
  config outage does not escape the webhook after the inbound message commit;
- natural-language questions use the read-only tool loop and Claude Opus in a
  persistent OpenClaw session;
- daily heartbeat queries upcoming bills, open drafts and current-month
  pendencies; it is silent if all three are empty and has a once-per-day ledger;
- once the day-3 heartbeat schedule has passed, a separate once-per-month
  ledger closes the previous month. On activation it seeds the current run
  month as pending even before the first schedule. After a deploy or outage it walks every
  missing monthly key in chronological order, so crossing a month boundary
  cannot silently skip an older closing,
  using `resumo_contabil`, `resumo_energia`, `pendencias` and
  `drafts_abertos`, enriched with `contas_a_vencer`; it replaces that day's
  ordinary heartbeat so the group receives at most one proactive summary and
  stays silent without trusted data;
- a failed monthly closing persists its next attempt and retries after 1h, 4h,
  12h and 24h before exhausting the bounded five-attempt budget; the 15-minute
  scheduler therefore cannot consume every attempt during a short outage;
- immediately before the external WhatsApp request, the monthly ledger moves
  from `processing` to `sending`. If the process stops or the request result is
  ambiguous after that fence, startup records `delivery_unknown`, does not
  automatically resend, and does not overtake it with later months. An HTTP 4xx
  response from Evolution is a definitive rejection before acceptance, so the
  run returns to `failed` and follows the persisted retry backoff. Missing HTTP
  responses and transport interruptions remain `delivery_unknown`; an operator
  must reconcile that run before retrying, which prefers a visible missing
  closing over a duplicate message;
- failed model/API work is visible in `contador_jobs` with attempts and a
  redacted error, and transient failures use bounded backoff. Each job fences
  its WhatsApp reply before delivery and checkpoints the accepted external
  message id. A recovered `sent` reply completes without another send; an
  interruption while `sending` becomes `delivery_unknown` for operator
  reconciliation instead of risking a duplicate accounting confirmation.

## Chasing what is missing, and remembering what it is told

Two routines exist so the accounting does not depend on someone remembering to
ask. Both were added on 2026-08-19, after a reconciliation found that nothing
had been registered since April.

### Regularização — it asks on its own

`processRegularizacao` walks every closed month since `regularizacaoDesde`
(April 2026) and derives, from the read-only tools, what is still missing in
each: a month with no entry at all, and the stations whose bill was never
registered. It then asks in the group.

The cadence is a backoff, not a schedule: it only asks again after
`CONTADOR_REGULARIZACAO_DIAS` (3 by default), and only while a gap is still
there. Because the gaps come from the tools rather than a checklist, **they
close themselves** the moment the entry lands — there is no "mark as resolved"
for anyone to forget. Every ask is recorded in `contador_regularizacao_runs`.

Not everything is derivable, though, and the underivable part is exactly where
the accounting stalls: how much deságio each solar supplier charges, who
invoices a given station's compensated energy, invoices that exist only on
paper. Those live in `contador_perguntas_abertas` and are repeated alongside
the derived gaps until someone answers. When the answer arrives the agent
returns `"responde_perguntas": [id]` and the question is closed.

### Memória — it stops re-asking

Before this, the agent's whole context was the last 30 messages, so anything
the group taught it evaporated. `contador_fatos` is the durable half: the
agent may return `"aprender": ["fato curto"]` alongside any reply, the runtime
persists it, and every prompt afterwards carries what is already known plus an
instruction not to ask again.

Only durable business facts belong there — whose station a given invoice is,
which supplier covers which site, which deságio applies to whom. Never a
month's number, never chatter. A wrong fact is corrected by setting
`status = 'revogado'`.

Both `aprender` and `responde_perguntas` are optional in the reply contract, so
an instruction that carries neither has exactly the shape it always had.

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
