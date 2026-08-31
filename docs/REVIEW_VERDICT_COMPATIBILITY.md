# Review verdict compatibility

`reconcile.js` and `sweep-orchestrator.js` consume the same fail-closed review
contract while Turbo Station and OCPP migrate away from approval labels.

## Canonical checks

The stable check names are:

- `Test Review Verdict`
- `Security Review Verdict`
- `Merge Gate`

Publishers identify a verdict with:

```text
review-verdict:v1:<owner/repo>:pr:<number>:<kind>:head:<headSha>:base:<baseSha>
```

Only a completed `SUCCESS` approves. Missing, queued, in-progress, neutral,
skipped, cancelled, timed-out, action-required, and failed results all remain
blocking. The newest attested workflow run of a given name wins, so an old
success cannot approve a newer pending or failed rerun.

The monitor reads `headRefOid`, `baseRefOid`, labels, reviews, and
`statusCheckRollup` in one PR snapshot. GitHub scopes `statusCheckRollup` to the
current head but does not expose check identity there. Whenever a canonical
name appears, the monitor therefore fetches `/commits/<head>/check-runs` and
requires all of the following before accepting it:

- `head_sha` equals the current `headRefOid`;
- `external_id` exactly matches the current repository, PR, kind, head, and
  `baseRefOid` contract above;
- `app.slug` is `github-actions`, the only trusted app initially;
- `details_url` names a run in the same repository and that run resolves through
  the Actions REST API;
- the run uses the repository/kind allowlisted workflow path, was dispatched by
  `workflow_dispatch` on the default branch, and has the exact PR/head/base
  display title;
- the check and workflow-run outcomes agree. Approval requires both to be
  completed successfully.

Missing REST metadata, an unknown app, an old base, or an old head blocks the
gate. Expanding the app allowlist requires an explicit code and test change.

## Read precedence

1. A non-successful `Merge Gate` blocks conservatively. Its success is redundant
   evidence and cannot authorize a merge by itself.
2. Each canonical test/security verdict is authoritative when it exists. As
   soon as either review verdict appears, the canonical path is
   fail-closed and no missing/failed sibling can fall back to a label.
3. Only when both canonical review verdict names are absent may the monitor temporarily
   use both legacy approval labels. Each label also requires an `APPROVED`
   native review from the expected agent, carrying `[test-review]` or
   `[sec-review]` at the beginning of its body and attached to the exact current
   head SHA.
4. `needs:coder-fix` is an operational blocker regardless of any successful
   check. It remains the queue signal for the coder during migration.

Legacy worker checks (`test-review`, `sec-review`, `reuse-review`, and coder
dispatch jobs) are not deterministic CI and are excluded from the CI summary.
Their skipped or cancelled state cannot approve or reject a revision; the
canonical verdict carries that decision.

## Service behaviour

- `github-webhook` no longer creates `reviewed:tests` or
  `reviewed:security`. It only adds `needs:coder-fix` for a marked,
  exact-current-head `CHANGES_REQUESTED` review.
- `reconcile` treats a red/pending `Merge Gate` as a blocker, then requires
  deterministic CI plus canonical verdicts or the evidence-backed legacy
  fallback for both `turbo_station` and `ocpp_server`.
  PR queue identities and CI-attempt state include the repository name, so the
  same PR number in the two repositories cannot collide.
- `sweep-orchestrator` uses the same helper, treats deterministic CI as green
  only when every included check explicitly succeeds, and re-reads the current
  PR revision immediately before a staging merge.
- A CI-green PR without an approved review verdict is never merged. A rebase
  invalidates the inspected revision and returns the PR to the review loop.

## Removing the fallback

After both repositories publish the canonical checks for all open PRs and the
monitor has observed the dual-read path in production, remove the legacy
approval labels and native-review fallback together. Deployment or PM2 restart
of this monitor is a separate operational action from merging this code.
