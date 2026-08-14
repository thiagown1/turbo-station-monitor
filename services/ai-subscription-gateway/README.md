# AI subscription gateway

Private, loopback-only bridge used by the Turbo Station dashboard to reach two
subscription-backed OpenClaw agents:

- `claude-subscription` -> `ai_dashboard_claude` -> Claude Sonnet 4.6;
- `codex-subscription` -> `ai_dashboard_codex` -> GPT-5.4 through the official
  Codex app-server harness.

The browser sends only the curated profile name. The gateway maps that profile
to a fixed OpenClaw agent id, authenticates the request with
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
        model: { primary: "openai/gpt-5.4" },
        models: {
          "openai/gpt-5.4": { agentRuntime: { id: "codex" } }
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
