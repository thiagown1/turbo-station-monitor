# Auto-rollback watchdog: policy, gates, and gradual rollout

Status of this change: **local implementation only**. It does not change the
running watchdog, production flags, Vercel, WhatsApp, or any deployment.

## What the current message means

The watchdog runs outside the Next.js deployment and reads the Vercel drain's
SQLite log feed for ten minutes after it detects a production SHA change. Its
notification previously said `ARMED` before resolving the kill switch or token.
That notification proved only that the observation window had started; it did
not prove that rollback was enabled or possible.

The revised message says `observing`, reports the rollout phase, and states
whether direct rollback is disabled. Detector, recommender, approval, and
actuator are separate states in both the audit log and user-facing text.

## Deterministic route classification

| Class | Examples | Sensitive signal | Allowed outcome |
| --- | --- | --- | --- |
| Deterministic internal canary | `/api/version`, `/api/health` | 3 5xx-only observations spanning at least 30 seconds, with at least 2 clean observations of the same route before cutover | Shadow report; personal proposal; only after a separate phase-3 activation, potentially direct rollback when every gate below passes |
| Critical financial | `/api/payments/*`, `/api/payment*`, `/api/pagarme*`, `/api/credits*` | 2 failures and at least 50% 5xx | Alert/investigate; never direct rollback |
| Critical charging | `/api/recharge/*`, `/api/events/charger/*`, `/api/ocpp/*` | 2 failures and at least 50% 5xx | Alert/investigate; never direct rollback because OCPP/charger attribution is ambiguous |
| External dependency | webhooks, NFS-e/fiscal endpoints | 2 failures and at least 50% 5xx | Alert/investigate; never direct rollback |
| Routine aggregate | all other routes | at least 10 5xx out of 20 requests, ratio at least 50%, across at least 3 endpoints | Shadow report or proposal with human confirmation; never direct rollback |

The two direct-candidate routes are intentionally dependency-free in the Turbo
Station application: they return process/deployment metadata and do not query
Firestore, Pagar.me, NFS-e, OCPP, or another service.

## Required evidence and gates

A signal is attributed to a release only when:

1. the previous and new SHAs are known and distinct;
2. the current production SHA exactly matches the new candidate;
3. the signal is inside the ten-minute post-cutover window, and the detector
   clamps its query start to the cutover timestamp so older rows cannot count;
4. the five-minute pre-cutover baseline is not already elevated;
5. for the catastrophic canary class, the same route had at least two clean
   pre-cutover observations.

Before any proposal or action, the previous candidate must be `READY`, match the
captured previous SHA, and return HTTP 200 from its own `/api/version` URL with
that same SHA. A 401, 403, redirect, malformed response, mismatch, timeout, or
network error blocks the rollback. Post-rollback health is not accepted as the
first proof that the target was safe.

Direct eligibility additionally requires an exact, fresh release-safety
attestation for the new and previous SHAs proving all of the following:

- candidate confirmation;
- no external-dependency attribution or financial ambiguity;
- no migration;
- no runtime flag change;
- no irreversible activation;
- default-OFF kill switch explicitly allowing the action;
- durable dedupe, no prior attempt for this release, and cooldown elapsed;
- `ROLLBACK_ROLLOUT_PHASE=catastrophic-auto` and the separate
  `ROLLBACK_DIRECT_ENABLE=1` activation boundary.

Missing or inconclusive evidence fails closed to proposal or alert/investigate.

## Human approval contract

In `approval-required`, a rollback proposal is created for one exact
`releaseSha -> targetSha` pair. It expires in at most five minutes and contains
a random proposal ID and nonce. Confirmation is valid only when a trusted,
non-LLM WhatsApp ingress records all of these facts:

- explicit `CONFIRM_ROLLBACK` action;
- matching proposal ID, nonce, release SHA, and target SHA;
- personal conversation ID and sender JID on the operator allowlist;
- sender and remote JID exactly matching the configured approver JID, with the
  personal suffix `@s.whatsapp.net` (broadcast, newsletter, malformed, other
  personal, and group `@g.us` destinations are rejected);
