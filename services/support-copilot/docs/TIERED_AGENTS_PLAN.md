# Tiered Support Agents — Implementation Plan

> Target environment: **staging** (`https://staging.turbostation.com.br`, Firebase project `turbostation-dev`).
> Owner: dividedbyzerox@gmail.com. Drafted 2026-06-02.

## Goal

Replace the single operator-assist support agent with **four access tiers**, each acting with
exactly the backend permissions of a real account. The AI never gets ambient privilege —
it borrows a Firebase identity and the staging Next.js API enforces every gate.

| Tier | OpenClaw agent | Model | Acts as | Capability |
|---|---|---|---|---|
| Public | `support_public` | OpenRouter `google/gemini-2.5-flash` | nobody (no API calls) | knowledge base only |
| Verified user | `support_verified` | OpenRouter `openai/gpt-5-mini` | the linked end-user's account | own data: OCPP logs, own stations |
| Partner (groups) | `partner_agent` | OpenRouter `openai/gpt-5.1` | the linked partner's user account | create stations/coupons/condos, insights — partner-scoped by server |
| Super-admin | `super_admin` | **Claude** (`anthropic` OAuth Opus), fallback OpenRouter `anthropic/claude-opus-4.6` | a `super_admin` account | everything |

## Identity model (decided)

In the **dashboard support page**, on a user-chat or a WhatsApp group, an operator **links the
number/group to a turbo_station user account**. From then on the agent assumes that account's
identity. Mechanism:

1. Action layer holds the staging Admin SDK (`firebase-dev-sa.json`, project `turbostation-dev`).
2. For a linked `userId`, mint a **custom token** → exchange for an **ID token** via Firebase Auth
   REST (`signInWithCustomToken`, needs the `turbostation-dev` Web API key).
3. Call `https://staging.turbostation.com.br/api/...` with
   `Authorization: Bearer <idToken>` + `x-brand-id: <brand>`.
4. The Next.js API enforces brand + role + partner-ownership scoping server-side. The agent
   cannot escalate beyond the linked account.

Tier is **derived from the linked account's roles** (`Users/{uid}.roles` + partner resolution via
`partners.userId`), not chosen by the agent:
- no link → `support_public`
- linked plain user → `support_verified`
- linked user that resolves to a partner → `partner_agent`
- linked user with `super_admin` role → `super_admin`

## Backend endpoints used (staging, all existing)

- `POST /api/stations`, `PUT /api/stations/[id]/ownership`
- `POST /api/coupons`
- `POST /api/condominiums`
- `GET  /api/partners/me/overview` (insights)
- Auth: `next/app/api/utils/auth.ts` (Permission enum), scoping in `utils/tenant.ts`, `utils/roles.ts`,
  partner resolution in `lib/services/resolve-partner-by-user.ts`.

## Work breakdown

### Phase A — OpenRouter wiring  ✅ DONE
`openclaw.json`: `models.providers.openrouter` (4 models) + `auth.profiles.openrouter:default`.
Verified with a live completion. (Gateway reload still required for agents to see it.)

### Phase B — Tiered agents + workspaces (this repo, reversible)
- Add `support_public`, `support_verified`, `partner_agent`, `super_admin` to `openclaw.json → agents.list`
  with per-tier `tools.deny` + `fs.workspaceOnly` + models per table above.
- Scaffold `workspace-<tier>/` with SOUL/IDENTITY/TOOLS/policies/knowledge.
- `super_admin` primary = `claude-cli/claude-opus-4-6` (Anthropic OAuth), fallback OpenRouter.

### Phase C — Account-link mapping (support-copilot, this repo)
- DB: add `account_links` (whatsapp_number/group_jid → userId, brandId, linked_by, linked_at).
- `routes/settings.js`: CRUD for links (consumed by the dashboard support page).
- `lib/copilot.js`: resolve tier from the linked account before choosing the agent.

### Phase D — Action layer (support-copilot, this repo) — WRITE-CAPABLE, security-sensitive
- `lib/turbo-api-client.js`: Admin SDK custom-token → ID-token exchange (cached per uid/TTL) →
  authenticated calls to staging API with `x-brand-id`.
- Expose a **small typed tool surface** to agents (MCP or HTTP):
  `create_station`, `create_coupon`, `create_condominium`, `get_partner_overview`, `get_ocpp_logs`.
- Per-tier allowlist of which tools each agent may call (defence in depth on top of server gates).

### Phase E — Dashboard support page (turbo_station staging) — `next/`
- UI on the support/chat page to link a chat/group to a user account (calls the support-copilot
  settings endpoint, or a thin `next/` proxy).
- Show the resolved tier + the account it's acting as.

## Open items
- Need the `turbostation-dev` **Web API key** for the custom-token→ID-token exchange (public client key; in `next/` Firebase config).
- Confirm `x-brand-id` value(s) per tenant (turboStation / zev / plugreen).
- Audit: every agent write already lands in staging `audit_logs` as the linked user — good. Add a
  copilot-side log tagging which agent/conversation initiated it.

## Safety properties
- AI holds **no standing privilege**; identity is per-linked-account, minted on demand.
- All writes pass through the role-gated Next.js API — no direct Firestore writes.
- Tier is derived from server-side roles, not agent-selectable.
- Staging-only until validated (`turbostation-dev`, `staging.turbostation.com.br`).
