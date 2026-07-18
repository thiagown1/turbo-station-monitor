#!/usr/bin/env node
/**
 * Tests for silence-detector.js (2026-07-18 Metropole Shopping 3 cable-theft
 * incident: charger 314030001957 went completely silent mid-session at 00:24
 * BRT and zero alerts fired).
 *
 * Uses an in-memory ocpp_events table with the smart-collector schema; the
 * clock, debounce and active-transaction source are injected, so every case
 * is deterministic.
 *
 * Run: node test/test-silence-detector.js
 */

'use strict';

const assert = require('assert');
const Database = require('better-sqlite3');
const {
    detectSilentChargers,
    findActiveTxAtSilence,
    SILENCE_THRESHOLD_MS,
    ALIVE_WINDOW_MS,
    AGGREGATE_THRESHOLD,
} = require('../services/silence-detector');

const MIN = 60 * 1000;
const NOW = 1789000000000; // fixed fake clock

function freshDb() {
    const db = new Database(':memory:');
    db.exec(`
        CREATE TABLE ocpp_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp INTEGER,
            charger_id TEXT,
            event_type TEXT,
            category TEXT,
            severity TEXT,
            logger TEXT,
            message TEXT,
            meta TEXT
        );
        CREATE INDEX idx_ocpp_events_timestamp ON ocpp_events(timestamp);
        CREATE INDEX idx_ocpp_events_charger_id ON ocpp_events(charger_id);
    `);
    return db;
}

function seed(db, chargerId, ts, eventType = 'heartbeat', message = 'Heartbeat') {
    db.prepare(`
        INSERT INTO ocpp_events (timestamp, charger_id, event_type, category, severity, logger, message, meta)
        VALUES (?, ?, ?, ?, 'info', 'test', ?, NULL)
    `).run(ts, chargerId, eventType, eventType, message);
}

/** Healthy idle history: heartbeat rows every 5 min ending at `lastTs`. */
function seedAlive(db, chargerId, lastTs, rows = 6) {
    for (let i = rows - 1; i >= 0; i--) {
        seed(db, chargerId, lastTs - i * 5 * MIN);
    }
}

function alwaysAlert() { return true; }
function noTx() { return []; }

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

console.log('🧪 silence-detector\n');

check('idle charger silent 15 min -> single warning with event_ts=now', () => {
    const db = freshDb();
    seedAlive(db, 'CP-IDLE', NOW - 15 * MIN);
    seedAlive(db, 'CP-OK', NOW - 1 * MIN); // keeps the feed globally fresh
    const alerts = detectSilentChargers({ ocppDb: db, shouldAlert: alwaysAlert, getActiveTransactions: noTx, now: NOW });
    assert.strictEqual(alerts.length, 1);
    const a = alerts[0];
    assert.strictEqual(a.type, 'charger_silent');
    assert.strictEqual(a.severity, 'warning');
    assert.strictEqual(a.charger_id, 'CP-IDLE');
    assert.ok(/sem comunicacao/i.test(a.description), 'description mentions no-comms');
    assert.ok(!/furto/i.test(a.description), 'idle silence must NOT claim theft');
    // Freshness: event_ts must be "now" or the engine's 10-min guard drops it.
    assert.strictEqual(a.event_ts, NOW);
    assert.strictEqual(a.silent_since_ts, NOW - 15 * MIN);
});

check('silence with active tx -> critical + "possivel corte de energia/furto"', () => {
    const db = freshDb();
    seedAlive(db, 'CP-CHARGING', NOW - 15 * MIN);
    seedAlive(db, 'CP-OK', NOW - 1 * MIN);
    const txs = () => [{
        id: 1784344621,
        chargerId: 'CP-CHARGING',
        startTime: new Date(NOW - 23 * MIN).toISOString(),
        lastUpdate: new Date(NOW - 15 * MIN).toISOString(),
    }];
    const alerts = detectSilentChargers({ ocppDb: db, shouldAlert: alwaysAlert, getActiveTransactions: txs, now: NOW });
    assert.strictEqual(alerts.length, 1);
    const a = alerts[0];
    assert.strictEqual(a.severity, 'critical');
    assert.strictEqual(a.tx_active, true);
    assert.strictEqual(a.tx_id, 1784344621);
    assert.ok(/possivel corte de energia\/furto/i.test(a.description), 'critical wording present');
});

