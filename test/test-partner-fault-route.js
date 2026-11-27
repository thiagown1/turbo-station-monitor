#!/usr/bin/env node
/**
 * Partner-fault leg through /api/internal/partner-fault-alert: fault start,
 * duration in minutes and the route body (strict schema, 500-char description).
 */
const assert = require('assert');
const { findFaultStreakStart, faultDurationMin, buildRoutePayload } = require('../services/partner-fault-route');

let failures = 0;
function check(name, fn) {
    try { fn(); console.log(`  ✅ ${name}`); } catch (e) { failures++; console.error(`  ❌ ${name}: ${e.message}`); }
}
const MIN = 60000;

console.log('🧪 Partner fault route payload\n');

check('streak start = oldest Faulted after the last operational status (newest first)', () => {
    const rows = [
        { timestamp: 5000 * MIN, status: 'Faulted', connectorId: 1 },
        { timestamp: 4000 * MIN, status: 'Faulted', connectorId: 1 },
        { timestamp: 3000 * MIN, status: 'Faulted', connectorId: 1 },
        { timestamp: 2000 * MIN, status: 'Available', connectorId: 1 },
        { timestamp: 1000 * MIN, status: 'Faulted', connectorId: 1 }, // older streak, already recovered
    ];
    assert.strictEqual(findFaultStreakStart(rows, 1, 5000 * MIN), 3000 * MIN);
});
check('other connectors neither break nor extend the streak', () => {
    const rows = [
        { timestamp: 5000 * MIN, status: 'Faulted', connectorId: 2 },
        { timestamp: 4500 * MIN, status: 'Charging', connectorId: 1 }, // healthy connector 1
        { timestamp: 4000 * MIN, status: 'Faulted', connectorId: 2 },
        { timestamp: 3000 * MIN, status: 'Faulted', connectorId: 1 },
    ];
    assert.strictEqual(findFaultStreakStart(rows, 2, 5000 * MIN), 4000 * MIN);
});
check('no Faulted row or no rows falls back to the event timestamp', () => {
    assert.strictEqual(findFaultStreakStart([], 1, 777), 777);
    assert.strictEqual(findFaultStreakStart([{ timestamp: 1, status: 'Available', connectorId: 1 }], 1, 777), 777);
});
check('duration is whole minutes, never negative, null when unknown', () => {
    assert.strictEqual(faultDurationMin(0, 61 * MIN + 59000), 61);
    assert.strictEqual(faultDurationMin(10 * MIN, 0), 0);
    assert.strictEqual(faultDurationMin(undefined, 5), null);
});
check('payload carries faultDurationMin and only schema keys', () => {
    const p = buildRoutePayload({
        fault: { charger_id: 'GO2508130004', event_ts: 1700000000000, description: 'x' },
        parsed: { error: 'OtherError', info: 'GQ_Error', vendorError: '25', connectorId: 2 },
        message: '⚡ *Falha no carregador — Posto*\n\nO conector 2 falhou.',
        startTs: 1700000000000 - 90 * MIN, nowTs: 1700000000000,
    });
    assert.strictEqual(p.faultDurationMin, 90);
    assert.strictEqual(p.connectorId, 2);
    assert.strictEqual(p.eventId, 1700000000000);
    assert.strictEqual(p.faultCode, 'OtherError vendor_error=25');
    assert.strictEqual(p.faultInfo, 'GQ_Error');
    assert.ok(!p.description.includes('Falha no carregador — Posto'), 'title line dropped');
    const allowed = new Set(['chargerId', 'eventId', 'description', 'faultCode', 'faultInfo', 'connectorId', 'faultDurationMin']);
    for (const k of Object.keys(p)) assert.ok(allowed.has(k), `unexpected key ${k}`);
});
check('long description is capped at 500 and unknown start omits the duration', () => {
    const p = buildRoutePayload({
        fault: { charger_id: 'X', event_ts: 1 },
        parsed: {},
        message: 'title\n' + 'a'.repeat(900),
        startTs: undefined, nowTs: 10,
    });
    assert.strictEqual(p.description.length, 500);
    assert.ok(!('faultDurationMin' in p));
});

if (failures) { console.error(`\n${failures} failed`); process.exit(1); }
console.log('\nOK');