- receipt after proposal creation and before expiration;
- proposal still pending and unused.

The watchdog consumes and persists the approval before calling the actuator.
Replays are rejected. The agent/LLM may summarize evidence and recommend an
outcome, but it cannot write the trusted receipt, change a rollout phase, access
the rollback token, or invoke the Vercel rollback endpoint.

The trusted inbound adapter that records the confirmation is intentionally not
activated by this change. Until that adapter and its atomic persistence are
separately reviewed and deployed, `approval-required` can propose but cannot
receive a valid confirmation.

## Loop and false-positive protections

- Safe default and unknown configuration: `shadow`.
- Shadow recommendations remain observable even when action-only candidate or
  reversibility evidence is absent; those readiness gaps are reported as
  blockers and can never authorize an action.
- Hard-stop file overrides every other setting.
- One rollback attempt per production release SHA.
- The attempt is durably consumed before the Vercel call; a crash or ambiguous
  response becomes `issuance-unknown` and is never retried automatically.
- Thirty-minute cooldown between actions.
- One shadow report/proposal per release, plus deduped blocked alerts. A blocked
  alert is deduped only after confirmed relay delivery; transport failures retry.
- Exact previous SHA; never select an arbitrary recent deployment.
- Strict pre-action target smoke; inaccessible is not healthy.
- External, payment, fiscal, and charging ambiguity never enters the direct path.
- No direct action from aggregate traffic thresholds.
- Approval expires, is release-bound, personal-only, and single-use.
- Decision log records classification, evidence, blockers, candidate result,
  recommendation, authorization kind, and action result without request bodies.

## Rollout sequence and activation boundaries

1. **Recommendation and local implementation**: review this policy, its tests,
   and historical replays. No production effect.
2. **PR**: merge only after code review and CI. A merged PR still does not change
   the VPS watchdog.
3. **Deploy inert code**: deploy with `ROLLBACK_ROLLOUT_PHASE=shadow` and
   `ROLLBACK_DIRECT_ENABLE=0`; verify status output and decision logs. This is a
   separate, explicit authorization.
4. **Shadow observation**: run through multiple releases and at least one
   controlled simulation. Compare each decision with human review; record false
   positives, missed incidents, time-to-detect, candidate-smoke availability,
   and alert delivery. Owner: release/operations on call.
5. **Proposal-required pilot**: after the personal destination, allowlist,
   trusted inbound adapter, atomic one-time consumption, and delivery
   confirmation are reviewed, authorize `approval-required` separately. Direct
   rollback remains disabled. Owner: platform plus the allowlisted release
   approver.
6. **Phase-3 decision**: only after sufficient shadow/pilot evidence, approve or
   reject `catastrophic-auto` for the two deterministic canaries. This needs a
   new policy decision and explicit activation of both phase and direct-enable;
   it is not part of this PR.

## Simulation matrix before any activation

- historical universal application crash: should recommend rollback;
- isolated Firestore missing-index failure in a financial path: should alert and
  investigate, never direct rollback;
- Pagar.me/NFS-e outage with healthy canaries: should alert, never rollback;
- OCPP start/stop failure with healthy app canaries: should alert, never rollback;
- pre-cutover elevated 5xx: should reject deploy attribution;
- three canary failures inside one burst shorter than 30 seconds: should not
  classify as catastrophic;
- candidate smoke 401/403/timeout/SHA mismatch: should block;
- missing or stale safety attestation: should block;
- duplicate tick, repeated confirmation, second attempt for the same release,
  and cooldown: should block;
- group sender, non-allowlisted sender, wrong release, wrong nonce, and expired
  confirmation: should block;
- hard stop introduced between recommendation and action: should abort.

## Decisions still required

Before phase 2, choose and review the trusted WhatsApp confirmation adapter and
its durable atomic store, provide the exact personal conversation/JID allowlist,
and define delivery confirmation behavior. Before phase 3, define the minimum
number of observed releases and acceptable false-positive rate, select the
release pipeline component that creates the signed/controlled safety
attestation, and name the person responsible for the separate activation.
