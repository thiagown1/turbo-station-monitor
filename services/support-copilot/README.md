# Support Copilot Service

Standalone Express + SQLite service for AI-powered WhatsApp support. The
production WhatsApp connection is owned by the sibling `whatsapp-gateway`
service, which uses Baileys directly and exposes an Evolution-compatible local
HTTP contract. There is no external Evolution API process in this deployment.

## Architecture

```
WhatsApp → whatsapp-gateway/Baileys (:3006) → webhook → support-copilot (:3005) → SQLite
                                                      └→ dashboard/API via nginx
```

- **Port**: 3005 (PM2 managed)
- **DB**: `services/../db/support-copilot.sqlite` (dev) or `/var/lib/turbo-station/support-copilot.sqlite` (prod)
- **Auth**: `X-Api-Secret` header (env `SUPPORT_API_SECRET`)
- **Agent routing**: each inbound image/PDF is classified at most once and
  delivered to the dashboard through a durable SQLite outbox. Financial and
  outbound actions begin behind human review.

## Routes

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Liveness probe |
| GET | `/api/support/conversations?brand_id=X` | List conversations |
| GET | `/api/support/conversations/:id` | Conversation detail |
| GET | `/api/support/conversations/:id/messages` | Messages list |
| GET | `/api/support/conversations/:id/suggestions` | Suggestions list |
| GET | `/api/support/conversations/:id/context` | Full context (conv + msgs + sug + audit) |
| POST | `/api/support/conversations/:id/messages` | Send operator message (→ WhatsApp via Evolution API) |
| POST | `/api/support/conversations/:id/takeover` | Assign to operator |
| POST | `/api/support/conversations/:id/release` | Unassign |
| POST | `/api/support/conversations/:id/close` | Close conversation |
| PATCH | `/api/support/conversations/:id/priority` | Update priority |
| POST | `/api/support/conversations/:id/suggestions` | Create AI suggestion |
| PATCH | `/api/support/conversations/:id/suggestions/:sid` | Accept/reject suggestion |
| POST | `/api/support/ingest/whatsapp` | Inbound WhatsApp message (generic) |
| POST | `/api/support/ingest/evolution` | Inbound Evolution-compatible webhook from the local Baileys gateway |

## WhatsApp / Baileys integration

### Flow

```
WhatsApp
       │
       ▼
whatsapp-gateway (PM2, port 3006, Baileys session on local disk)
       │ webhook POST (messages.upsert)
       ▼
POST /api/support/ingest/evolution
       │ transforms payload → upserts conversation + message
       ▼
SQLite (conversations + messages)
       │
       ▼
Dashboard (SSE + API)
       │ operator sends reply
       ▼
POST /api/support/conversations/:id/messages or Contador outbox
       │ saves to DB + calls Evolution API sendText
       ▼
local Evolution-compatible API (:3006) → Baileys → WhatsApp
```

The route and client retain `evolution` names for compatibility with the
payload/endpoints already used by the dashboard. They do not identify the
underlying WhatsApp library.

### Environment Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `EVOLUTION_API_URL` | Local Baileys gateway compatibility URL | `http://localhost:3006` |
| `EVOLUTION_API_KEY` | Shared local gateway API key | secret |
| `EVOLUTION_WEBHOOK_SECRET` | Verifies gateway → copilot webhooks | secret |
| `EVOLUTION_INSTANCE_MAP` | Map instance→brand | `turbostation:turbo_station` |
| `SUPPORT_COPILOT_MEDIA_DIR` | Shared inbound-media directory | repository `db/media` by default |
| `AGENT_EVENT_BASE_URL` | Dashboard base URL that receives agent events | `https://app.example.com` |
| `AGENT_EVENT_SECRET` | Dedicated shared secret for config/events | random secret |
| `OPENROUTER_API_KEY` | Vision/classification provider | provider key |
| `AGENT_VISION_MODEL` | Cheap vision-capable model | `openai/gpt-4o-mini` |

### Gateway webhook setup

`ecosystem.config.js` configures `whatsapp-gateway` to send
`messages.upsert` events to:

```
POST https://logs.turbostation.com.br/api/support/ingest/evolution
```

Headers (if `EVOLUTION_WEBHOOK_SECRET` is set):
```
x-webhook-secret: <your-secret>
```

### WhatsApp Ingest (generic)

```bash
curl -X POST https://logs.turbostation.com.br/api/support/ingest/whatsapp \
  -H "Content-Type: application/json" \
  -d '{
    "brand_id": "turbo",
    "phone": "5521999991234",
    "customer_name": "João",
    "body": "Não consigo carregar",
    "external_message_id": "wa_abc123"
  }'
```

- Auto-creates conversation on first message from a phone number
- Deduplicates by `external_message_id`
- Normalizes phone (strips non-digits)

