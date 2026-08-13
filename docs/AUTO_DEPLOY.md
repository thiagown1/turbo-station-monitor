# Turbo Station Monitor auto-deploy

## Trigger and safety gates

The `github-webhook` PM2 service receives a signed GitHub `push` event for
`thiagown1/turbo-station-monitor` on `refs/heads/main`. It launches the deploy
worker in a detached process so updating or restarting `github-webhook` cannot
interrupt its own deployment.

The worker publishes only when all of these conditions hold:

1. The target is a full 40-character commit SHA.
2. The GitHub Actions `CI` push run for that exact SHA completed successfully.
3. `origin/main` resolves to the same SHA.
4. The production checkout has no tracked or untracked source drift.
5. Dependency installation succeeds.
6. Every affected PM2 restart succeeds.
7. Health checks for affected HTTP services return 2xx.

The deployed marker is stored in `db/.monitor-deployed-sha`; the deployment lock
is `db/.monitor-deploy.lock`. Both are runtime state and remain outside Git.
Logs are appended to `logs/monitor-deploy.log`.

## Service selection

Affected services are calculated from `git diff --name-only` between the last
successfully deployed SHA and the requested SHA. The webhook payload's commit
file list is not trusted as the deployment source of truth.

Changes to `ecosystem.config.js`, root dependency manifests, or shared
`services/lib/` code restart every managed monitor service. Service-specific
changes restart only the corresponding PM2 process.

## Failure behavior

The worker fails closed. It does not reset, stash, discard, or overwrite local
changes, and it does not mark a SHA as deployed before installation, restart,
health verification, and `pm2 save` succeed. Failures are logged and sent to the
configured Telegram target through the absolute OpenClaw CLI path.

No automatic destructive rollback is performed. If a restart or health check
fails, keep the deployed marker on the previous SHA and perform the documented
manual recovery after inspecting logs and the exact release diff.

## Recovering a dirty production checkout

Do not run `git reset --hard` before classifying the drift.

1. Record the current `HEAD`, `origin/main`, `git status --short`, and PM2 health.
2. Back up the complete local diff and untracked operational files outside the
   repository.
3. Move legitimate hotfixes into reviewed commits and pass CI.
4. Verify databases, logs, `.env`, WhatsApp auth state, and runtime state are
   ignored or stored outside tracked source paths.
5. With explicit production authorization, restore a clean checkout at the
   approved SHA, install dependencies, restart only approved services, verify
   health/logs, then write the deployed marker.

## Required environment

- `GITHUB_WEBHOOK_SECRET`
- `OPENCLAW_CLI` (defaults to `/home/openclaw/.npm-global/bin/openclaw`)
- `MONITOR_DEPLOY_TELEGRAM_TARGET`
- Working authenticated `gh`, `git`, `npm`, and PM2 installations at the paths
  used by the worker (overridable with `GH_BIN`, `GIT_BIN`, `NPM_BIN`, `PM2_BIN`).
