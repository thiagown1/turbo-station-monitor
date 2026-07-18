#!/usr/bin/env node
/**
 * Regression test for the night-watch escalation (2026-07-18).
 *
 * During the 2026-07-16 cable theft at Cond Tiê Mirante 2 (DF260112002) the
 * charger reported "Hardware failure" from 01:43 BRT and paged hourly as a
 * routine 🟠 "Carregador em falha" warning — indistinguishable from the ~15
 * daytime fault warnings the fleet emits per day, so nobody reacted until
 * morning. The FIRST fault of a streak landing between 22:00 and 06:00
 * America/Sao_Paulo must now escalate to 🔴 critical with a theft-suspicion
 * title and a check-the-cameras action line. Repeats keep the existing
 * backoff cadence and the normal warning severity — no nightly siren from a
 * chronic flapper — and the cable-theft temperature signature keeps
 * precedence when both match.
 */

const assert = require('assert');
const AlertEngine = require('../services/alert-engine');
const { isNightWatchHour, isOvernightFirstFault, hourInTimeZone } = AlertEngine;

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

console.log('🧪 Night-watch escalation (overnight first-faults)\n');

// America/Sao_Paulo is UTC-3 year-round (Brazil abolished DST in 2019), so a
// BRT wall-clock time is built as Date.UTC(..., hourBrt + 3, ...).
function brt(y, m, d, hh, mm = 0, ss = 0) {
    return Date.UTC(y, m - 1, d, hh + 3, mm, ss);
}

check('hourInTimeZone converts UTC → BRT wall-clock hour', () => {
    assert.strictEqual(hourInTimeZone(brt(2026, 7, 16, 1, 43)), 1);
    assert.strictEqual(hourInTimeZone(brt(2026, 7, 16, 14, 0)), 14);
    assert.strictEqual(hourInTimeZone(brt(2026, 7, 16, 0, 0)), 0, 'midnight is 0, never 24');
});

check('window boundaries: 22:00 in, 21:59:59 out; 06:00 out, 05:59:59 in', () => {
    assert.strictEqual(isNightWatchHour(brt(2026, 7, 16, 21, 59, 59)), false);
    assert.strictEqual(isNightWatchHour(brt(2026, 7, 16, 22, 0, 0)), true);
    assert.strictEqual(isNightWatchHour(brt(2026, 7, 16, 5, 59, 59)), true);
    assert.strictEqual(isNightWatchHour(brt(2026, 7, 16, 6, 0, 0)), false);
});

check('covers the whole overnight span (23:00, 00:00, 03:00) and no daytime hour', () => {
    assert.strictEqual(isNightWatchHour(brt(2026, 7, 16, 23, 0)), true);
    assert.strictEqual(isNightWatchHour(brt(2026, 7, 16, 0, 0)), true);
    assert.strictEqual(isNightWatchHour(brt(2026, 7, 16, 3, 0)), true);
    for (const h of [6, 9, 12, 15, 18, 21]) {
        assert.strictEqual(isNightWatchHour(brt(2026, 7, 16, h, 30)), false, `h=${h} must be outside the window`);
    }
});

check('the 2026-07-16 incident time (01:43 BRT) is inside the window', () => {
    assert.strictEqual(isNightWatchHour(brt(2026, 7, 16, 1, 43)), true);
});

check('isOvernightFirstFault: only streak 1 escalates, and only at night', () => {
    const night = brt(2026, 7, 16, 1, 43);
    const day = brt(2026, 7, 16, 14, 43);
    assert.strictEqual(isOvernightFirstFault(1, night), true);
    assert.strictEqual(isOvernightFirstFault(2, night), false, 'repeats keep the normal severity');
    assert.strictEqual(isOvernightFirstFault(9, night), false);
    assert.strictEqual(isOvernightFirstFault(1, day), false, 'daytime first fault stays a warning');
});

// ─── detectChargerFaults wiring ──────────────────────────────────────────────
// Same fake-engine pattern as test-cable-theft-alert.js: the real prototype
// method against stubbed sqlite + a real (or stubbed) backoff, so we never
// open the live DBs.

const HW_FAIL_MSG = 'STATUS_NOTIF cid=x stage=received charger=DF260112002 connector=1 status=Faulted error=OtherError, info=Hardware failure, vendor_error=7';
const THEFT_MSG = 'STATUS_NOTIF cid=abc123 stage=received charger=124030001957 connector=1 status=Faulted error=HighTemperature, info=DC OverTemp Connector, vendor_error=29';

function faultRow(ts, message = HW_FAIL_MSG, id = 1) {
    return {
        id,
        timestamp: ts,
        charger_id: 'DF260112002',
        event_type: 'charger_faulted',
        meta: null,
        message,
    };
}