check('incident replay: 314030001957 timeline fires critical', () => {
    // Remote tx 1784344621 started 00:16:49 BRT, events every 30s, last event
    // 00:24:49 BRT, then total silence. Detector runs 12 min after the last
    // event (collector rows are 5-min throttled; we seed the throttled shape).
    const db = freshDb();
    const lastEvent = NOW - 12 * MIN;
    const txStart = lastEvent - 8 * MIN;
    seed(db, '314030001957', txStart, 'transaction_start', 'StartTransaction Accepted');
    seed(db, '314030001957', txStart + 5 * MIN, 'meter_values', 'MeterValues Active power: 56000');
    seed(db, '314030001957', lastEvent, 'meter_values', 'MeterValues Active power: 56120');
    seedAlive(db, 'CP-OTHER-SITE', NOW - 2 * MIN);
    const txs = () => [{
        id: 1784344621,
        chargerId: '314030001957',
        startTime: new Date(txStart).toISOString(),
        lastUpdate: new Date(lastEvent).toISOString(),
    }];
    const alerts = detectSilentChargers({ ocppDb: db, shouldAlert: alwaysAlert, getActiveTransactions: txs, now: NOW });
    assert.strictEqual(alerts.length, 1);
    assert.strictEqual(alerts[0].severity, 'critical');
    assert.strictEqual(alerts[0].charger_id, '314030001957');
    assert.ok(/furto/i.test(alerts[0].description));
    // Partner leg: evidence raw message must classify as STATION_OFFLINE
    const ev = JSON.parse(alerts[0].evidence_json);
    assert.ok(/disconnected/i.test(ev.ocpp.event.message));
});

check('healthy charger (2 min ago) -> no alert', () => {
    const db = freshDb();
    seedAlive(db, 'CP-OK', NOW - 2 * MIN);
    const alerts = detectSilentChargers({ ocppDb: db, shouldAlert: alwaysAlert, getActiveTransactions: noTx, now: NOW });
    assert.strictEqual(alerts.length, 0);
});

check('long-dead charger (3h ago) is outside the alive window -> no alert', () => {
    const db = freshDb();
    seedAlive(db, 'CP-DEAD', NOW - 3 * 60 * MIN);
    seedAlive(db, 'CP-OK', NOW - 1 * MIN);
    const alerts = detectSilentChargers({ ocppDb: db, shouldAlert: alwaysAlert, getActiveTransactions: noTx, now: NOW });
    assert.strictEqual(alerts.length, 0);
});

check('one silence episode = one alert (window expiry, no re-fire)', () => {
    // 70 min silent: was alerted at the 10-min mark in a previous run; by now
    // the last event fell out of the alive window so it must NOT re-fire even
    // with the debounce open again.
    const db = freshDb();
    seedAlive(db, 'CP-GONE', NOW - 70 * MIN);
    seedAlive(db, 'CP-OK', NOW - 1 * MIN);
    const alerts = detectSilentChargers({ ocppDb: db, shouldAlert: alwaysAlert, getActiveTransactions: noTx, now: NOW });
    assert.strictEqual(alerts.length, 0);
});

check('debounced charger -> no alert, and shouldAlert only called on real candidates', () => {
    const db = freshDb();
    seedAlive(db, 'CP-IDLE', NOW - 15 * MIN);
    seedAlive(db, 'CP-OK', NOW - 1 * MIN);
    const calls = [];
    const deny = (key) => { calls.push(key); return false; };
    const alerts = detectSilentChargers({ ocppDb: db, shouldAlert: deny, getActiveTransactions: noTx, now: NOW });
    assert.strictEqual(alerts.length, 0);
    assert.deepStrictEqual(calls, ['CP-IDLE']);
});

check('stale active tx (last update long before silence) -> warning, not critical', () => {
    const db = freshDb();
    seedAlive(db, 'CP-IDLE', NOW - 15 * MIN);
    seedAlive(db, 'CP-OK', NOW - 1 * MIN);
    // Leftover active entry that stopped updating 50 min before the last event
    const txs = () => [{
        id: 999,
        chargerId: 'CP-IDLE',
        startTime: new Date(NOW - 120 * MIN).toISOString(),
        lastUpdate: new Date(NOW - 65 * MIN).toISOString(),
    }];
    const alerts = detectSilentChargers({ ocppDb: db, shouldAlert: alwaysAlert, getActiveTransactions: txs, now: NOW });
    assert.strictEqual(alerts.length, 1);
    assert.strictEqual(alerts[0].severity, 'warning');
});

check('whole feed stale -> [] (ingest stall owns it)', () => {
    const db = freshDb();
    seedAlive(db, 'CP-A', NOW - 20 * MIN);
    seedAlive(db, 'CP-B', NOW - 18 * MIN);
    seedAlive(db, 'CP-C', NOW - 15 * MIN);
    const alerts = detectSilentChargers({ ocppDb: db, shouldAlert: alwaysAlert, getActiveTransactions: noTx, now: NOW });
    assert.strictEqual(alerts.length, 0);
});

