#!/usr/bin/env node
/**
 * Regression test for the daily charger-fault digest (2026-07-07).
 *
 * Covers the pure pieces of scripts/daily-digest.js: grouping raw alert rows
 * by charger+error, classifying a group as still-broken vs resolved using
 * the live backoff state, the backend-alert repeated/singleton split, and
 * the final message assembly. DB access and the WhatsApp send are excluded
 * on purpose — those are thin I/O wrappers around these pure functions.
 */

const assert = require('assert');
const {
    extractErrorCode,
    groupChargerFaultRows,
    classifyGroups,
    summarizeBackendAlerts,
    buildMessage,
} = require('../scripts/daily-digest');

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

console.log('🧪 Daily digest\n');

check('extractErrorCode pulls the erro= field out of the description', () => {
    assert.strictEqual(
        extractErrorCode('Carregador reportou falha (status=Faulted, erro=OtherError, info=SECC CAN Offline)'),
        'OtherError'
    );
    assert.strictEqual(
        extractErrorCode('Carregador reportou falha (status=Faulted, erro=NoError)'),
        'NoError'
    );
});
check('extractErrorCode falls back to "fault" when there is no erro= field', () => {
    assert.strictEqual(extractErrorCode('Carregador reportou falha (charger_faulted)'), 'fault');
    assert.strictEqual(extractErrorCode(null), 'fault');
});

check('groupChargerFaultRows groups by charger+error and tracks count/first/last', () => {
    const rows = [
        { charger_id: 'A', description: 'Carregador reportou falha (status=Faulted, erro=OtherError)', created_at: 1000 },
        { charger_id: 'A', description: 'Carregador reportou falha (status=Faulted, erro=OtherError)', created_at: 2000 },
        { charger_id: 'A', description: 'Carregador reportou falha (status=Faulted, erro=NoError)', created_at: 1500 },
        { charger_id: 'B', description: 'Carregador reportou falha (status=Faulted, erro=OtherError)', created_at: 3000 },
    ];
    const groups = groupChargerFaultRows(rows);
    assert.strictEqual(groups.length, 3, 'A::OtherError, A::NoError, B::OtherError are distinct groups');

    const aOther = groups.find(g => g.key === 'A::OtherError');
    assert.strictEqual(aOther.count, 2);
    assert.strictEqual(aOther.firstSeen, 1000);
    assert.strictEqual(aOther.lastSeen, 2000);

    const aNone = groups.find(g => g.key === 'A::NoError');
    assert.strictEqual(aNone.count, 1);
});

check('classifyGroups: active backoff state (within 2x last window) is still broken', () => {
    const now = 1_000_000;
    const groups = [{ key: 'A::OtherError', chargerId: 'A', errKey: 'OtherError', count: 5, firstSeen: 0, lastSeen: now - 1000 }];
    const backoffState = { 'A::OtherError': { lastSent: now - 1000, streak: 4, lastWindow: 6 * 60 * 60 * 1000 } };

    const { stillBroken, resolved } = classifyGroups(groups, backoffState, now);
    assert.strictEqual(stillBroken.length, 1);
    assert.strictEqual(resolved.length, 0);
});

check('classifyGroups: backoff gap past 2x the last window reads as resolved', () => {
    const now = 100 * 60 * 60 * 1000; // 100h
    const lastWindow = 6 * 60 * 60 * 1000; // 6h tier
    const lastSent = now - 13 * 60 * 60 * 1000; // 13h ago, > 2*6h
    const groups = [{ key: 'A::OtherError', chargerId: 'A', errKey: 'OtherError', count: 5, firstSeen: 0, lastSeen: lastSent }];
    const backoffState = { 'A::OtherError': { lastSent, streak: 4, lastWindow } };

    const { stillBroken, resolved } = classifyGroups(groups, backoffState, now);
    assert.strictEqual(stillBroken.length, 0);
    assert.strictEqual(resolved.length, 1);
});

check('classifyGroups: a group with no backoff state at all reads as resolved', () => {
    const groups = [{ key: 'Z::InternalError', chargerId: 'Z', errKey: 'InternalError', count: 1, firstSeen: 0, lastSeen: 0 }];
    const { stillBroken, resolved } = classifyGroups(groups, {}, Date.now());
    assert.strictEqual(stillBroken.length, 0);
    assert.strictEqual(resolved.length, 1, 'no positive evidence of an active streak -> resolved, not broken');
});

check('summarizeBackendAlerts splits repeated endpoints from one-off singletons', () => {
    const rows = [
        { description: '3 erro(s) 5xx em /api/stations/X/reset nos últimos 5 minutos' },
        { description: '1 erro(s) 5xx em /api/stations/X/reset nos últimos 5 minutos' },
        { description: '1 erro(s) 5xx em /api/users/pagarme-customer nos últimos 5 minutos' },
        { description: '2 timeout(s) em /api/internal/pix/poll (>12s)' },
    ];
    const { total, repeated, singleton } = summarizeBackendAlerts(rows);
    assert.strictEqual(total, 4);
    assert.strictEqual(repeated.length, 1);
    assert.strictEqual(repeated[0][0], '/api/stations/X/reset');
    assert.strictEqual(repeated[0][1], 2);
    assert.strictEqual(singleton.length, 2);
});

check('buildMessage: empty day reads as a clean bill of health, no empty sections', () => {
    const msg = buildMessage({ stillBroken: [], resolved: [], backendRows: [], now: Date.now() });
    assert.ok(msg.includes('Nenhuma falha de carregador'), 'should say nothing happened');
    assert.ok(!msg.includes('Ainda com problema'), 'should not print an empty "ainda com problema" section');
});

check('buildMessage: still-broken and resolved sections both render with names', () => {
    const now = 1_000_000_000;
    const stillBroken = [{ chargerId: 'X1', name: 'Metrópole Shopping 1', errKey: 'SECC CAN Offline', count: 23, firstSeen: now - 20 * 3600000, lastSeen: now - 3600000 }];
    const resolved = [{ chargerId: 'X2', name: 'UP CAR 01', errKey: 'CR_Plc_ErrorCodeII', count: 1, lastSeen: now - 5 * 3600000 }];
    const msg = buildMessage({ stillBroken, resolved, backendRows: [], now });

    assert.ok(msg.includes('Ainda com problema* (1)'));
    assert.ok(msg.includes('Metrópole Shopping 1'));
    assert.ok(msg.includes('SECC CAN Offline'));
    assert.ok(msg.includes('Resolvido* (1'));
    assert.ok(msg.includes('UP CAR 01'));
});

console.log(`\n${failures === 0 ? '✅ All checks passed' : `❌ ${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