function detectWith(rows, streak = 1) {
    const fake = {
        ocppDb: { prepare: () => ({ all: () => rows }) },
        shouldSendChargerFaultAlert: () => ({ streak, windowMs: 60 * 60 * 1000 }),
    };
    return AlertEngine.prototype.detectChargerFaults.call(fake);
}

check('first fault of a streak at 01:43 BRT escalates to critical + night title', () => {
    const alerts = detectWith([faultRow(brt(2026, 7, 16, 1, 43))], 1);
    assert.strictEqual(alerts.length, 1);
    assert.strictEqual(alerts[0].severity, 'critical');
    assert.strictEqual(alerts[0].night_watch, true);
    assert.strictEqual(alerts[0].title, 'Falha noturna - possível furto/vandalismo');
    assert.ok(!alerts[0].urgent, 'night-watch alone must not page the URGENTE group');
});

check('the hourly repeat (streak 2) stays a warning with the generic title', () => {
    const alerts = detectWith([faultRow(brt(2026, 7, 16, 2, 43))], 2);
    assert.strictEqual(alerts[0].severity, 'warning');
    assert.strictEqual(alerts[0].night_watch, false);
    assert.strictEqual(alerts[0].title, 'Carregador em falha');
});

check('a daytime first fault stays a warning', () => {
    const alerts = detectWith([faultRow(brt(2026, 7, 16, 14, 43))], 1);
    assert.strictEqual(alerts[0].severity, 'warning');
    assert.strictEqual(alerts[0].night_watch, false);
    assert.strictEqual(alerts[0].title, 'Carregador em falha');
});

check('cable-theft temperature signature keeps precedence over night-watch', () => {
    const alerts = detectWith([faultRow(brt(2026, 7, 16, 1, 43), THEFT_MSG)], 1);
    assert.strictEqual(alerts[0].severity, 'critical');
    assert.strictEqual(alerts[0].urgent, true, 'still pages the URGENTE group');
    assert.strictEqual(alerts[0].night_watch, false, 'the temperature leg owns this alert');
    assert.ok(/roubo de cabo/i.test(alerts[0].title));
});

check('a streak reset after recovery re-arms the escalation (via real backoff)', () => {
    // Real shouldSendChargerFaultAlert against a fake state store: first send
    // is streak 1, an exact-window repeat is streak 2, and a >2x-window gap
    // resets back to streak 1 — the night-watch predicate must follow.
    const engine = {
        chargerFaultBackoff: {},
        saveChargerFaultBackoff() {},
        shouldSendChargerFaultAlert: AlertEngine.prototype.shouldSendChargerFaultAlert,
    };
    const realNow = Date.now;
    const at = (ts, fn) => { Date.now = () => ts; try { return fn(); } finally { Date.now = realNow; } };

    const KEY = 'DF260112002::OtherError';
    const t1 = brt(2026, 7, 16, 1, 43);
    const first = at(t1, () => engine.shouldSendChargerFaultAlert(KEY));
    assert.strictEqual(isOvernightFirstFault(first.streak, t1), true, 'fresh incident at night escalates');

    const t2 = t1 + first.windowMs;
    const repeat = at(t2, () => engine.shouldSendChargerFaultAlert(KEY));
    assert.strictEqual(isOvernightFirstFault(repeat.streak, t2), false, 'streak 2 must not re-escalate');

    const t3 = t2 + 3 * repeat.windowMs; // > 2x window → recovery reset
    const fresh = at(t3, () => engine.shouldSendChargerFaultAlert(KEY));
    assert.strictEqual(fresh.streak, 1, 'long gap resets the streak');
    assert.strictEqual(isOvernightFirstFault(fresh.streak, brt(2026, 7, 17, 4, 43)), true, 'a NEW overnight incident escalates again');
});

check('formatAlertMessage: night-watch alert renders 🔴 + camera action line', () => {
    const [alert] = detectWith([faultRow(brt(2026, 7, 16, 1, 43))], 1);
    const msg = AlertEngine.prototype.formatAlertMessage.call({}, alert);
    assert.ok(msg.startsWith('🔴'), 'critical emoji');
    assert.ok(/Falha noturna/.test(msg), 'night title in the message');
    assert.ok(/Fora do horário comercial - considere verificar câmeras\/local/.test(msg), 'camera action line');
});

check('formatAlertMessage: ordinary fault keeps the routine action line', () => {
    const [alert] = detectWith([faultRow(brt(2026, 7, 16, 14, 43))], 1);
    const msg = AlertEngine.prototype.formatAlertMessage.call({}, alert);
    assert.ok(msg.startsWith('🟠'), 'warning emoji');
    assert.ok(/pode ter limpado sozinho/.test(msg), 'routine action line');
    assert.ok(!/câmeras/.test(msg), 'no camera line during the day');
});

console.log(`\n${failures === 0 ? '✅ All checks passed' : `❌ ${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