## PM2

```bash
pm2 start ecosystem.config.js --only whatsapp-gateway,support-copilot
pm2 save
pm2 logs whatsapp-gateway support-copilot
```

The gateway owns the WhatsApp socket, QR/auth state and media download. The
copilot owns webhook authentication, conversation/message persistence,
operator sends and agent routing. See [docs/CONTADOR.md](docs/CONTADOR.md) for
the accounting-agent boundaries and activation runbook.

### Memory budget

`max_memory_restart` is **256M**. Steady state measured on the live process is
86–102 MB RSS (heap 14–26 MB); the rest is headroom for transients — media
base64, `openclaw agent` stdout buffers (5 MB each, several can overlap during
an alert burst), and session-tail reads.

The previous 150M cap sat only ~50 MB above steady state and was being tripped
by a single transient, recycling the service and dropping in-flight work (160
restarts, bursts as tight as 11 min — issue #48). Raising the cap was the last
step, not the fix; see below.

### Agent session files

Each conversation has an append-only transcript at
`$OPENCLAW_HOME/agents/<agentId>/sessions/<sessionId>.jsonl`. These grow
without bound while a conversation stays active — the "Notificações Turbo
Station" alert feed reached 39 MB / 17k lines.

Two rules keep that from taking the service down again:

1. **Never read a session file whole.** Use `lib/session-file.js`
   (`countSessionLines`, `readSessionTail`, `rewriteSessionTailWithout`), all of
   which are bounded regardless of session size. `readFileSync(p,'utf8')
   .split('\n')` on that 39 MB file peaked at 208 MB RSS — past the old cap on
   its own. `__tests__/session-file.test.js` guards this with a peak-RSS
   assertion plus a CONTROL case running the old approach.
2. **Sessions get re-compacted.** Compaction used to be once-per-lifetime, so
   an always-active conversation grew unbounded after its single pass. It now
   runs again whenever the file exceeds `SESSION_RECOMPACT_BYTES` (8 MiB).
   This matters beyond memory: past roughly 30 MB the OpenClaw agent fails to
   load the session at all (`Failed to inject into session ...`), so an
   overgrown transcript silently stops receiving alerts — and is then too big
   to compact.

3. **Compaction goes through `openclaw sessions compact`, never
   `--message /compact`.** OpenClaw 2026.7.1-2 rejects slash commands on the
   `--message` path (`Slash commands cannot be executed via --message from the
   CLI`). See below.

Tunable via `SUPPORT_SESSION_TAIL_MAX_BYTES` (default 2 MiB) and
`SUPPORT_SESSION_RECOMPACT_BYTES` (default 8 MiB).

### How compaction is invoked (and how it broke silently)

`lib/session-compact.js` shells out to:

```
openclaw sessions compact "agent:<agentId>:explicit:<sessionId>" \
  --agent <agentId> --json --timeout <ms> [--max-lines <n>]
```

Three things are load-bearing:

- **The key must be `:explicit:`.** `agent:<id>:main` also resolves but points
  at whichever session was last made "main" — compacting that truncates an
  unrelated conversation.
- **`--json` output is authoritative, not the exit code.** A gateway timeout
  comes back as `{"ok": false, "error": "gateway timeout after 10000ms"}`
  without a non-zero exit, so a success check on the exit code alone reports a
  phantom success.
- **Oversized sessions use `--max-lines`.** LLM summarization has to load the
  whole transcript, which is exactly what an overgrown session cannot do — the
  39 MB one could not be summarized even with a 4-minute deadline. Truncation
  is the only path that still works past that point, so a session over
  `SESSION_RECOMPACT_BYTES` skips straight to it.

The previous code sent `/compact` as an agent message. That worked until
OpenClaw 2026.7.1-2 landed: last success 2026-08-14 23:12:22, gateway restarted
onto the new version at 23:58:07, first rejection 2026-08-15 00:20:27. Every
compaction failed for the next four days (102 rejections, zero successes) and
**nobody noticed**, because the failure was caught as "non-critical" and
`compacted_at` was stamped anyway — the DB recorded 212 compactions that never
happened, and the stamp then suppressed every retry.

`compacted_at` is now only written when compaction actually succeeded; a failed
attempt leaves the session eligible for the next auto-close. If sessions start
growing again, check for `⚠️ Session compaction failed` in
`logs/support-copilot-error.log` — that line is now the honest signal.

Tunable via `SUPPORT_COMPACT_MAX_LINES` (default 300) and
`SUPPORT_COMPACT_TIMEOUT_MS` (default 180000).

## Database

SQLite with WAL mode. Core tables: `brands`, `conversations`, `messages`,
`suggestions`, `audit_log`; feature tables are added by idempotent startup
migrations, including the Contador outbox and daily-run ledger.

Schema and migrations run automatically on startup.
