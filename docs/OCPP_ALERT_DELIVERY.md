# OCPP alert delivery

`ocpp-alerts` is fail-closed. Deploying code does not authorize or activate
outbound messages. The process starts only when all of these are explicit:

- `OCPP_ALERTS_ENABLED=1`
- `ALERT_WHATSAPP_CONV`
- `SUPPORT_API_URL`
- `SUPPORT_API_SECRET` (or `MONITOR_API_SECRET`)
- optional `ALERT_WHATSAPP_BRAND` (defaults to `turbo_station`)

## Delivery contract

The processor sends through the support API, never through the legacy OpenClaw
WhatsApp CLI. HTTP 2xx means queued, not delivered. An alert leaves
`history/pending_alerts.json` and enters the debounce/rate-limit caches only
after its message has `delivery_status=sent`.

If a queued message stays pending or its status endpoint is unavailable, the
message id stays on the alert and later cycles only check that id. An explicit
`failed` status permits a replacement after the retry backoff. If the POST
outcome is ambiguous and no message id exists, automatic retry stops so it
cannot create an unseen duplicate; an operator must reconcile the conversation
and queue item.

Expired per-event alerts are moved to `history/expired_alerts.jsonl` with a
reason rather than silently discarded. The collector reloads the durable queue
after restart, and both processes serialize queue changes so an ACK cannot erase
a concurrently appended alert.

## Read-only activation preflight

Before requesting activation authorization:

1. Confirm `support-copilot` health and the WhatsApp gateway's connected state.
2. Confirm the configured conversation belongs to the intended alerts group.
3. Inspect pending, ambiguous, and expired queue items; do not bulk-send a stale backlog.
4. Run `node --test test/test-alert-processor-delivery-guard.js` on the exact release SHA.
5. Present the exact target, expected outbound count, rollback, and current disk/PM2 health.

Activation is a separate production change. Roll back immediately by setting
`OCPP_ALERTS_ENABLED=0` and stopping only `ocpp-alerts`; keep the queue files for
reconciliation.
