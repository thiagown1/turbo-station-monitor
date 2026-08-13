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

## Database

SQLite with WAL mode. Core tables: `brands`, `conversations`, `messages`,
`suggestions`, `audit_log`; feature tables are added by idempotent startup
migrations, including the Contador outbox and daily-run ledger.

Schema and migrations run automatically on startup.
