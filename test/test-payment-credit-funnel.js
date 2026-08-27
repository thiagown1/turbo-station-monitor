const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const {
  DEFAULT_PAYMENT_CREDIT_GRACE_MS,
  aggregatePaymentCreditFunnel,
  parsePaymentCreditGraceMs,
} = require('../services/mobile-telemetry/lib/payment-credit-funnel');
const { readFunnelCounts } = require('../services/mobile-telemetry/routes/funnel-counts');

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE vercel_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      event_id TEXT,
      endpoint TEXT,
      request_id TEXT,
      body TEXT,
      meta TEXT
    )
  `);
  db.exec(`
    CREATE TABLE vercel_requests (
      request_id TEXT PRIMARY KEY,
      last_ts INTEGER,
      endpoint TEXT,
      method TEXT,
      status_code INTEGER
    )
  `);
  return db;
}

function insert(db, {
  timestamp,
  requestId,
  endpoint,
  body,
  eventId = null,
  meta = null,
}) {
  db.prepare(`
    INSERT INTO vercel_logs (
      timestamp, event_id, endpoint, request_id, body, meta
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(timestamp, eventId, endpoint, requestId, body, meta);
}

test('parses a bounded payment credit grace window', () => {
  assert.equal(parsePaymentCreditGraceMs(undefined), DEFAULT_PAYMENT_CREDIT_GRACE_MS);
  assert.equal(parsePaymentCreditGraceMs('0'), 0);
  assert.equal(parsePaymentCreditGraceMs('120000'), 120000);
  assert.throws(() => parsePaymentCreditGraceMs('-1'), /payment_credit_grace_ms/);
  assert.throws(() => parsePaymentCreditGraceMs('not-a-number'), /payment_credit_grace_ms/);
  assert.throws(() => parsePaymentCreditGraceMs(String(24 * 60 * 60 * 1000 + 1)), /payment_credit_grace_ms/);
});

test('correlates a successful checkout without returning payment identifiers', () => {
  const db = makeDb();
  insert(db, {
    timestamp: 1_000,
    requestId: 'req-checkout',
    endpoint: '/api/payments/process',
    body: '[PAGARME-RESPONSE] Payment processed: {"status":"paid","transactionId":"ch_checkout"}',
  });
  insert(db, {
    timestamp: 1_100,
    requestId: 'req-checkout',
    endpoint: '/api/payments/process',
    body: '✅ CREDITS ADDED - userId=secret-user, finalBalance=42, paymentRef=ch_checkout',
  });
  insert(db, {
    timestamp: 1_200,
    requestId: 'req-checkout',
    endpoint: '/api/payments/process',
    body: 'API Response: Payment completed for user secret-user, status: completed',
  });

  const result = aggregatePaymentCreditFunnel(db, {
    startMs: 0,
    endMs: 10_000,
    graceMs: 2_000,
  });

  assert.deepEqual(result, {
    providerPaidAfterGrace: 1,
    creditsSucceeded: 1,
    paidWithoutCreditAfterGrace: 0,
    creditClaimRegistryUnavailable: 0,
  });
  assert.equal(JSON.stringify(result).includes('secret-user'), false);
  assert.equal(JSON.stringify(result).includes('ch_checkout'), false);
});

test('counts an overdue paid webhook without credit and excludes a payment still in grace', () => {
  const db = makeDb();
  insert(db, {
    timestamp: 1_000,
    requestId: 'req-old-paid',
    endpoint: '/api/webhooks/pagarme',
    body: '💰 PROCESSING PAYMENT - charge.paid event for chargeId=ch_old',
  });
  insert(db, {
    timestamp: 9_500,
    requestId: 'req-new-paid',
    endpoint: '/api/webhooks/pagarme',
    body: '💰 PROCESSING PAYMENT - charge.paid event for chargeId=ch_new',
  });

  const result = aggregatePaymentCreditFunnel(db, {
    startMs: 0,
    endMs: 10_000,
    graceMs: 2_000,
  });

  assert.equal(result.providerPaidAfterGrace, 1);
  assert.equal(result.paidWithoutCreditAfterGrace, 1);
  assert.equal(result.creditsSucceeded, 0);
});

test('deduplicates provider retries by charge and clears overdue when a later path settled it', () => {
  const db = makeDb();
  insert(db, {
    timestamp: 1_000,
    requestId: 'req-webhook-1',
    endpoint: '/api/webhooks/pagarme',
    body: '💰 PROCESSING PAYMENT - charge.paid event for chargeId=ch_retry',
  });
  insert(db, {
    timestamp: 2_000,
    requestId: 'req-webhook-2',
    endpoint: '/api/webhooks/pagarme',
    body: '💰 PROCESSING PAYMENT - charge.paid event for chargeId=ch_retry',
  });
  insert(db, {
    timestamp: 4_000,
    requestId: 'req-poll',
    endpoint: '/api/internal/pix/poll',
    body: '✅ CREDITS ADDED - chargeId=ch_retry, amount=1000',
  });
  // The shared credit service emits another success line in the same request.
  insert(db, {
    timestamp: 4_001,
    requestId: 'req-poll',
    endpoint: '/api/internal/pix/poll',
    body: '✅ CREDITS ADDED - userId=secret, finalBalance=10, paymentRef=ch_retry',
  });

  const result = aggregatePaymentCreditFunnel(db, {
    startMs: 0,
    endMs: 10_000,
    graceMs: 2_000,
  });

  assert.equal(result.providerPaidAfterGrace, 1);
  assert.equal(result.creditsSucceeded, 1);
  assert.equal(result.paidWithoutCreditAfterGrace, 0);
});

