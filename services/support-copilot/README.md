# Support Copilot Service

Standalone Express + SQLite service for AI-powered WhatsApp support.

## Architecture

```
logs.turbostation.com.br/api/support/ → nginx → :3005 → Express → SQLite
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
| POST | `/api/support/ingest/evolution` | **Inbound from Evolution API webhook** |

## Evolution API Integration

### Flow

```
Customer WhatsApp
       │
       ▼
Evolution API (Docker, port 8080)
       │ webhook POST (messages.upsert)
       ▼
POST /api/support/ingest/evolution
       │ transforms payload → upserts conversation + message
       ▼
SQLite (conversations + messages)
       │
       ▼
Dashboard (polling)
       │ operator sends reply
       ▼
POST /api/support/conversations/:id/messages
       │ saves to DB + calls Evolution API sendText
       ▼
Evolution API → Customer WhatsApp
```

### Environment Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `EVOLUTION_API_URL` | Base URL of Evolution API | `http://localhost:8080` |
| `EVOLUTION_API_KEY` | Global API key | `your-api-key` |
| `EVOLUTION_WEBHOOK_SECRET` | Optional: verify inbound webhooks | `webhook-secret` |
| `EVOLUTION_INSTANCE_MAP` | Map instance→brand | `turbostation:turbo,zev:zev` |

### Evolution API Webhook Setup

Configure Evolution API to send `messages.upsert` events to:

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
pm2 start index.js --name support-copilot --env PORT=3005
pm2 save
pm2 logs support-copilot
```

## Database

SQLite with WAL mode. Tables: `brands`, `conversations`, `messages`, `suggestions`, `audit_log`.

Schema auto-created on first connection. No migrations needed.
