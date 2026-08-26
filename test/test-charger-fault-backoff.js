#!/usr/bin/env node
/**
 * Regression test for the escalating charger-fault backoff (2026-07-07).
 *
 * Before this, a charger stuck on the same fault re-alerted every hour
 * forever: one charger alone produced 165 of 306 alerts sent to the group
 * in 7 days (SECC CAN Offline, firing on the dot every hour for days).
 * shouldSendChargerFaultAlert() must back off the cadence the longer the
 * SAME charger+error persists, and reset to the fast tier once a long
 * silence suggests the charger actually recovered in between.
 */

const assert = require('assert');
const AlertEngine = require('../services/alert-engine');
const { windowForStreak } = AlertEngine;

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

console.log('🧪 Charger-fault escalating backoff\n');

check('windowForStreak: streak 0-2 use the 1h tier', () => {
    assert.strictEqual(windowForStreak(0), 60 * 60 * 1000);
    assert.strictEqual(windowForStreak(1), 60 * 60 * 1000);
    assert.strictEqual(windowForStreak(2), 60 * 60 * 1000);
});
check('windowForStreak: streak 3-7 use the 6h tier', () => {
    assert.strictEqual(windowForStreak(3), 6 * 60 * 60 * 1000);
    assert.strictEqual(windowForStreak(7), 6 * 60 * 60 * 1000);
});
check('windowForStreak: streak 8+ use the 24h (daily) tier', () => {
    assert.strictEqual(windowForStreak(8), 24 * 60 * 60 * 1000);
    assert.strictEqual(windowForStreak(50), 24 * 60 * 60 * 1000);
});

// shouldSendChargerFaultAlert() only touches this.chargerFaultBackoff +
// this.saveChargerFaultBackoff(), so we can exercise the real prototype
// method against a plain fake object instead of booting a full AlertEngine
// (whose constructor opens the live sqlite DBs).
function makeFakeEngine() {
    return {
        chargerFaultBackoff: {},
        saveChargerFaultBackoff() {},
        shouldSendChargerFaultAlert: AlertEngine.prototype.shouldSendChargerFaultAlert,
    };
}

const realNow = Date.now;
function at(ts, fn) {
    Date.now = () => ts;
    try { return fn(); } finally { Date.now = realNow; }
}

check('a repeat within the window is debounced (no re-send)', () => {
    const engine = makeFakeEngine();
    const KEY = 'CHARGER_A::OtherError';
    const t0 = 1_000_000_000_000;

    assert.ok(at(t0, () => engine.shouldSendChargerFaultAlert(KEY)), 'first alert sends');
    const blocked = at(t0 + 30 * 60 * 1000, () => engine.shouldSendChargerFaultAlert(KEY));
    assert.strictEqual(blocked, false, 'a repeat 30min later (within the 1h window) must be debounced');
});

check('a fault firing every hour escalates 1h -> 6h -> daily', () => {
    const engine = makeFakeEngine();
    const KEY = 'CHARGER_B::SECC CAN Offline';
    let t = 2_000_000_000_000;
    let last;

    // Calling exactly at each returned window keeps the streak alive
    // (never blocked) while riding the cadence up through the tiers.
    for (let i = 1; i <= 9; i++) {
        last = at(t, () => engine.shouldSendChargerFaultAlert(KEY));
        assert.ok(last, `call ${i} should send`);
        assert.strictEqual(last.streak, i);
        t += last.windowMs;
    }

    // First 3 consecutive sends stay on the fast (1h) tier...
    assert.strictEqual(windowForStreak(0), 60 * 60 * 1000);
    // ...then it escalates to 6h...
    assert.ok(last.windowMs >= 6 * 60 * 60 * 1000, 'cadence must have widened past 1h by the 9th send');
    // ...and by the 9th consecutive send (chronic, still unresolved) it's daily.
    assert.strictEqual(last.windowMs, 24 * 60 * 60 * 1000, 'by the 9th send the cadence should be daily');
});

check('a long silence resets the streak back to the fast tier', () => {
    const engine = makeFakeEngine();
    const KEY = 'CHARGER_C::InternalError';
    let t = 3_000_000_000_000;
    let last;

    // Escalate to the 6h tier.
    for (let i = 1; i <= 4; i++) {
        last = at(t, () => engine.shouldSendChargerFaultAlert(KEY));
        t += last.windowMs;
    }
    assert.strictEqual(last.windowMs, 6 * 60 * 60 * 1000);

    // Charger recovers; the fault doesn't recur for a long time (> 2x the
    // last window used) — the next occurrence reads as a fresh incident.
    t += 13 * 60 * 60 * 1000; // 13h of silence, > 2 * 6h
    const fresh = at(t, () => engine.shouldSendChargerFaultAlert(KEY));
    assert.ok(fresh, 'should send after the long gap');
    assert.strictEqual(fresh.streak, 1, 'streak resets to 1 after a long recovery gap');
    assert.strictEqual(fresh.windowMs, 60 * 60 * 1000, 'cadence resets to the 1h tier');
});

check('independent charger+error keys track separate streaks', () => {
    const engine = makeFakeEngine();
    const t0 = 4_000_000_000_000;

    const a1 = at(t0, () => engine.shouldSendChargerFaultAlert('CHARGER_D::OtherError'));
    const b1 = at(t0, () => engine.shouldSendChargerFaultAlert('CHARGER_D::InternalError'));
    assert.strictEqual(a1.streak, 1);
    assert.strictEqual(b1.streak, 1, 'a different error code on the same charger is an independent streak');
});

console.log(`\n${failures === 0 ? '✅ All checks passed' : `❌ ${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
