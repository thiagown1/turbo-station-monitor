#!/usr/bin/env node
/**
 * Regression test for the cable-theft urgent alert (2026-07-14).
 *
 * When the Metrópole Shopping 1 cable was stolen (2026-05-05 07:02) the
 * charger reported, every 5 minutes:
 *   status=Faulted error=HighTemperature, info=DC OverTemp Connector, vendor_error=29
 * The severed thermistor line reads as over-temperature. That signature must:
 *   - be recognized by isCableTheftSuspectFault()
 *   - escalate the charger_fault alert to critical + urgent
 *   - produce a self-contained message for the "Turbo Station + URGENTE" group
 * Ordinary faults (SECC CAN Offline, e-stop) must NOT be flagged urgent.
 */

const assert = require('assert');
const AlertEngine = require('../services/alert-engine');
const { parseStatusNotif, isCableTheftSuspectFault } = require('../services/ocpp-utils');

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

console.log('🧪 Cable-theft urgent alert\n');

// The exact line the collector stored for the Metrópole 1 theft.
const THEFT_MSG = 'STATUS_NOTIF cid=abc123 stage=received charger=124030001957 connector=1 status=Faulted error=HighTemperature, info=DC OverTemp Connector, vendor_error=29';

check('recognizes the real Metrópole 1 theft signature', () => {
    const parsed = parseStatusNotif(THEFT_MSG);
    assert.strictEqual(parsed.error, 'HighTemperature');
    assert.strictEqual(parsed.info, 'DC OverTemp Connector');
    assert.ok(isCableTheftSuspectFault(parsed, THEFT_MSG));
});

check('recognizes HighTemperature without info (other vendors)', () => {
    const msg = 'STATUS_NOTIF cid=x stage=received charger=PN2603100001 connector=1 status=Faulted error=HighTemperature';
    assert.ok(isCableTheftSuspectFault(parseStatusNotif(msg), msg));
});

check('recognizes OverTemp info even when errorCode is OtherError', () => {
    const msg = 'STATUS_NOTIF cid=x stage=received charger=Y connector=2 status=Faulted error=OtherError, info=DC OverTemp Connector, vendor_error=29';
    assert.ok(isCableTheftSuspectFault(parseStatusNotif(msg), msg));
});

check('does NOT flag ordinary faults (SECC CAN Offline / e-stop / CP state)', () => {
    for (const msg of [
        'STATUS_NOTIF cid=x stage=received charger=Y connector=2 status=Faulted error=OtherError, info=SECC CAN Offline, vendor_error=10',
        'STATUS_NOTIF cid=x stage=received charger=Y connector=1 status=Faulted error=OtherError, info=EmergencyButtonPressed, vendor_error=19',
        'STATUS_NOTIF cid=x stage=received charger=Y connector=1 status=Faulted error=OtherError, info=GQ_DETECT_CP_STATE_B, vendor_error=25',
        'STATUS_NOTIF cid=x stage=received charger=Y connector=1 status=Charging error=NoError',
    ]) {
        assert.strictEqual(isCableTheftSuspectFault(parseStatusNotif(msg), msg), false, `should not flag: ${msg}`);
    }
});

// detectChargerFaults() only touches this.ocppDb + shouldSendChargerFaultAlert,
// so exercise the real prototype method against a fake engine (same pattern as
// test-charger-fault-backoff.js — avoids opening the live sqlite DBs).
function detectWith(rows) {
    const fake = {
        ocppDb: { prepare: () => ({ all: () => rows }) },
        shouldSendChargerFaultAlert: () => ({ streak: 1, windowMs: 60 * 60 * 1000 }),
    };
    return AlertEngine.prototype.detectChargerFaults.call(fake);
}

function faultRow(message, id = 1) {
    return {
        id,
        timestamp: Date.now() - 60 * 1000,
        charger_id: '124030001957',
        event_type: 'charger_faulted',
        meta: null,
        message,
    };
}

check('detectChargerFaults escalates the theft signature to critical + urgent', () => {
    const alerts = detectWith([faultRow(THEFT_MSG)]);
    assert.strictEqual(alerts.length, 1);
    assert.strictEqual(alerts[0].severity, 'critical');
    assert.strictEqual(alerts[0].urgent, true);
    assert.ok(/roubo de cabo/i.test(alerts[0].title), 'title names the suspicion');
});

check('detectChargerFaults keeps ordinary faults as warning, not urgent', () => {
    const alerts = detectWith([faultRow(
        'STATUS_NOTIF cid=x stage=received charger=124030001957 connector=2 status=Faulted error=OtherError, info=SECC CAN Offline, vendor_error=10'
    )]);
    assert.strictEqual(alerts.length, 1);
    assert.strictEqual(alerts[0].severity, 'warning');
    assert.ok(!alerts[0].urgent);
});

check('formatUrgentCableTheftMessage is self-contained (charger, error, action)', () => {
    const alerts = detectWith([faultRow(THEFT_MSG)]);
    const msg = AlertEngine.prototype.formatUrgentCableTheftMessage.call({}, alerts[0]);
    assert.ok(/URGENTE/.test(msg), 'has the URGENTE header');
    assert.ok(/124030001957/.test(msg), 'names the charger');
    assert.ok(/HighTemperature/.test(msg), 'names the error');
    assert.ok(/Conector 1/.test(msg), 'names the connector');
    assert.ok(/câmeras/i.test(msg), 'tells the group what to do');
});

console.log(`\n${failures === 0 ? '✅ All checks passed' : `❌ ${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