test('recognizes paid PIX polling and counts already-settled evidence once', () => {
  const db = makeDb();
  insert(db, {
    timestamp: 1_000,
    requestId: 'req-pix-paid',
    endpoint: '/api/internal/pix/poll',
    body: '[PIX_POLL] PROVIDER RESPONSE - chargeId=ch_pix, providerStatus=paid, dbStatus=processing',
  });
  insert(db, {
    timestamp: 1_100,
    requestId: 'req-pix-paid',
    endpoint: '/api/internal/pix/poll',
    body: '🛑 POLL STOPPED - Payment already completed for chargeId ch_pix',
  });

  const result = aggregatePaymentCreditFunnel(db, {
    startMs: 0,
    endMs: 10_000,
    graceMs: 2_000,
  });

  assert.equal(result.providerPaidAfterGrace, 1);
  assert.equal(result.creditsSucceeded, 1);
  assert.equal(result.paidWithoutCreditAfterGrace, 0);
});

test('treats a manually reconciled paid replay as settled without exposing it as overdue', () => {
  const db = makeDb();
  insert(db, {
    timestamp: 1_000,
    requestId: 'req-manual-replay',
    endpoint: '/api/webhooks/pagarme',
    body: '💰 PROCESSING PAYMENT - charge.paid event for chargeId=ch_manual',
  });
  insert(db, {
    timestamp: 1_100,
    requestId: 'req-manual-replay',
    endpoint: '/api/webhooks/pagarme',
    body: '🎉 PAYMENT PROCESSING COMPLETE - chargeId=ch_manual, creditsAdded=false, creditBlocked=false, manuallyReconciled=true',
  });

  const result = aggregatePaymentCreditFunnel(db, {
    startMs: 0,
    endMs: 10_000,
    graceMs: 2_000,
  });

  assert.equal(result.providerPaidAfterGrace, 1);
  assert.equal(result.creditsSucceeded, 1);
  assert.equal(result.paidWithoutCreditAfterGrace, 0);
});

test('counts one exact CreditClaim registry outage per financial request', () => {
  const db = makeDb();
  insert(db, {
    timestamp: 1_000,
    requestId: 'req-registry',
    endpoint: '/api/payments/process',
    body: '[CREDIT-CLAIM] claim read failed — refusing unguarded credit',
  });
  insert(db, {
    timestamp: 1_001,
    requestId: 'req-registry',
    endpoint: '/api/payments/process',
    body: 'Immediate credit failed: CreditClaimRegistryUnavailableError: Credit claim registry unavailable',
  });
  insert(db, {
    timestamp: 2_000,
    requestId: 'req-unrelated',
    endpoint: '/api/unrelated',
    body: 'CreditClaimRegistryUnavailableError appears in unrelated diagnostic text',
  });

  const result = aggregatePaymentCreditFunnel(db, {
    startMs: 0,
    endMs: 10_000,
    graceMs: 2_000,
  });

  assert.equal(result.creditClaimRegistryUnavailable, 1);
});

test('counts an intrinsic CreditClaim failure even when Vercel omits the route field', () => {
  const db = makeDb();
  insert(db, {
    timestamp: 1_000,
    requestId: 'req-registry-no-route',
    endpoint: null,
    body: '[CREDIT-CLAIM] historical claim lookup failed — refusing unguarded credit',
  });

  const result = aggregatePaymentCreditFunnel(db, {
    startMs: 0,
    endMs: 10_000,
    graceMs: 2_000,
  });

  assert.equal(result.creditClaimRegistryUnavailable, 1);
});

test('ignores rows outside the requested time window', () => {
  const db = makeDb();
  insert(db, {
    timestamp: 999,
    requestId: 'req-before',
    endpoint: '/api/webhooks/pagarme',
    body: '💰 PROCESSING PAYMENT - charge.paid event for chargeId=ch_before',
  });
  insert(db, {
    timestamp: 10_000,
    requestId: 'req-end',
    endpoint: '/api/webhooks/pagarme',
    body: '💰 PROCESSING PAYMENT - charge.paid event for chargeId=ch_end',
  });

  const result = aggregatePaymentCreditFunnel(db, {
    startMs: 1_000,
    endMs: 10_000,
    graceMs: 0,
  });

  assert.deepEqual(result, {
    providerPaidAfterGrace: 0,
    creditsSucceeded: 0,
    paidWithoutCreditAfterGrace: 0,
    creditClaimRegistryUnavailable: 0,
  });
});

test('funnel response exposes all four PII-free payment credit counters', () => {
  const db = makeDb();
  db.prepare(`
    INSERT INTO vercel_requests (request_id, last_ts, endpoint, method, status_code)
    VALUES (?, ?, ?, ?, ?)
  `).run('req-checkout', 2_000, '/api/payments/process', 'POST', 200);
  insert(db, {
    timestamp: 1_000,
    requestId: 'req-checkout',
    endpoint: '/api/payments/process',
    body: '✅ CREDITS ADDED - userId=private, paymentRef=ch_contract',
  });

  const result = readFunnelCounts(db, {
    startMs: 0,
    endMs: 10_000,
    paymentCreditGraceMs: 2_000,
  });

  assert.deepEqual(result.payments, {
    processOk: 1,
    processFailed: 0,
    webhookOk: 0,
    providerPaidAfterGrace: 1,
    creditsSucceeded: 1,
    paidWithoutCreditAfterGrace: 0,
    creditClaimRegistryUnavailable: 0,
  });
  assert.equal(JSON.stringify(result).includes('private'), false);
  assert.equal(JSON.stringify(result).includes('ch_contract'), false);
});
