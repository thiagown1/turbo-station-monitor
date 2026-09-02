# Turbo Station Monitor auto-deploy

## Trigger and safety gates

The `github-webhook` PM2 service receives a signed GitHub `push` event for
`thiagown1/turbo-station-monitor` on `refs/heads/main`. It launches the deploy
worker in a detached process so updating or restarting `github-webhook` cannot
interrupt its own deployment.

The worker publishes only when all of these conditions hold:

1. The target is a full 40-character commit SHA.
2. The GitHub Actions `CI` push run for that exact SHA completed successfully.
3. `origin/main` resolves to the same SHA immediately before mutation.
4. The production checkout has no tracked or untracked source drift.
5. When `ocpp-collector` is affected, its managed `.env` already contains a
   non-empty `OCPP_LOGS_TOKEN` or legacy `OCPP_DASHBOARD_TOKEN`. This preflight
   runs before merge, dependency installation, or restart.
6. The live PM2 inventory exactly matches the persisted `dump.pm2` inventory.
   A missing service (partially recreated daemon) or an extra ad-hoc process
   blocks the deploy before merge, installation, restart, or `pm2 save`.
7. Dependency installation succeeds.
8. Every affected PM2 restart succeeds.
9. Health checks for affected HTTP services return 2xx; the non-HTTP collector
   must remain `online` for two consecutive PM2 samples without restarting.

The deployed marker is stored in `db/.monitor-deployed-sha`; the deployment lock
is `db/.monitor-deploy.lock`. Both are runtime state and remain outside Git.
Logs are appended to `logs/monitor-deploy.log`.

The worker waits for CI before taking the deployment lock. If GitHub cancels an
older CI run because a newer `main` commit contains that target, the older
request is recorded as superseded and exits without a failure notification. The
newer worker remains responsible for publishing. A green worker that encounters
a short deployment already applying changes waits for the lock, then fetches and
validates `origin/main` again before making any change. Divergent history and
cancelled CI without a verified superseding `main` commit still fail closed.

## Service selection

Affected services are calculated from `git diff --name-only` between the last
successfully deployed SHA and the requested SHA. The webhook payload's commit
file list is not trusted as the deployment source of truth.

Changes to `ecosystem.config.js`, root dependency manifests, or shared
`services/lib/` code restart every managed monitor service. Service-specific
changes restart only the corresponding PM2 process.

The PM2 inventory is checked again after restart and immediately before
`pm2 save`, closing the window for a concurrent daemon change. A deploy that
does not restart any service does not rewrite `dump.pm2`. Adding or removing a
managed process is an explicit reconciliation operation; auto-deploy never
turns an incomplete or ad-hoc runtime into the reboot topology.

## Failure behavior

The worker fails closed. It does not reset, stash, discard, or overwrite local
changes, and it does not mark a SHA as deployed before installation, restart,
health verification, and `pm2 save` succeed. Failures are logged and sent to the
configured WhatsApp conversation through the authenticated support-copilot API.

No automatic destructive rollback is performed. If a restart or health check
fails, keep the deployed marker on the previous SHA and perform the documented
manual recovery after inspecting logs and the exact release diff.

If the PM2 topology gate fails, compare `pm2 jlist` with
`${PM2_HOME:-/home/openclaw/.pm2}/dump.pm2`. Do not run `pm2 resurrect` or
`pm2 save` as a shortcut: classify every missing/extra process first, especially
WhatsApp, payment, and automation services, then reconcile only the approved
allowlist.

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
- `SUPPORT_API_SECRET` or `MONITOR_API_SECRET`
- `OCPP_LOGS_TOKEN` (or `OCPP_DASHBOARD_TOKEN`) whenever `ocpp-collector` is
  selected for restart; provision it in the managed `.env`, not in source
- `MONITOR_DEPLOY_WHATSAPP_CONV` (falls back to `ALERT_WHATSAPP_CONV`)
- `SUPPORT_API_BASE` (defaults to `http://127.0.0.1:3005`)
- Working authenticated `gh`, `git`, `npm`, and PM2 installations at the paths
  used by the worker (overridable with `GH_BIN`, `GIT_BIN`, `NPM_BIN`, `PM2_BIN`).
