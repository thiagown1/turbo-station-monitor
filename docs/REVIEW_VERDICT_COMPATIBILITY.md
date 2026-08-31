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
blocking. The attested workflow run with the greatest run ID wins, so an old
success cannot approve a newer pending or failed rerun. Publisher identity and
outcome are evaluated separately: an exact failure run is trusted evidence of
rejection, while only matching check/run success is positive approval.

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
The monitor also compares `baseSha...headSha` through GitHub and requires
`behind_by == 0`. A head behind the current base, a failed compare, or unknown
ancestry cannot enter the merge-ready state.

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
4. A pre-existing `needs:coder-fix` is an operational blocker regardless of
   any successful check. The monitor never writes this writer-triggering label;
   its presence blocks merging but does not authorize repair.

Legacy worker checks (`test-review`, `sec-review`, `reuse-review`, and coder
dispatch jobs) are not deterministic CI and are excluded from the CI summary.
Their skipped or cancelled state cannot approve or reject a revision; the
canonical verdict carries that decision.

## Service behaviour

- `github-webhook` does not create review verdict labels or
  `needs:coder-fix`. A `CHANGES_REQUESTED` review is recorded as evidence and
  requires manual exact-tuple repair.
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

## Writer repair boundary

CI and review failures remain visible and blocking. The monitor has no direct
OpenClaw repair writer. Webhook comments and the persistent
`reconcile`/legacy-planner flows keep the Coder-owned `task-state.json` as a
tombstone with empty `queue` and `activeTasks`. Blocked task details are written
separately under the monitor-owned `state/writer-repair-evidence-*.json` files,
outside the Coder workspace. They never auto-dispatch PR repair. Sweep issues
use the neutral `auto:none` label and no `agent:*` label. The sweep records
evidence issues and, when it finds a merge conflict, the exact PR tuple for
manual repair; it does not invoke Coder.
A public comment, bot review, issue label, or stale queue file is therefore not
writer authorization. PR repair uses the target repository's manual exact-tuple
workflow.

There is currently no write-capable repair job in this repository's GitHub
Actions workflow. The existing CI jobs retain read-only permissions and use the
general `monitor` runner label. `openclaw-writer-v1` is reserved as a dedicated
runner label for a future write-capable repair job. No host may receive that
label before the writer environment and controls below pass an operational
audit, and every future writer job must include the label in `runs-on`.

Any future invocation must also require the target repository variable
`OPENCLAW_WRITER_V1_ATTESTED` to have the exact, case-sensitive value `true`.
Missing variables, lookup errors, and every other value block it. This change
does not create or configure that variable; it must remain absent until the
separate activation audit. The variable and runner label attest infrastructure
only and are not per-task authorization.

For any PR-bound writer work, the guard canonicalizes `pr_number`, uses
`openclaw-writer-v1:<owner/repo>:pr:<number>` as the concurrency identity, and
re-reads the open PR immediately before dispatch or queue persistence. The
current head and base must still equal the recorded tuple. A moved head/base,
closed PR, resolved failure, or unknown GitHub response blocks the writer. The
tuple is also placed in the task so the writer can reject stale work; this
prompt-level instruction is defense in depth, not the mutation control itself.

Writer activation is a separate operational change after this code is merged
and deployed. Before assigning the runner label or setting the variable, all of
the following must be proven:

- the writer runs in an isolated, disposable environment, separate from the
  deterministic CI runners and from persistent production workspaces;
- the analysis-only Scout has a separately verified read-only filesystem and
  GitHub credential; a negative test proves that pushes, issue writes, PR
  writes, and merges are denied, and it never receives the writer runner label;
- the write-capable workflow/job selects only a runner carrying the dedicated
  `openclaw-writer-v1` label; no general-purpose monitor runner is eligible;
- each run receives a short-lived credential scoped to the one repository and
  minimum write permissions, with protected-branch rules still enforced;
- an external compare-and-swap control rechecks the exact repository, PR,
  head, and base at every mutation and push, and rejects concurrent or moved
  revisions independently of the model prompt;
- the canonical concurrency key is enforced outside the model, audit logs are
  retained, and removing the repository variable is a tested kill switch;
- a manual repair dispatch remains an explicit human authorization for that
  exact tuple. Attesting the infrastructure is not blanket permission to merge,
  deploy, restart services, or act on a different revision.

At cutover, operators must also inventory and stop any legacy Coder session or
cron, run the state sanitizer, and verify both executable arrays are empty. This
is a separate operational action; this pull request does not stop processes,
restart services, deploy, assign runner labels, or set repository variables.
