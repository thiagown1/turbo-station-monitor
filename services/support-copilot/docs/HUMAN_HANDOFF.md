# Human handoff

The AI hands a conversation to a person on clear triggers. After the handoff, the AI stays silent until a person gives the conversation back.

Code: `lib/human-handoff.js`. Tests: `__tests__/human-handoff.test.js` and the "Human handoff" cases in the gate, investigator and partner runtime suites.

## Status of this feature

- **Decision, ownership and silence: implemented and tested.**
- **Team notice, customer notice, phone call: not wired.** `requestHandoff` takes them as injected functions. Nothing calls `requestHandoff` in production code yet. No message is sent and no call is placed.
- **No on-call calling service exists in the sources checked.** The `onCall` argument is a port (`resolve()` and `place()`), not a provider. Wiring it needs a decision by operations. See "Open decisions".

## Ownership

Ownership reuses columns the `conversations` table already has.

| status | Owner | AI may answer |
|---|---|---|
| `open` | AI | yes |
| `assigned` | a person, set by `POST /conversations/:id/takeover` | no |
| `escalated` | the team, set by `POST /conversations/:id/escalate` or by `requestHandoff` | no |
| `closed` | nobody | no |

`assigned` and `escalated` are *human-owned*. The constant is `HUMAN_OWNED_STATUSES` in `lib/auto-respond-gate.js`.

The AI checks ownership at these points:

1. `evaluateAutoRespond` returns `human_owned` before any other check.
2. 1:1 suggestions and group suggestions are not generated.
3. The station investigator does not claim, analyse or send. It re-checks right before sending, because a person may take over while the analysis runs.
4. The partner assistant does not create a job. It re-checks before asking Hermes and again before sending or proposing a review.

Jobs skipped this way end as `failed` with `last_error = 'human_owned'`. `countRecentFailures` ignores them, so they never count as AI failures.

## Triggers

`evaluateHandoff` is pure. It returns `escalate`, `priority` (`urgent` or `normal`), `primary` and all `reasons`.

| Reason | Fires when |
|---|---|
| `urgent` | fire, smoke, shock, spark, explosion, stuck cable, accident, injury (accent-insensitive) |
| `explicit_human_request` | the person asks for an attendant, a human, a call back |
| `risk_topic` | money or refund, legal or regulator, anger, or tags `lgpd`, `hack-tentativa`, `reclamacao`, `furioso`, `financeiro` |
| `out_of_scope` | the caller sets `signals.outOfScope` (action requests stay with a person) |
| `repeated_failures` | `signals.failureCount` reaches the threshold (default 3, `policy.failureThreshold`) |
| `low_confidence` | `signals.stationIdentified === false`, `signals.confidence === 'low'`, or a blocked reason of `station_not_identified`, `low_context_confidence`, `context_failed` |

Precedence for `primary`: urgent, explicit request, risk, out of scope, repeated failures, low confidence.

Only `urgent` gets `priority: 'urgent'`. It is the only case that asks the on-call port for a call.

## What the person receives

`buildHandoffPacket` gives: conversation id, brand, channel, customer name, **masked** phone, priority, reasons, last message (500 characters), the AI draft that was not sent, up to 10 evidence lines and the failure count. `renderInternalNotice` turns it into one team message. The raw phone number never appears in the notice, the audit metadata or the call summary.

## What the customer receives

One message, once per handoff:

> Passei sua mensagem para a nossa equipe. Uma pessoa vai continuar a conversa por aqui.

For `urgent` it adds a public safety line (Bombeiros, 193). The message gives no deadline and names no channel. A test enforces this. The copilot prompt no longer promises a call back.

## Idempotency and failure

- `requestHandoff` claims the conversation in one transaction. A conversation that is already human-owned is a no-op: no second notice, no second audit row.
- A failed team notice keeps ownership. The AI stays silent. The failure is audited (`support.handoff_notify_failed`) and the result has `needsAttention: true`.
- With no notify function wired, the result is the same with `support.handoff_notify_skipped`.
- A failed customer notice never breaks the handoff.
- A call that fails, times out (10 s) or finds nobody available is audited as `support.handoff_call` with the status. It is never retried in a loop. The team notice is the fallback.

Audit actions: `support.handoff`, `support.handoff_notify_skipped`, `support.handoff_notify_failed`, `support.handoff_customer_notice_failed`, `support.handoff_call`, `support.handoff_resolved`.

## Resume

Only a person resumes the AI.

- `resolveHandoff` sets `status = 'open'` and clears `assigned_agent_id`, `escalated_at` and `escalated_to`.
- `POST /conversations/:id/release` now clears the same fields.
- A new problem after the resolution can escalate again.

## Open decisions (operations)

1. **Notify target.** Which internal conversation receives the team notice? Candidates already in use: the "Notificações Turbo Station" group and the "Turbo Station + URGENTE" group.
2. **On-call calling.** No provider, roster or endpoint was found in the repo, Vercel env names, the OpenClaw VPS or the Hermes skills. The OpenClaw `voice-call` skill is a disabled default. Say which service this is, or decide that urgent cases only notify the group.
3. **Who may mark a handoff resolved**, and whether the dashboard gets a button for `resolveHandoff`.
4. **Thresholds**: failure count, and the urgent keyword list.
5. **Customer notice copy and the 193 line.**
6. **Rollout.** Shadow first (decide and record, send nothing), then the internal status group, then partner groups. Each step needs an explicit approval.
