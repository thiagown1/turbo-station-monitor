# AI subscription gateway

Private, loopback-only bridge used by the Turbo Station dashboard to reach
subscription-backed OpenClaw agents:

Claude Max subscription (via OpenClaw's `claude-cli` provider):

- `claude-subscription` -> `ai_dashboard_claude` -> `claude-cli/claude-sonnet-4-6`;
- `claude-opus-5` -> `ai_dashboard_claude` -> `claude-cli/claude-opus-5`;
- `claude-sonnet-5` -> `ai_dashboard_claude` -> `claude-cli/claude-sonnet-5`;
- `claude-fable-5` -> `ai_dashboard_claude` -> `claude-cli/claude-fable-5`;
- `claude-opus-4-8` -> `ai_dashboard_claude` -> `claude-cli/claude-opus-4-8`;
- `claude-opus-4-7` -> `ai_dashboard_claude` -> `claude-cli/claude-opus-4-7`;
- `claude-opus-4-6` -> `ai_dashboard_claude` -> `claude-cli/claude-opus-4-6`.

ChatGPT subscription (via the `codex` runtime):

- `codex-5-6-sol` -> `ai_dashboard_codex` -> GPT-5.6 Sol;
- `codex-5-6-terra` -> `ai_dashboard_codex` -> GPT-5.6 Terra;
- `codex-5-6-luna` -> `ai_dashboard_codex` -> GPT-5.6 Luna.

> **Status (2026-08-15).** The Claude path is verified working on the VPS.
> Gateway agent turns with `claude-cli/claude-sonnet-4-6`,
> `claude-cli/claude-opus-4-8`, and `claude-cli/claude-opus-4-6` all return
> `provider: claude-cli` and report real subscription usage — those are exactly
> the three `claude-cli/*` entries currently in `agents.defaults.models`.
>
> `claude-opus-5`, `claude-sonnet-5`, `claude-fable-5` and `claude-opus-4-7`
> are verified working when the box's `claude` CLI is invoked directly
> (`claude -p --model <id>` returns a normal result for each), but they are
> **not allowlisted yet**, so a gateway turn fails with
> `Model override "…" is not allowed for agent "…"`. See "Model allowlist"
> below — that is a config change on the VPS, not a code change here.
> The OpenClaw gateway pass-through for Codex is **not** verified. The direct
> Codex CLI path was verified on 2026-08-25: Codex CLI v0.146.0 was logged in
> with ChatGPT and `codex exec -m gpt-5.6-sol -s read-only --ephemeral --json`
> returned a successful GPT-5.6 Sol turn. Two gateway-specific open items
> remain:
>
> 1. The `ai_dashboard_codex` OpenClaw gateway profile still needs its own
>    end-to-end smoke test; a direct CLI success does not prove gateway routing.
> 2. `gpt-5.6-sol|terra|luna` are real model names in the installed `codex` CLI
>    (v0.146.0), but OpenClaw 2026.7.1-2's `openai/*` catalog tops out at
>    `gpt-5.4`, and there is no `codex-cli/*` provider mirroring `claude-cli/*`.
>    Whether `agentRuntime: { id: "codex" }` passes an uncatalogued 5.6 id
>    straight through to the CLI is untested. If it does not, route these
>    profiles through `codex exec -m <model> -s read-only --json` directly,
>    mirroring the `claude -p` pattern the legacy service already uses.
>
> Prefer the Claude profiles until both are settled.

The browser sends only the curated profile name. The gateway maps that profile
to a fixed OpenClaw agent id and upstream model, authenticates the request with
`OPENCLAW_AGENT_TOKEN`, limits input/output/time, and returns the existing
NDJSON `delta | error | done` contract. Prompts are sent to the local runner on
stdin and are not logged.

## Required environment

```dotenv
OPENCLAW_AGENT_TOKEN=<scoped-random-secret>
OPENCLAW_AGENT_PORT=3105
OPENCLAW_SRC_ROOT=/home/openclaw/openclaw
AI_SUBSCRIPTION_CLAUDE_AGENT_ID=ai_dashboard_claude
AI_SUBSCRIPTION_CODEX_AGENT_ID=ai_dashboard_codex
AI_SUBSCRIPTION_TIMEOUT_MS=110000
```

Keep the nginx route and the dashboard's `OPENCLAW_AGENT_URL` unchanged when
replacing the legacy `/home/openclaw/apps/ai-openclaw-agent` process.

## Sandbox prerequisite

Do not activate either profile until the default OpenClaw sandbox image exists.
This VPS uses a source checkout, so build it from the OpenClaw repository root:

```bash
cd /home/openclaw/openclaw
scripts/sandbox-setup.sh
docker image inspect openclaw-sandbox:bookworm-slim >/dev/null
```

OpenClaw deliberately fails fast when that image is missing. Keep the default
Docker restrictions (`network: "none"`, read-only root, and all capabilities
dropped); these code/document agents do not need outbound network access.

## Required OpenClaw agents

Merge these entries into `~/.openclaw/openclaw.json`; do not replace the full
agent list. The model/runtime pins and read-only policy are part of the security
boundary.

```json5
{
  plugins: {
    entries: { codex: { enabled: true } },
  },
  agents: {
    list: [
      {
        id: "ai_dashboard_claude",
        name: "Dashboard Claude Read Only",
        workspace: "/home/openclaw/.openclaw/workspace/turbo_station",
        model: { primary: "claude-cli/claude-sonnet-4-6" },
        // Pins each model to the claude-cli runtime so it bills the Max
        // subscription; an anthropic/* slug would hit the metered API.
        // NOTE: this per-agent map does NOT act as the allowlist — see
        // "Model allowlist" below.
        models: {
          "claude-cli/claude-sonnet-4-6": { agentRuntime: { id: "claude-cli" } },
          "claude-cli/claude-opus-5": { agentRuntime: { id: "claude-cli" } },
          "claude-cli/claude-sonnet-5": { agentRuntime: { id: "claude-cli" } },
          "claude-cli/claude-fable-5": { agentRuntime: { id: "claude-cli" } },
          "claude-cli/claude-opus-4-8": { agentRuntime: { id: "claude-cli" } },
          "claude-cli/claude-opus-4-7": { agentRuntime: { id: "claude-cli" } },
          "claude-cli/claude-opus-4-6": { agentRuntime: { id: "claude-cli" } }
        },
        sandbox: { mode: "all", scope: "session", workspaceAccess: "ro" },
        tools: {
          allow: ["read"],
          deny: [
            "group:runtime", "write", "edit", "apply_patch", "exec", "process",
            "browser", "gateway", "cron", "nodes", "message"
          ]
        }
      },
      {
        id: "ai_dashboard_codex",
        name: "Dashboard Codex Read Only",
        workspace: "/home/openclaw/.openclaw/workspace/turbo_station",
        model: { primary: "openai/gpt-5.6-terra" },
        models: {
          "openai/gpt-5.6-sol": { agentRuntime: { id: "codex" } },
          "openai/gpt-5.6-terra": { agentRuntime: { id: "codex" } },
          "openai/gpt-5.6-luna": { agentRuntime: { id: "codex" } }
        },
        sandbox: { mode: "all", scope: "session", workspaceAccess: "ro" },
        tools: {
          allow: ["read"],
          deny: [
            "group:runtime", "write", "edit", "apply_patch", "exec", "process",
            "browser", "gateway", "cron", "nodes", "message"
          ]
        }
      }
    ]
  }
}
```

Before activation, run `openclaw sandbox explain --agent <id>` for both ids and
verify that the Docker backend is active, workspace access is `ro`, and every
mutation/runtime tool is denied. Then restart the OpenClaw gateway, start a
fresh session, and smoke-test one harmless repository question per profile.

## Model allowlist

The allowlist that decides whether a model override is accepted is the
**global** `agents.defaults.models` map in `~/.openclaw/openclaw.json`, not the
per-agent `models` map. `buildAllowedModelSet`
(`src/agents/model-selection.ts`) builds it from `Object.keys(cfg.agents
.defaults.models)`; an empty map means "allow anything in the bundled catalog",
and a non-empty one means "allow exactly these". Entries there are trusted even
when the bundled catalog does not list the model, which is what lets models
newer than the catalog work at all.

As of 2026-08-15 that map contains only three `claude-cli/*` entries
(`claude-sonnet-4-6`, `claude-opus-4-6`, `claude-opus-4-8`). The four models
below are verified working via the `claude` CLI directly but are rejected by
the gateway until they are added:

```json5
// ~/.openclaw/openclaw.json -> agents.defaults.models — merge, do not replace
{
  "claude-cli/claude-opus-5": {},
  "claude-cli/claude-sonnet-5": {},
  "claude-cli/claude-fable-5": {},
  "claude-cli/claude-opus-4-7": {}
}
```

This is additive: it widens the allowlist and cannot remove an existing entry.
It is still a shared-config edit on a box that runs the CI agents, so make it
deliberately and restart the OpenClaw gateway afterwards. Verify with:

```bash
openclaw agent --agent ai_dashboard_claude --model claude-cli/claude-opus-5 \
  --json -m "Reply with exactly: OK"
```

A successful run reports `"provider": "claude-cli"` in `agentMeta`.

## Tests

```bash
node --test test/test-ai-subscription-gateway.js
```
