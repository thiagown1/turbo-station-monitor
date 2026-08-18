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

const DAY = 24 * 60 * 60 * 1000;

// The GC fake needs the real recovery check, because "can this record be
// expired?" is now a function of whether the connector came back.
function makeGcEngine(state, ocppRows = []) {
    return {
        cableTheftState: state,
        ocppDb: { prepare: () => ({ all: () => ocppRows }) },
        saveCableTheftState() {},
        isOperationalOcppStatus: AlertEngine.prototype.isOperationalOcppStatus,
        hasConnectorRecoveredSince: AlertEngine.prototype.hasConnectorRecoveredSince,
        cleanupCableTheftState: AlertEngine.prototype.cleanupCableTheftState,
    };
}

check('cleanupCableTheftState drops RECOVERED entries older than 30 days', () => {
    const e = makeGcEngine({
        'OLD::1': { alertedAt: Date.now() - 40 * DAY, connectorId: 1 },
        'NEW::1': { alertedAt: Date.now() - 60 * 1000, connectorId: 1 },
    }, [opRow(1, 'Available')]); // connector recovered → safe to forget
    e.cleanupCableTheftState();
    assert.ok(!e.cableTheftState['OLD::1'], 'old recovered incident pruned');
    assert.ok(e.cableTheftState['NEW::1'], 'recent incident kept');
});

// REGRESSION (2026-08-18): Metrópole 3 connector 2 stayed faulted from 18/07.
// At the 30-day mark the GC dropped the record, the very next tick read the
// same never-resolved fault as a fresh incident, and the URGENTE group got the
// full 5x burst again for a theft the team had already handled.
check('cleanupCableTheftState KEEPS an unresolved incident past 30 days', () => {
    const e = makeGcEngine({
        'CH1::2': { alertedAt: Date.now() - 40 * DAY, connectorId: 2 },
    }, [faultRow(2)]); // still faulted, never recovered
    e.cleanupCableTheftState();
    assert.ok(e.cableTheftState['CH1::2'], 'unresolved incident must NOT be expired');
});

check('unresolved incident survives the GC → still silent on the next tick', () => {
    const rows = [faultRow(2)];
    const e = makeGcEngine({
        'CH1::2': { alertedAt: Date.now() - 40 * DAY, connectorId: 2 },
    }, rows);
    e.cleanupCableTheftState();
    e.shouldAlertCableTheft = AlertEngine.prototype.shouldAlertCableTheft;
    assert.strictEqual(
        e.shouldAlertCableTheft('CH1', 2), false,
        'no re-burst for the same never-resolved fault'
    );
});

check('suppressed tick refreshes lastSeenAt so the record never ages out', () => {
    const e = makeEngine([faultRow(2)]);
    e.cableTheftState['CH1::2'] = { alertedAt: Date.now() - 40 * DAY, connectorId: 2 };
    assert.strictEqual(e.shouldAlertCableTheft.call(e, 'CH1', 2), false, 'still silent');
    const rec = e.cableTheftState['CH1::2'];
    assert.ok(rec.lastSeenAt >= Date.now() - 5000, 'lastSeenAt refreshed on suppression');
    assert.ok(rec.alertedAt < Date.now() - 39 * DAY, 'alertedAt is NOT moved (recovery window intact)');
});

check('GC ages off lastSeenAt, not alertedAt', () => {
    // Ongoing incident touched a minute ago: old alertedAt must not expire it,
    // even in the (impossible-in-practice) case where recovery reads true.
    const e = makeGcEngine({
        'CH1::2': { alertedAt: Date.now() - 40 * DAY, lastSeenAt: Date.now() - 60 * 1000, connectorId: 2 },
    }, [opRow(2, 'Available')]);
    e.cleanupCableTheftState();
    assert.ok(e.cableTheftState['CH1::2'], 'recently-touched record kept');
});

check('legacy record without connectorId/chargerId is still GC-safe', () => {
    // Records written before the chargerId/lastSeenAt fields existed must fall
    // back to parsing the key rather than throwing or being blindly dropped.
    const e = makeGcEngine({
        'CH1::2': { alertedAt: Date.now() - 40 * DAY },
        'CH2::x': { alertedAt: Date.now() - 40 * DAY },
    }, [faultRow(2)]);
    e.cleanupCableTheftState();
    assert.ok(e.cableTheftState['CH1::2'], 'legacy unresolved record kept');
    assert.ok(e.cableTheftState['CH2::x'], 'legacy null-connector record kept');
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
