#!/usr/bin/env node
/**
 * Burst-then-silence for cable-theft (HighTemperature) alerts (2026-07-18).
 *
 * A cut DC cable re-reports HighTemperature every ~5 min for as long as it
 * stays broken (Metrópole 3: 03:53 → 18:51 BRT). The old escalating backoff
 * re-paged the URGENTE group across that whole span. New behavior: burst once
 * per incident, then stay SILENT for that charger+connector until it RECOVERS
 * (reports an operational status again); a later theft after a recovery bursts
 * again. Per-connector so a healthy connector 1 never masks a stolen connector 2.
 */

const assert = require('assert');
const AlertEngine = require('../services/alert-engine');

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

console.log('🧪 Cable-theft burst-then-silence\n');

// Rows mirror `SELECT message FROM ocpp_events` — objects with a `.message`.
const opRow = (cid, status) => ({
    message: `STATUS_NOTIF cid=x charger=Y connector=${cid} status=${status} error=NoError`,
});
const faultRow = (cid) => ({
    message: `STATUS_NOTIF cid=x charger=Y connector=${cid} status=Faulted error=HighTemperature, info=DC OverTemp Connector, vendor_error=29`,
});

// A fake engine wired with the REAL incident-gate methods so the prototype logic
// under test runs unchanged; ocppRows feeds hasConnectorRecoveredSince.
function makeEngine(ocppRows = []) {
    return {
        cableTheftState: {},
        ocppDb: { prepare: () => ({ all: () => ocppRows }) },
        saveCableTheftState() {},
        isOperationalOcppStatus: AlertEngine.prototype.isOperationalOcppStatus,
        hasConnectorRecoveredSince: AlertEngine.prototype.hasConnectorRecoveredSince,
        shouldAlertCableTheft: AlertEngine.prototype.shouldAlertCableTheft,
    };
}

check('isOperationalOcppStatus: operational yes, Faulted/Unavailable no', () => {
    const e = makeEngine();
    for (const s of ['Available', 'Charging', 'Preparing', 'SuspendedEV', 'Finishing', 'Reserved']) {
        assert.strictEqual(e.isOperationalOcppStatus(s), true, `${s} should be operational`);
    }
    for (const s of ['Faulted', 'Unavailable', '', undefined]) {
        assert.strictEqual(e.isOperationalOcppStatus(s), false, `${s} should NOT be operational`);
    }
});

check('fresh incident → alerts once and records the incident', () => {
    const e = makeEngine([]);
    assert.strictEqual(e.shouldAlertCableTheft.call(e, 'CH1', 2), true);
    assert.ok(e.cableTheftState['CH1::2'], 'incident recorded');
});

check('ongoing incident (still faulted, no recovery) → SILENT', () => {
    const e = makeEngine([faultRow(2)]); // only Faulted events since the alert
    e.shouldAlertCableTheft.call(e, 'CH1', 2); // fresh burst
    assert.strictEqual(e.shouldAlertCableTheft.call(e, 'CH1', 2), false, 'no re-burst while open');
});

check('per-connector: connector 1 charging does NOT clear connector 2 theft', () => {
    // The exact Metrópole 3 shape: conn 1 charging normally, conn 2 stolen.
    const e = makeEngine([opRow(1, "Charging"), faultRow(2)]);
    e.shouldAlertCableTheft.call(e, 'CH1', 2); // fresh burst on conn 2
    assert.strictEqual(
        e.shouldAlertCableTheft.call(e, 'CH1', 2),
        false,
        'connector 1 activity must not read as connector 2 recovery',
    );
});

check('recovery on the SAME connector → re-bursts as a new incident', () => {
    const e = makeEngine([faultRow(2)]);
    e.shouldAlertCableTheft.call(e, 'CH1', 2); // fresh burst
    // Now the connector recovers (repaired): an operational status appears.
    e.ocppDb = { prepare: () => ({ all: () => [opRow(2, "Available")] }) };
    assert.strictEqual(e.shouldAlertCableTheft.call(e, 'CH1', 2), true, 're-burst after recovery');
});

check('cleanupCableTheftState drops entries older than 30 days', () => {
    const e = {
        cableTheftState: {
            'OLD::1': { alertedAt: Date.now() - 40 * 24 * 60 * 60 * 1000 },
            'NEW::1': { alertedAt: Date.now() - 60 * 1000 },
        },
        saveCableTheftState() {},
    };
    AlertEngine.prototype.cleanupCableTheftState.call(e);
    assert.ok(!e.cableTheftState['OLD::1'], 'old incident pruned');
    assert.ok(e.cableTheftState['NEW::1'], 'recent incident kept');
});

check('formatUrgentCableTheftMessage numbers the burst and announces the silence', () => {
    const alert = {
        charger_id: '314030001957',
        event_ts: Date.now(),
        parsed_fault: { connectorId: 2, error: 'HighTemperature', info: 'DC OverTemp Connector' },
    };
    const m1 = AlertEngine.prototype.formatUrgentCableTheftMessage.call({}, alert, 1, 5);
    assert.ok(/Aviso 1\/5/.test(m1), 'first message numbered 1/5');
    assert.ok(!/não haverá novos avisos/.test(m1), 'silence notice only on the last');
    const m5 = AlertEngine.prototype.formatUrgentCableTheftMessage.call({}, alert, 5, 5);
    assert.ok(/Aviso 5\/5/.test(m5), 'last message numbered 5/5');
    assert.ok(/não haverá novos avisos/i.test(m5), 'last announces the silence');
    // Backwards compatible: no burst args → no footer.
    const plain = AlertEngine.prototype.formatUrgentCableTheftMessage.call({}, alert);
    assert.ok(!/Aviso \d+\//.test(plain), 'no footer without burst args');
});

console.log(`\n${failures === 0 ? '✅ All checks passed' : `❌ ${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
