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
5. Dependency installation succeeds.
6. Every affected PM2 restart succeeds.
7. Health checks for affected HTTP services return 2xx.

The deployed marker is stored in `db/.monitor-deployed-sha`; the deployment lock
is `db/.monitor-deploy.lock`. Successfully applied dependency/install and
per-service restart revisions are stored in
`db/.monitor-deploy-progress.json`. These are runtime state and remain outside
Git. Logs are appended to `logs/monitor-deploy.log`.

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

Changes to `ecosystem.config.js`, the root lockfile or runtime dependency fields,
or shared `services/lib/` code restart every managed monitor service.
Script-only edits to the root `package.json` do not fan out to every service.
Service-specific changes restart only the corresponding PM2 process.

## Dependency installation

`npm ci` runs only when the release diff touches `package-lock.json`, changes a
runtime-affecting `package.json` field (root or `services/support-copilot/`), or
when the matching `node_modules/` is absent. Script-only and code-only releases
install nothing.

This is a safety gate, not an optimisation. `npm ci` deletes `node_modules`
before reinstalling, and on the monitor box, with the CI runners loaded, the
support-copilot install (native `better-sqlite3`) measured about five minutes.
Running it unconditionally on every deploy put that window in front of every
release: on 2026-09-03 it exceeded the former 180-second ceiling and killed the
deploy of PR #78 *after* the fast-forward had landed, leaving the new code on
disk and the old process still serving, with the alert showing only npm's
`prebuild-install` deprecation warning as the apparent cause.

When an install does run, the ceiling is 900 seconds and a timeout is reported
as `npm ci (<scope>) timed out after <n>s`, so the notification names the real
failure instead of the last line npm happened to print.

The global marker advances only after health verification, while the progress
file advances after each successful install and service restart. A retry still
health-checks every service affected by the pending global diff, but does not
repeat an already applied install or restart. Per-service revisions also stop a
later release from replaying old work merely because the global marker remained
behind after a health failure.

## Failure behavior

The worker fails closed. It does not reset, stash, discard, or overwrite local
changes, and it does not mark a SHA as deployed before installation, restart,
health verification, and `pm2 save` succeed. Failures are logged and sent to the
configured WhatsApp conversation through the authenticated support-copilot API.

No automatic destructive rollback is performed. If a restart or health check
fails, the deployed marker stays on the previous SHA while successful steps are
recorded in the progress file. Inspect logs and the exact release diff before
manual recovery; do not delete the progress file merely to force a replay.

## Mobile telemetry retention migration

The retention worker refuses to delete rows from an existing database until an
index beginning with `mobile_events.raw_id` exists. This is intentional: with
SQLite foreign keys enabled, deleting each `mobile_raw` parent otherwise scans
the complete child table and can starve `/health` for minutes.

Deploy the worker/index guard first. It is safe for the service to report
`X-Retention-State: blocked-index`; ingestion and liveness remain available and
no TTL rows are deleted. The database change is a separate production action:

```bash
node scripts/migrate-mobile-raw-id-index.js
node scripts/migrate-mobile-raw-id-index.js --apply
```

The first command is read-only. Run `--apply` only in an explicitly authorized
maintenance window after checking free disk space, database backup/restore
readiness, and current write load. The script takes an exclusive migration lock,
creates `idx_mobile_events_raw_id`, and verifies the foreign-key delete plan.
Afterward, restart only `mobile-telemetry`, verify `/health`, confirm
`X-Retention-State` advances to `ok` after a sweep, inspect logs, and reconcile
`.monitor-deployed-sha` only after the exact deployed revision is healthy.

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
- `MONITOR_DEPLOY_WHATSAPP_CONV` (falls back to `ALERT_WHATSAPP_CONV`)
- `SUPPORT_API_BASE` (defaults to `http://127.0.0.1:3005`)
- Working authenticated `gh`, `git`, `npm`, and PM2 installations at the paths
  used by the worker (overridable with `GH_BIN`, `GIT_BIN`, `NPM_BIN`, `PM2_BIN`).
