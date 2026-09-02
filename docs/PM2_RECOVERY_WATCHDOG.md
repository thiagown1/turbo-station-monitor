# PM2 recovery watchdog

This repository ships an **opt-in** systemd timer for conservative recovery of
the OpenClaw PM2 daemon. Nothing installs or enables it automatically.

## Safety model

The reconciler shares `db/.monitor-deploy.lock` with auto-deploy, so a deploy
and daemon recovery cannot mutate PM2 concurrently. On every run it:

1. reads a root-owned approval manifest and `dump.pm2`;
2. requires the exact approved process set, all 11 long-lived monitor services,
   and an exact absolute executable path for every entry;
3. confirms each path exists (and is executable for native entries);
4. reads `/proc/net/unix` before any PM2 CLI call, avoiding the `jlist` behavior
   that can spawn a fresh empty daemon;
5. does nothing when the approved topology is healthy;
6. restarts only `pm2-openclaw.service` when the daemon is absent or a live,
   otherwise healthy daemon is missing approved registrations; and
7. verifies the socket and full topology after that single restart.

The persisted dump is re-read and revalidated immediately before the systemd
restart. An unapproved/changed dump, unexpected live process, path mismatch,
present-but-stopped/errored required process, errored scheduled registration,
or three unstable restarts fails
with a non-zero systemd result and a structured journal line. Those cases need
targeted diagnosis; the watchdog never enters a whole-daemon restart loop.
Successful recovery is rate-limited to once per 15 minutes. The timestamp is
written before post-recovery verification, so a bad resurrection cannot cause a
restart storm. Neither dump contents nor environment values are logged.

## Curate the manifest first

`ops/pm2-recovery/pm2-recovery.example.json` is a schema/example for the monitor
repo, **not** a production-ready global inventory. The OpenClaw daemon also owns
platform, deploy-watcher, Stalker, and scheduled entries. Before enabling the
timer, classify every current and saved entry, remove development/experimental
entries that have no approved ownership, then create
`/etc/turbo-station-monitor/pm2-recovery.json` with the complete approved set.

Every process has one mode:

- `online`: long-lived and required to be `online`;
- `registered`: must remain present, but `stopped` between cron runs is valid.

The manifest must be owned by root and mode `0600`. Never copy environment
fields out of `dump.pm2`; only names, modes, and executable paths belong here.
The example intentionally exposes any current path mismatch (including a
different `ai-openclaw-agent` launcher) for an operator to resolve, not silently
bless.

## Install and validate (not run automatically)

Use an exact reviewed commit from a clean checkout. These commands require a
separate production/install authorization:

```bash
sudo install -d -o root -g root -m 0755 /usr/local/lib/turbo-station-monitor
sudo install -o root -g root -m 0644 services/lib/pm2-topology.js \
  /usr/local/lib/turbo-station-monitor/pm2-topology.js
sudo install -o root -g root -m 0644 services/lib/pm2-reconciler.js \
  /usr/local/lib/turbo-station-monitor/pm2-reconciler.js
sudo install -d -o root -g root -m 0700 /etc/turbo-station-monitor
sudo install -o root -g root -m 0600 /path/to/curated-pm2-recovery.json \
  /etc/turbo-station-monitor/pm2-recovery.json
sudo install -o root -g root -m 0644 ops/systemd/turbo-pm2-reconcile.service \
  /etc/systemd/system/turbo-pm2-reconcile.service
sudo install -o root -g root -m 0644 ops/systemd/turbo-pm2-reconcile.timer \
  /etc/systemd/system/turbo-pm2-reconcile.timer
sudo systemctl daemon-reload
```

Validate without mutation first:

```bash
sudo env PM2_RECONCILE_CHECK_ONLY=1 \
  /usr/bin/node /usr/local/lib/turbo-station-monitor/pm2-reconciler.js
sudo systemctl start turbo-pm2-reconcile.service
sudo systemctl status turbo-pm2-reconcile.service --no-pager
sudo journalctl -u turbo-pm2-reconcile.service -n 100 --no-pager
```

The second command is live reconciliation, so run it only after the check-only
result and exact manifest have been reviewed. Then, with explicit authorization:

```bash
sudo systemctl enable --now turbo-pm2-reconcile.timer
systemctl list-timers turbo-pm2-reconcile.timer
```

## Rollback

Disabling the timer does not stop or restart PM2:

```bash
sudo systemctl disable --now turbo-pm2-reconcile.timer
sudo rm /etc/systemd/system/turbo-pm2-reconcile.timer
sudo rm /etc/systemd/system/turbo-pm2-reconcile.service
sudo systemctl daemon-reload
```

After retaining any journal evidence needed for diagnosis, the root-owned
library/config/state files may be removed separately. Do not delete
`/home/openclaw/.pm2/dump.pm2` or use rollback as permission to run
`pm2 resurrect`, `pm2 save`, or restart unrelated services.
