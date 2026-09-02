# Vercel database maintenance

`cleanup-vercel-db` is a one-shot PM2 process that retains 14 days of raw
`vercel_logs` and `vercel_requests`. Before pruning, it stores daily aggregates
for expired `vercel_logs`. Deletes remain chunked and the live path uses a
passive WAL checkpoint; it never runs `VACUUM`.

## Schedule and initial-start guard

The canonical PM2 entry remains scheduled with:

```text
cron_restart: 0 3 * * *
autorestart: false
```

PM2 may launch a one-shot process immediately when an ecosystem is first
registered, independently of its later cron restarts. To make that initial
start inert, the script permits an unforced run only during the half-open UTC
window `[03:00:00, 03:15:00)`. Fifteen minutes accommodates ordinary PM2 and
host scheduling delay without turning most of the day into an implicit
maintenance window.

PM2 evaluates `cron_restart` in the daemon host's timezone. The documented
03:00 UTC schedule therefore requires the PM2 host timezone to remain UTC and
must be verified during rollout. If it drifts, the UTC script guard skips the
job rather than pruning at an unintended time.

An out-of-window invocation logs `outside-start-window`, exits successfully,
and does not stat or open `db/vercel.db`. The next PM2 `cron_restart` at 03:00
UTC continues to run normally.

## Zero-write preview

During the scheduled window:

```bash
node scripts/cleanup-vercel.js --dry-run
```

Outside the scheduled window, an operator must make the override explicit:

```bash
node scripts/cleanup-vercel.js --dry-run --force
```

`--dry-run` is deliberately **plan-only**: it reports the target path,
deterministic cutoff, retention, and steps without opening SQLite at all. A
nominally read-only SQLite connection to a WAL database can still create or
update `-wal`/`-shm`
sidecars, so even a read-only count would violate the zero-write guarantee. The
dry-run does not issue SELECT or PRAGMA, create the aggregate table or index,
insert, delete, checkpoint, vacuum, or touch a sidecar. `--force` changes only
the time gate; combining it with `--dry-run` remains no-open and zero-write.

Candidate row counts are intentionally not part of this command. If exact
counts are required, obtain them from a separately controlled read-only
snapshot or diagnostic workflow; do not weaken this script's zero-write path.

## Manual mutation

An out-of-window live run requires:

```bash
node scripts/cleanup-vercel.js --force
```

This is a production database write. Do not run it merely to register or
recover PM2. Before separately authorizing it, confirm the exact checkout and
database path, current disk headroom, a usable backup, and the state of the
`vercel-drain` writer. Capture the cutoff and planned steps with
`--dry-run --force` first; obtain counts only through the separate snapshot or
diagnostic boundary described above.

`--force` does not alter the 14-day cutoff, chunk size, aggregation, or
no-`VACUUM` policy. Unknown command-line arguments fail closed.

## Verification and rollback

The safety regression suite uses disposable SQLite databases only:

```bash
node --test test/test-vercel-cleanup-safety.js
node --test test/test-vercel-cleanup-locking.js
```

It verifies the exact time-window boundaries, skip-before-open behavior,
that the SQLite factory is never called by dry-run, unchanged WAL sidecars and
database bytes/mtime/schema/rows, and the normal scheduled cleanup path.

Rollback is a code rollback followed by the repository's separately approved
deployment flow. Do not restart, re-register, save, or resurrect the shared PM2
daemon as part of rollback without validating the full global process topology.
