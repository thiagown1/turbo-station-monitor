#!/usr/bin/env node
/**
 * Cable-theft incident state must survive a full disk (2026-09-06 regression).
 *
 * What happened: the OpenClaw disk filled at 10:46 UTC. `saveCableTheftState`
 * used `fs.writeFileSync`, which truncates before writing, so the ENOSPC left
 * `history/cable_theft_incidents.json` at 0 bytes. When pm2 came back at 18:28
 * the engine logged `Error loading cable-theft incident state: Unexpected end
 * of JSON input`, started from `{}`, and re-burst 5x to the URGENTE group for
 * Metrópole 3 (314030001957) and UP CAR 01 (GUTS2606030001) — two thefts the
 * team had already been paged about days earlier, neither of which had ever
 * recovered. Same pair of causes on 2026-09-01 → 09-02.
 *
 * Two invariants: the write can fail without destroying the previous state, and
 * a state file that IS lost is rebuilt from ocpp.db rather than read as "no
 * incident is open".
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AlertEngine = require('../services/alert-engine');
const { writeJsonAtomic } = require('../services/atomic-json');

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

console.log('🧪 Cable-theft state durability\n');

const MIN = 60 * 1000;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cable-theft-state-'));
let fileSeq = 0;
const tmpFile = () => path.join(tmpDir, `state-${fileSeq++}.json`);

// --- atomic write ------------------------------------------------------------

check('writeJsonAtomic writes valid JSON and leaves no temp file behind', () => {
    const file = tmpFile();
    writeJsonAtomic(file, { 'CH1::2': { alertedAt: 1 } });
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { 'CH1::2': { alertedAt: 1 } });
    assert.ok(!fs.existsSync(`${file}.tmp`), 'temp file cleaned up');
});

check('a failed write leaves the PREVIOUS state intact (the ENOSPC shape)', () => {
    const file = tmpFile();
    writeJsonAtomic(file, { 'CH1::2': { alertedAt: 1 } });

    // Stand-in for ENOSPC: the write throws after the old file would have been
    // truncated by the previous implementation.
    const circular = {};
    circular.self = circular;
    assert.throws(() => writeJsonAtomic(file, circular), 'write must surface the failure');

    assert.deepStrictEqual(
        JSON.parse(fs.readFileSync(file, 'utf8')), { 'CH1::2': { alertedAt: 1 } },
        'previous state survives a failed write',
    );
    assert.ok(!fs.existsSync(`${file}.tmp`), 'no half-written temp file left behind');
});

// --- load / rebuild ----------------------------------------------------------

const faultMsg = (conn) =>
    `STATUS_NOTIF cid=x charger=Y connector=${conn} status=Faulted error=HighTemperature, info=DC OverTemp Connector, vendor_error=29`;
const otherFaultMsg = (conn) =>
    `STATUS_NOTIF cid=x charger=Y connector=${conn} status=Faulted error=OtherError, info=SECC CAN Offline, vendor_error=10`;
const opMsg = (conn, status) =>
    `STATUS_NOTIF cid=x charger=Y connector=${conn} status=${status} error=NoError`;

const row = (chargerId, ts, message) => ({ charger_id: chargerId, timestamp: ts, message });

// Fake ocpp.db: dispatches on the two shapes the engine issues — the recent
// window scan (no charger filter) and the per-charger walk (`charger_id = ?`,
// optionally bounded by `timestamp > ?` for the recovery check).
function fakeOcppDb(rows) {
    return {
        prepare: (sql) => ({
            all: (...args) => {
                let out = rows;
                if (/charger_id = \?/.test(sql)) {
                    out = out.filter((r) => r.charger_id === args[0]);
                    if (args.length > 1) out = out.filter((r) => r.timestamp > args[1]);
                } else if (args.length) {
                    out = out.filter((r) => r.timestamp > args[0]);
                }
                return [...out].sort((a, b) => b.timestamp - a.timestamp);
            },
        }),
    };
}

function makeEngine(rows, stateFile) {
    return {
        cableTheftStateFile: stateFile,
        cableTheftState: {},
        ocppDb: fakeOcppDb(rows),
        isOperationalOcppStatus: AlertEngine.prototype.isOperationalOcppStatus,
        hasConnectorRecoveredSince: AlertEngine.prototype.hasConnectorRecoveredSince,
        shouldAlertCableTheft: AlertEngine.prototype.shouldAlertCableTheft,
        findCableTheftStreakStart: AlertEngine.prototype.findCableTheftStreakStart,
        reconstructOpenCableTheftIncidents: AlertEngine.prototype.reconstructOpenCableTheftIncidents,
        recoverCableTheftState: AlertEngine.prototype.recoverCableTheftState,
        loadCableTheftState: AlertEngine.prototype.loadCableTheftState,
        saveCableTheftState: AlertEngine.prototype.saveCableTheftState,
    };
}

/** A theft reported every 5 min for `minutes`, ending `now`. */
function ongoingTheft(chargerId, connector, minutes, now = Date.now()) {
    const rows = [];
    for (let ago = minutes; ago >= 0; ago -= 5) rows.push(row(chargerId, now - ago * MIN, faultMsg(connector)));
    return rows;
}

