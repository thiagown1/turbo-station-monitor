# Operational WhatsApp notices

`github-webhook`, `pagarme-status-webhook` and `deploy-health-check` can submit notices to the existing
Support WhatsApp relay instead of using `openclaw message send` for Telegram.
This does not change the webhook acknowledgement or start the Hermes migration.

The path is inert until a separate operator activation. Merging into `main`
triggers the monitor's automatic production deploy after its CI and clean
checkout gates; merge is therefore a release action, even though message
submission remains disabled by default.

- `OPERATIONAL_WHATSAPP_ENABLED=true` enables submission. Missing or invalid
  values leave it disabled.
- `OPERATIONAL_WHATSAPP_CONVERSATION_ID` must identify the verified operational
  alerts group. There is no built-in destination.
- `MONITOR_API_SECRET` (or `SUPPORT_API_SECRET`) authenticates with the local
  support relay. `SUPPORT_COPILOT_URL` defaults to `http://127.0.0.1:3005`.

Before activation, verify the conversation still maps to the intended WhatsApp
group and that the relay is healthy. A successful HTTP response means the relay
accepted a message, **not** that Evolution or WhatsApp delivered it. Confirm
delivery from the support message status. The sender does not retry ambiguous
timeouts, because the message might already have been accepted.

The webhook logs only `skipped_disabled`, `skipped_unconfigured`, `accepted`, or
`failed` with a short reason. There is no fallback to Telegram or OpenClaw.
Operational notices do not inject into an OpenClaw agent session. To stop new
submissions, set `OPERATIONAL_WHATSAPP_ENABLED` to any value other than `true`
and restart only the affected processes after the separate configuration
change is authorized.

The GitHub webhook's legacy `short_trader` MoneyMan hook is now disabled unless
`SHORT_TRADER_OPENCLAW_HOOK_ENABLED=true` is explicitly configured. Leave it
disabled during retirement.

## OpenClaw CLI retirement status

`test/test-no-openclaw-cli.js` fails if a shipped runtime file shells out to
`openclaw` outside a short allowlist. Retired: alert-engine Telegram,
deploy-health-check Telegram, vercel-deploy-hook Telegram and LLM checklist,
the unscheduled `scripts/monitor.js`/`analyze.js`/`hourly-report.js`, and every
support-copilot agent call (see its README, "Suggestion generation"), and the
`ocpp-alerts` process itself (deleted 2026-09-25, see ALERT_ENGINE.md). Still on
the gateway: the Contador primary model,
`ai-openclaw-agent`, `sweep-orchestrator` and `budget-guardian`.

## Group handoff at the gateway

`GATEWAY_IGNORED_GROUP_JIDS` is an optional comma-separated list of group JIDs
whose inbound messages must not be forwarded to support-copilot. The gateway
checks it before downloading media. Sending messages to those groups is
unaffected. During the support-copilot retirement, the gateway falls back to
the existing `SUPPORT_COPILOT_IGNORED_GROUP_JIDS` setting if its own setting is
unset, so removing the support-copilot ingest filter does not reopen the group.
Verify the JID and the new owner before changing either setting in production.
