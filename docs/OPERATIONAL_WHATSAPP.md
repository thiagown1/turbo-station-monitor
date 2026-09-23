# Operational WhatsApp notices

`github-webhook` and `pagarme-status-webhook` can submit notices to the existing
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
and restart only the two webhook processes after the separate configuration
change is authorized.

The GitHub webhook's legacy `short_trader` MoneyMan hook is now disabled unless
`SHORT_TRADER_OPENCLAW_HOOK_ENABLED=true` is explicitly configured. Leave it
disabled during retirement. Support-copilot still has other agent paths; audit
and remove those separately before disabling the gateway.