check('missing state file → empty state (genuine first run)', () => {
    const e = makeEngine([], path.join(tmpDir, 'does-not-exist.json'));
    assert.deepStrictEqual(e.loadCableTheftState(), {});
});

check('valid state file → loaded as written', () => {
    const file = tmpFile();
    const state = { 'CH1::2': { alertedAt: 1234, connectorId: 2 } };
    fs.writeFileSync(file, JSON.stringify(state));
    const e = makeEngine([], file);
    assert.deepStrictEqual(e.loadCableTheftState(), state);
});

// THE REGRESSION: 0-byte file + a theft that never recovered.
check('0-byte state file → open incident rebuilt, NOT a fresh burst', () => {
    const file = tmpFile();
    fs.writeFileSync(file, ''); // exactly what the ENOSPC truncation left behind
    const e = makeEngine(ongoingTheft('GUTS2606030001', 2, 180), file);

    e.cableTheftState = e.loadCableTheftState();
    assert.ok(e.cableTheftState['GUTS2606030001::2'], 'open incident recovered from ocpp.db');
    assert.strictEqual(
        e.shouldAlertCableTheft('GUTS2606030001', 2), false,
        'must NOT re-burst for a theft that never recovered',
    );
});

check('rebuilt state is persisted, so the next boot reads a valid file', () => {
    const file = tmpFile();
    fs.writeFileSync(file, '{"CH1"'); // truncated mid-write
    const e = makeEngine(ongoingTheft('CH1', 2, 180), file);
    e.cableTheftState = e.loadCableTheftState();

    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.ok(onDisk['CH1::2'], 'rebuilt incident written back to disk');
    assert.strictEqual(onDisk['CH1::2'].reconstructed, true, 'marked as reconstructed');
});

check('rebuild ignores a connector that is operational again', () => {
    const now = Date.now();
    const rows = [...ongoingTheft('CH1', 2, 180, now - 30 * MIN), row('CH1', now - MIN, opMsg(2, 'Available'))];
    const e = makeEngine(rows, tmpFile());
    assert.deepStrictEqual(e.reconstructOpenCableTheftIncidents(now), {}, 'recovered connector is not an open incident');
});

check('rebuild ignores non-theft faults', () => {
    const now = Date.now();
    const rows = [];
    for (let ago = 180; ago >= 0; ago -= 5) rows.push(row('CH1', now - ago * MIN, otherFaultMsg(1)));
    const e = makeEngine(rows, tmpFile());
    assert.deepStrictEqual(e.reconstructOpenCableTheftIncidents(now), {}, 'SECC CAN Offline is not a theft signature');
});

// A crash can beat the burst, so a theft that only just started must still page.
check('rebuild skips a streak younger than the min age → fresh theft still bursts', () => {
    const now = Date.now();
    const e = makeEngine(ongoingTheft('CH1', 2, 10, now), tmpFile());
    assert.deepStrictEqual(e.reconstructOpenCableTheftIncidents(now), {}, '10-minute-old theft not adopted');
    assert.strictEqual(e.shouldAlertCableTheft('CH1', 2), true, 'never-alerted theft still bursts');
});

check('rebuild is per-connector: a healthy connector 1 does not mask connector 2', () => {
    const now = Date.now();
    const rows = [...ongoingTheft('CH1', 2, 180, now)];
    for (let ago = 180; ago >= 0; ago -= 5) rows.push(row('CH1', now - ago * MIN, opMsg(1, 'Charging')));
    const e = makeEngine(rows, tmpFile());
    const rebuilt = e.reconstructOpenCableTheftIncidents(now);
    assert.ok(rebuilt['CH1::2'], 'stolen connector 2 still open');
    assert.ok(!rebuilt['CH1::1'], 'charging connector 1 is not an incident');
});

check('alertedAt is the streak start, so a LATER recovery still re-bursts', () => {
    const now = Date.now();
    // Recovered 4h ago, faulted since 3h ago.
    const rows = [row('CH1', now - 240 * MIN, opMsg(2, 'Available')), ...ongoingTheft('CH1', 2, 180, now)];
    const e = makeEngine(rows, tmpFile());
    const rebuilt = e.reconstructOpenCableTheftIncidents(now);
    const rec = rebuilt['CH1::2'];
    assert.ok(rec, 'incident rebuilt');
    assert.ok(rec.alertedAt <= now - 175 * MIN, 'alertedAt anchored at the start of the current streak');
    assert.ok(rec.alertedAt > now - 240 * MIN, 'the old recovery is NOT inside the streak');

    // Repaired now → the next fault is a new incident and must page again.
    e.cableTheftState = rebuilt;
    e.ocppDb = fakeOcppDb([...rows, row('CH1', now, opMsg(2, 'Available'))]);
    assert.strictEqual(e.shouldAlertCableTheft('CH1', 2), true, 're-burst after a genuine recovery');
});

check('rebuild survives an ocpp.db query error without throwing', () => {
    const e = makeEngine([], tmpFile());
    e.ocppDb = { prepare: () => { throw new Error('database is locked'); } };
    assert.deepStrictEqual(e.reconstructOpenCableTheftIncidents(), {});
});

fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(`\n${failures === 0 ? '✅ All checks passed' : `❌ ${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
