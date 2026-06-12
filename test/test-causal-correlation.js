#!/usr/bin/env node
/**
 * Regression test for the causal Charger+Backend correlation gate.
 *
 * Reproduces the 2026-06-12 false-critical: a fault on GUTS2606030001 was
 * "correlated" with `/api/stations/accessible 403` + `/api/users/<uid> 404`,
 * which have no causal link to the charger. The gate must reject those and
 * only accept a real charge-action failure on the SAME charger.
 */

const assert = require('assert');
const {
    isCausalBackendError,
    parseStatusNotif,
    isEmergencyStopFault,
} = require('../services/alert-engine');

let failures = 0;
function check(name, fn) {
    try {
        fn();
        console.log(`  ✅ ${name}`);
    } catch (e) {
        failures++;
        console.error(`  ❌ ${name}: ${e.message}`);
    }
}

const CHARGER = 'GUTS2606030001';

console.log('🧪 Causal correlation gate\n');

// The exact bogus pair from the screenshot — must NOT correlate.
check('rejects /api/stations/accessible (unrelated, not an action route)', () => {
    assert.strictEqual(isCausalBackendError('/api/stations/accessible', CHARGER), false);
});
check('rejects /api/users/<uid> 404 (unrelated user lookup)', () => {
    assert.strictEqual(isCausalBackendError('/api/users/D6yxkRCfOJZc8WBlCG13QEoO7Zl1', CHARGER), false);
});

// Same charger but a READ route — not a charge action, must NOT correlate.
check('rejects same-charger analytics read', () => {
    assert.strictEqual(isCausalBackendError(`/api/stations/${CHARGER}/analytics-summary?type=daily`, CHARGER), false);
});
check('rejects same-charger pricing/health reads', () => {
    assert.strictEqual(isCausalBackendError(`/api/stations/${CHARGER}/health`, CHARGER), false);
    assert.strictEqual(isCausalBackendError(`/api/stations/${CHARGER}/pricing`, CHARGER), false);
});

// Action route but a DIFFERENT charger — must NOT correlate with our fault.
check('rejects charge-action route on a different charger', () => {
    assert.strictEqual(isCausalBackendError('/api/stations/AR0609260001/remote-start', CHARGER), false);
});

// The real causal case: charge-action route referencing THIS charger.
check('accepts remote-start on the same charger', () => {
    assert.strictEqual(isCausalBackendError(`/api/stations/${CHARGER}/remote-start`, CHARGER), true);
});
check('accepts remote-stop / start-transaction / authorize on same charger', () => {
    assert.strictEqual(isCausalBackendError(`/api/stations/${CHARGER}/remote-stop`, CHARGER), true);
    assert.strictEqual(isCausalBackendError(`/api/ocpp/${CHARGER}/start-transaction`, CHARGER), true);
    assert.strictEqual(isCausalBackendError(`/api/internal/pnc/authorize?charger_id=${CHARGER}`, CHARGER), true);
});

// Guards
check('null/empty endpoint or charger never correlates', () => {
    assert.strictEqual(isCausalBackendError('', CHARGER), false);
    assert.strictEqual(isCausalBackendError('/api/stations/x/remote-start', ''), false);
    assert.strictEqual(isCausalBackendError(null, CHARGER), false);
});

console.log('\n🧪 Fault parsing / e-stop exclusion\n');

check('parses Faulted StatusNotification free-text', () => {
    const p = parseStatusNotif('STATUS_NOTIF charger=GUTS connector=2 status=Faulted error=OtherError, info=GQ_DIN_RECEIVED_CST');
    assert.strictEqual(p.status, 'Faulted');
    assert.strictEqual(p.error, 'OtherError');
    assert.strictEqual(p.info, 'GQ_DIN_RECEIVED_CST');
    assert.strictEqual(p.connectorId, 2);
});
check('flags e-stop press so it is excluded from fault alerts', () => {
    const msg = 'connector=1 status=Faulted error=OtherError, vendor_error=The emergency stop button was pressed';
    assert.strictEqual(isEmergencyStopFault(parseStatusNotif(msg), msg), true);
});
check('a real OtherError fault is NOT treated as e-stop', () => {
    const msg = 'connector=2 status=Faulted error=OtherError, info=GQ_DIN_RECEIVED_CST';
    assert.strictEqual(isEmergencyStopFault(parseStatusNotif(msg), msg), false);
});

console.log('');
if (failures > 0) {
    console.error(`❌ ${failures} test(s) failed`);
    process.exit(1);
}
console.log('✅ All causal-correlation tests passed');
