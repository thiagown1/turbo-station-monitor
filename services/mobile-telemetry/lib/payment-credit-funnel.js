const DEFAULT_PAYMENT_CREDIT_GRACE_MS = 2 * 60 * 1000;
const MAX_PAYMENT_CREDIT_GRACE_MS = 24 * 60 * 60 * 1000;

const FINANCIAL_ENDPOINT = /^\/api\/(?:payments(?:\/|$)|webhooks\/pagarme(?:\/|$)|internal\/pix(?:\/|$)|internal\/cron\/reconcile-payment-credits(?:\/|$)|admin\/.*credit)/i;

const REFERENCE_PATTERNS = [
  /\b(?:chargeId|paymentRef|providerChargeId)\s*(?:[=:]|\s)\s*["']?([A-Za-z0-9._-]+)/gi,
  /["'](?:transactionId|chargeId|paymentRef|providerChargeId)["']\s*:\s*["']([A-Za-z0-9._-]+)["']/gi,
];

function parsePaymentCreditGraceMs(raw) {
  if (raw === undefined || raw === null || raw === '') {
    return DEFAULT_PAYMENT_CREDIT_GRACE_MS;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > MAX_PAYMENT_CREDIT_GRACE_MS) {
    throw new RangeError(
      `payment_credit_grace_ms must be between 0 and ${MAX_PAYMENT_CREDIT_GRACE_MS}`,
    );
  }
  return Math.floor(value);
}

function rowText(row) {
  return `${row.body || ''}\n${row.meta || ''}`;
}

function extractReferences(text) {
  const refs = new Set();
  for (const pattern of REFERENCE_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const ref = match[1];
      if (!ref || /^(?:null|undefined|unknown|n\/a)$/i.test(ref)) continue;
      refs.add(ref);
    }
  }
  return refs;
}

function isProviderPaid(text) {
  if (/PROCESSING PAYMENT\s*-\s*charge\.paid event/i.test(text)) return true;
  if (/API Response \(credit settlement\): Payment paid/i.test(text)) return true;
  if (/API Response: Payment completed/i.test(text)) return true;
  if (/\[AUTO-ADD-CREDITS\] charge captured but crediting failed/i.test(text)) return true;
  return /\[PIX_POLL\].*(?:PROVIDER RESPONSE|Reusing confirmed provider status).*providerStatus=(?:paid|captured|completed)\b/i.test(text);
}

function isCreditSuccess(text) {
  return /(?:^|\s)✅?\s*CREDITS ADDED\s*-/iu.test(text);
}

function isSettlementEvidence(text) {
  return isCreditSuccess(text)
    || /PAYMENT PROCESSING COMPLETE.*creditsAdded=true/i.test(text)
    || /PAYMENT PROCESSING COMPLETE.*creditBlocked=false.*manuallyReconciled=true/i.test(text)
    || /API Response: Payment completed.*status:\s*completed/i.test(text)
    || /RACE CONDITION HANDLED.*Credits already added/i.test(text)
    || /POLL STOPPED\s*-\s*Payment already completed/i.test(text)
    || /credit already applied \(idempotent replay\).*treating as success/i.test(text);
}

function isCreditClaimRegistryUnavailable(text) {
  return /\bCreditClaimRegistryUnavailableError\b/.test(text)
    || /\[CREDIT-CLAIM\]\s+(?:claim read failed|historical claim lookup failed|failed to record claim alert)\b/i.test(text);
}

function isIntrinsicCreditClaimRegistryFailure(text) {
  return /\[CREDIT-CLAIM\]\s+(?:claim read failed|historical claim lookup failed|failed to record claim alert)\b/i.test(text);
}

function groupKey(row) {
  return row.request_id || row.event_id || `row:${row.id}`;
}

function addEvent(map, keys, timestamp) {
  for (const key of keys) {
    const current = map.get(key);
    if (current === undefined || timestamp < current) map.set(key, timestamp);
  }
}

/**
 * Aggregate provider-paid and wallet-credit evidence from Vercel application
 * logs. Identifiers are used only for in-memory correlation and never leave
 * this function; the returned object contains numbers only.
 */
function aggregatePaymentCreditFunnel(db, { startMs, endMs, graceMs }) {
  const rows = db.prepare(`
    SELECT id, timestamp, event_id, endpoint, request_id, body, meta
    FROM vercel_logs
    WHERE timestamp >= @start AND timestamp < @end
      AND (
        body LIKE '%chargeId=%'
        OR body LIKE '%paymentRef=%'
        OR body LIKE '%transactionId%'
        OR body LIKE '%Payment completed%'
        OR body LIKE '%Payment already completed%'
        OR body LIKE '%Payment paid%'
        OR body LIKE '%CreditClaim%'
        OR body LIKE '%CREDIT-CLAIM%'
        OR body LIKE '%CREDITS ADDED%'
        OR body LIKE '%credit already applied%'
        OR meta LIKE '%chargeId=%'
        OR meta LIKE '%paymentRef=%'
        OR meta LIKE '%transactionId%'
        OR meta LIKE '%Payment completed%'
        OR meta LIKE '%Payment already completed%'
        OR meta LIKE '%Payment paid%'
        OR meta LIKE '%CreditClaim%'
        OR meta LIKE '%CREDIT-CLAIM%'
        OR meta LIKE '%CREDITS ADDED%'
        OR meta LIKE '%credit already applied%'
      )
    ORDER BY timestamp ASC, id ASC
  `).all({ start: startMs, end: endMs });

  const groups = new Map();
  for (const row of rows) {
    const key = groupKey(row);
    let group = groups.get(key);
    if (!group) {
      group = { rows: [], refs: new Set(), endpoints: new Set() };
      groups.set(key, group);
    }
    const text = rowText(row);
    group.rows.push({ ...row, text });
    for (const ref of extractReferences(text)) group.refs.add(ref);
    if (row.endpoint) group.endpoints.add(row.endpoint);
  }

  const paid = new Map();
  const creditSuccess = new Map();
  const settled = new Set();
  const registryFailures = new Set();

  for (const [requestKey, group] of groups) {
    const fallbackKeys = group.refs.size > 0 ? group.refs : new Set([`request:${requestKey}`]);
    const financialRequest = [...group.endpoints].some((endpoint) => FINANCIAL_ENDPOINT.test(endpoint));

    for (const row of group.rows) {
      const ownRefs = extractReferences(row.text);
      const keys = ownRefs.size > 0 ? ownRefs : fallbackKeys;

      if (isProviderPaid(row.text)) addEvent(paid, keys, row.timestamp);
      if (isSettlementEvidence(row.text)) {
        addEvent(creditSuccess, keys, row.timestamp);
        for (const key of keys) settled.add(key);
      }
      if (
        isIntrinsicCreditClaimRegistryFailure(row.text)
        || (financialRequest && isCreditClaimRegistryUnavailable(row.text))
      ) {
        registryFailures.add(requestKey);
      }
    }
  }

  // A successful correlated provider credit is itself durable evidence that
  // the provider-paid boundary was crossed, including Auto Add paths whose
  // gateway result is not emitted as a dedicated log line.
  for (const [key, timestamp] of creditSuccess) addEvent(paid, new Set([key]), timestamp);

  const cutoff = endMs - graceMs;
  const paidAfterGrace = [...paid.entries()]
    .filter(([, timestamp]) => timestamp <= cutoff)
    .map(([key]) => key);

  return {
    providerPaidAfterGrace: paidAfterGrace.length,
    creditsSucceeded: creditSuccess.size,
    paidWithoutCreditAfterGrace: paidAfterGrace.filter((key) => !settled.has(key)).length,
    creditClaimRegistryUnavailable: registryFailures.size,
  };
}

module.exports = {
  DEFAULT_PAYMENT_CREDIT_GRACE_MS,
  MAX_PAYMENT_CREDIT_GRACE_MS,
  aggregatePaymentCreditFunnel,
  extractReferences,
  parsePaymentCreditGraceMs,
};
