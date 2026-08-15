# AI subscription gateway

Private, loopback-only bridge used by the Turbo Station dashboard to reach
subscription-backed OpenClaw agents:

Claude Max subscription (via OpenClaw's `claude-cli` provider):

- `claude-subscription` -> `ai_dashboard_claude` -> `claude-cli/claude-sonnet-4-6`;
- `claude-sonnet-5` -> `ai_dashboard_claude` -> `claude-cli/claude-sonnet-5`;
- `claude-opus-4-8` -> `ai_dashboard_claude` -> `claude-cli/claude-opus-4-8`;
- `claude-opus-4-7` -> `ai_dashboard_claude` -> `claude-cli/claude-opus-4-7`;
- `claude-opus-4-6` -> `ai_dashboard_claude` -> `claude-cli/claude-opus-4-6`.

ChatGPT subscription (via the `codex` runtime):

- `codex-5-6-sol` -> `ai_dashboard_codex` -> GPT-5.6 Sol;
- `codex-5-6-terra` -> `ai_dashboard_codex` -> GPT-5.6 Terra;
- `codex-5-6-luna` -> `ai_dashboard_codex` -> GPT-5.6 Luna.

> **Status (2026-08-15).** The Claude path is verified working on the VPS: a
> gateway agent turn with `claude-cli/claude-sonnet-4-6` returns
> `provider: claude-cli` and reports real subscription usage. The Codex path is
> **not** verified. Two open items block it:
>
> 1. The ChatGPT plan hit its usage limit on 2026-08-15 and does not reset
>    until 2026-08-20, so it cannot be smoke-tested before then.
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
        // Every model the dashboard picker can select must be pinned to the
        // claude-cli runtime, or the override falls back to the metered
        // anthropic/* API instead of the Max subscription.
        models: {
          "claude-cli/claude-sonnet-4-6": { agentRuntime: { id: "claude-cli" } },
          "claude-cli/claude-sonnet-5": { agentRuntime: { id: "claude-cli" } },
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

## Tests

```bash
node --test test/test-ai-subscription-gateway.js
```