check('mass silence -> single aggregate alert, individuals debounce-stamped', () => {
    const db = freshDb();
    for (let i = 0; i < AGGREGATE_THRESHOLD + 1; i++) {
        seedAlive(db, `CP-SITE-${i}`, NOW - (15 + i) * MIN);
    }
    seedAlive(db, 'CP-OK', NOW - 1 * MIN); // feed globally fresh
    const stamped = [];
    const gate = (key) => { stamped.push(key); return true; };
    const txs = () => [{
        id: 42,
        chargerId: 'CP-SITE-0',
        startTime: new Date(NOW - 30 * MIN).toISOString(),
        lastUpdate: new Date(NOW - 15 * MIN).toISOString(),
    }];
    const alerts = detectSilentChargers({ ocppDb: db, shouldAlert: gate, getActiveTransactions: txs, now: NOW });
    assert.strictEqual(alerts.length, 1);
    const a = alerts[0];
    assert.strictEqual(a.type, 'charger_silent_mass');
    assert.strictEqual(a.severity, 'critical'); // CP-SITE-0 had an active session
    assert.ok(/possivel corte de energia\/furto/i.test(a.description));
    assert.ok(stamped.includes('mass'));
    for (let i = 0; i < AGGREGATE_THRESHOLD + 1; i++) {
        assert.ok(stamped.includes(`CP-SITE-${i}`), `CP-SITE-${i} stamped`);
    }
    assert.strictEqual(a.event_ts, NOW);
});

check('mass silence debounced -> nothing sent, individuals NOT stamped', () => {
    const db = freshDb();
    for (let i = 0; i < AGGREGATE_THRESHOLD; i++) {
        seedAlive(db, `CP-SITE-${i}`, NOW - 15 * MIN);
    }
    seedAlive(db, 'CP-OK', NOW - 1 * MIN);
    const calls = [];
    const gate = (key) => { calls.push(key); return key !== 'mass'; };
    const alerts = detectSilentChargers({ ocppDb: db, shouldAlert: gate, getActiveTransactions: noTx, now: NOW });
    assert.strictEqual(alerts.length, 0);
    assert.deepStrictEqual(calls, ['mass']);
});

check('single lone event in window is a blip -> no alert', () => {
    const db = freshDb();
    seed(db, 'CP-BLIP', NOW - 15 * MIN);
    seedAlive(db, 'CP-OK', NOW - 1 * MIN);
    const alerts = detectSilentChargers({ ocppDb: db, shouldAlert: alwaysAlert, getActiveTransactions: noTx, now: NOW });
    assert.strictEqual(alerts.length, 0);
});

check('ignored charger (deliberate nightly power-down) -> no alert', () => {
    const db = freshDb();
    seedAlive(db, 'CP-NIGHTLY', NOW - 15 * MIN);
    seedAlive(db, 'CP-OK', NOW - 1 * MIN);
    const alerts = detectSilentChargers({
        ocppDb: db,
        shouldAlert: alwaysAlert,
        getActiveTransactions: noTx,
        now: NOW,
        ignoredChargers: new Set(['CP-NIGHTLY']),
    });
    assert.strictEqual(alerts.length, 0);
});

check('tx source throwing degrades to warning, never crashes', () => {
    const db = freshDb();
    seedAlive(db, 'CP-IDLE', NOW - 15 * MIN);
    seedAlive(db, 'CP-OK', NOW - 1 * MIN);
    const boom = () => { throw new Error('fs exploded'); };
    const alerts = detectSilentChargers({ ocppDb: db, shouldAlert: alwaysAlert, getActiveTransactions: boom, now: NOW });
    assert.strictEqual(alerts.length, 1);
    assert.strictEqual(alerts[0].severity, 'warning');
});

check('findActiveTxAtSilence: matching charger + recent update wins; others do not', () => {
    const lastTs = NOW - 15 * MIN;
    const mk = (chargerId, updatedAgoMin) => ({
        id: 7, chargerId,
        startTime: new Date(NOW - 60 * MIN).toISOString(),
        lastUpdate: new Date(NOW - updatedAgoMin * MIN).toISOString(),
    });
    assert.ok(findActiveTxAtSilence([mk('CP-X', 16)], 'CP-X', lastTs));
    assert.strictEqual(findActiveTxAtSilence([mk('CP-OTHER', 16)], 'CP-X', lastTs), null);
    assert.strictEqual(findActiveTxAtSilence([mk('CP-X', 40)], 'CP-X', lastTs), null);
    assert.strictEqual(findActiveTxAtSilence([{ id: 1, chargerId: 'CP-X', lastUpdate: 'garbage' }], 'CP-X', lastTs), null);
    assert.strictEqual(findActiveTxAtSilence([], 'CP-X', lastTs), null);
});

check('threshold boundary: exactly at 10 min is not yet silent', () => {
    const db = freshDb();
    seedAlive(db, 'CP-EDGE', NOW - SILENCE_THRESHOLD_MS);
    seedAlive(db, 'CP-OK', NOW - 1 * MIN);
    const alerts = detectSilentChargers({ ocppDb: db, shouldAlert: alwaysAlert, getActiveTransactions: noTx, now: NOW });
    assert.strictEqual(alerts.length, 0);
});

console.log('');
if (failures > 0) {
    console.error(`❌ ${failures} test(s) failed`);
    process.exit(1);
}
console.log('✅ all silence-detector tests passed');
