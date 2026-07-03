#!/usr/bin/env node
/**
 * Test Suite — Mobile Telemetry Service
 *
 * Unit tests for lib/utils + integration tests for all routes.
 * Uses supertest (no running server needed).
 *
 * Usage:
 *   node services/mobile-telemetry/tests/test-all.js
 */

const assert = require('assert');
const request = require('supertest');
const zlib = require('zlib');
const { promisify } = require('util');
const gzip = promisify(zlib.gzip);
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

// ─── Test harness ───────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name, fn) {
    test._tests.push({ name, fn });
}
test._tests = [];

async function runAll() {
    console.log('🧪 Mobile Telemetry — Test Suite\n');

    for (const { name, fn } of test._tests) {
        try {
            await fn();
            console.log(`  ✅ ${name}`);
            passed++;
        } catch (err) {
            console.log(`  ❌ ${name}`);
            console.log(`     ${err.message}`);
            failed++;
        }
    }

    console.log(`\n${'─'.repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
    if (failed > 0) process.exit(1);
}

// ─── Imports ────────────────────────────────────────────────────────────────────

// Set env var before requiring app so auth middleware works
process.env.MONITOR_API_SECRET = 'test-secret-12345';

const app = require('../index');
const { db, stmts } = require('../lib/db');
const { parseLocation, deriveSeverity } = require('../lib/utils');

const SECRET = 'test-secret-12345';

// ─── 1. Unit Tests: lib/utils ───────────────────────────────────────────────────

test('parseLocation — valid JSON with lat/lng', () => {
    const result = parseLocation('{"lat":-15.5,"lng":-56.0,"accuracy":10}');
    assert.strictEqual(result.lat, -15.5);
    assert.strictEqual(result.lng, -56.0);
});

test('parseLocation — null input', () => {
    const result = parseLocation(null);
    assert.strictEqual(result.lat, null);
    assert.strictEqual(result.lng, null);
});

test('parseLocation — invalid JSON', () => {
    const result = parseLocation('not json{{{');
    assert.strictEqual(result.lat, null);
    assert.strictEqual(result.lng, null);
});

test('parseLocation — JSON without lat/lng', () => {
    const result = parseLocation('{"foo":"bar"}');
    assert.strictEqual(result.lat, null);
    assert.strictEqual(result.lng, null);
});

test('deriveSeverity — error events', () => {
    assert.strictEqual(deriveSeverity('error'), 'error');
    assert.strictEqual(deriveSeverity('transaction_error'), 'error');
});

test('deriveSeverity — warning events', () => {
    assert.strictEqual(deriveSeverity('user_cancelled'), 'warning');
});

test('deriveSeverity — info for everything else', () => {
    assert.strictEqual(deriveSeverity('screen_open'), 'info');
    assert.strictEqual(deriveSeverity('start_charge_tap'), 'info');
    assert.strictEqual(deriveSeverity('unknown'), 'info');
});

// ─── 2. Integration Tests: Routes ───────────────────────────────────────────────

// ── Health ───────────────────────────────────────────────────────────────────────

test('GET /health → 200 OK', async () => {
    const res = await request(app).get('/health');
    assert.strictEqual(res.status, 200);
    assert.ok(res.text.includes('OK'));
});

test('GET /ping → 200 OK', async () => {
    const res = await request(app).get('/ping');
    assert.strictEqual(res.status, 200);
});

// ── 404 ─────────────────────────────────────────────────────────────────────────

test('GET /nonexistent → 404', async () => {
    const res = await request(app).get('/does-not-exist');
    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.body.error, 'Not found');
});

// ── Auth ────────────────────────────────────────────────────────────────────────

test('GET /api/telemetry/online-users without secret → 401', async () => {
    const res = await request(app).get('/api/telemetry/online-users');
    assert.strictEqual(res.status, 401);
    assert.strictEqual(res.body.error, 'Unauthorized');
});

test('GET /api/telemetry/heatmap-data without secret → 401', async () => {
    const res = await request(app).get('/api/telemetry/heatmap-data');
    assert.strictEqual(res.status, 401);
});

test('GET /api/telemetry/online-users with wrong secret → 401', async () => {
    const res = await request(app)
        .get('/api/telemetry/online-users')
        .set('X-Monitor-Secret', 'wrong');
    assert.strictEqual(res.status, 401);
});

// ── Online Users ────────────────────────────────────────────────────────────────

test('GET /api/telemetry/online-users with valid secret → 200', async () => {
    const res = await request(app)
        .get('/api/telemetry/online-users')
        .set('X-Monitor-Secret', SECRET);
    assert.strictEqual(res.status, 200);
    assert.ok(typeof res.body.count === 'number');
    assert.ok(Array.isArray(res.body.users));
});

// ── Recent Locations ────────────────────────────────────────────────────────────

test('GET /api/telemetry/recent-locations without secret → 401', async () => {
    const res = await request(app).get('/api/telemetry/recent-locations');
    assert.strictEqual(res.status, 401);
});

test('GET /api/telemetry/recent-locations with valid secret → 200', async () => {
    const res = await request(app)
        .get('/api/telemetry/recent-locations')
        .set('X-Monitor-Secret', SECRET);
    assert.strictEqual(res.status, 200);
    assert.ok(typeof res.body.count === 'number');
    assert.ok(Array.isArray(res.body.users));
});

test('GET /api/telemetry/recent-locations includes a device outside the online-users presence window', async () => {
    // Regression: online-users is bounded to PRESENCE_WINDOW_MS (90s) —
    // recent-locations must NOT apply that bound, since it backs a "opened
    // the app near here in the last N days" lookback, not "online right now".
    const tag = 'recentloc-' + Date.now();
    const staleTimestamp = Date.now() - 10 * 24 * 60 * 60 * 1000; // 10 days ago
    const staleLat = -15.6 - (Date.now() % 1000) / 1e6;

    stmts.insertEvent.run({
        raw_id: null,
        received_at: staleTimestamp,
        event_timestamp: staleTimestamp,
        session_id: `${tag}-s`,
        device_id: `${tag}-d`,
        app_version: '2.0.0-test',
        platform: 'android',
        user_id: `${tag}-u`,
        event_type: 'app_presence_heartbeat',
        station_id: null,
        brand_id: null,
        severity: null,
        message: null,
        data_json: JSON.stringify({ lat: staleLat, lng: -47.9 }),
    });

    // Confirms the exclusion: a 10-day-old heartbeat is well outside the 90s window.
    const online = await request(app)
        .get('/api/telemetry/online-users')
        .set('X-Monitor-Secret', SECRET);
    assert.ok(
        !online.body.users.some((u) => u.device_id === `${tag}-d`),
        'sanity check: stale device must NOT appear in online-users',
    );

    const recent = await request(app)
        .get('/api/telemetry/recent-locations')
        .set('X-Monitor-Secret', SECRET);
    assert.strictEqual(recent.status, 200);
    const found = recent.body.users.find((u) => u.device_id === `${tag}-d`);
    assert.ok(found, 'stale device MUST appear in recent-locations (no time bound)');
    assert.strictEqual(found.user_id, `${tag}-u`);
    assert.strictEqual(found.lat, staleLat);
    assert.strictEqual(found.lng, -47.9);
    assert.strictEqual(found.last_seen, staleTimestamp);

    db.prepare("DELETE FROM mobile_events WHERE device_id = ?").run(`${tag}-d`);
});

test('GET /api/telemetry/recent-locations returns only the latest row per device', async () => {
    const tag = 'recentlocdedup-' + Date.now();
    const older = Date.now() - 60_000;
    const newer = Date.now();

    for (const [ts, lat] of [[older, -15.1], [newer, -15.2]]) {
        stmts.insertEvent.run({
            raw_id: null,
            received_at: ts,
            event_timestamp: ts,
            session_id: `${tag}-s-${ts}`,
            device_id: `${tag}-d`,
            app_version: '2.0.0-test',
            platform: 'android',
            user_id: `${tag}-u`,
            event_type: 'app_presence_heartbeat',
            station_id: null,
            brand_id: null,
            severity: null,
            message: null,
            data_json: JSON.stringify({ lat, lng: -47.9 }),
        });
    }

    const res = await request(app)
        .get('/api/telemetry/recent-locations')
        .set('X-Monitor-Secret', SECRET);
    const matches = res.body.users.filter((u) => u.device_id === `${tag}-d`);
    assert.strictEqual(matches.length, 1, 'expected exactly one row (deduped) per device');
    assert.strictEqual(matches[0].last_seen, newer);
    assert.strictEqual(matches[0].lat, -15.2, 'should carry the location from the LATEST event, not an arbitrary one');

    db.prepare("DELETE FROM mobile_events WHERE device_id = ?").run(`${tag}-d`);
});

test('GET /api/telemetry/recent-locations excludes a device older than the 90-day cap by default', async () => {
    const tag = 'recentlocold-' + Date.now();
    const ancientTimestamp = Date.now() - 120 * 24 * 60 * 60 * 1000; // 120 days ago

    stmts.insertEvent.run({
        raw_id: null,
        received_at: ancientTimestamp,
        event_timestamp: ancientTimestamp,
        session_id: `${tag}-s`,
        device_id: `${tag}-d`,
        app_version: '2.0.0-test',
        platform: 'android',
        user_id: `${tag}-u`,
        event_type: 'app_presence_heartbeat',
        station_id: null,
        brand_id: null,
        severity: null,
        message: null,
        data_json: JSON.stringify({ lat: -15.7, lng: -47.9 }),
    });

    const res = await request(app)
        .get('/api/telemetry/recent-locations')
        .set('X-Monitor-Secret', SECRET);
    assert.strictEqual(res.status, 200);
    assert.ok(
        !res.body.users.some((u) => u.device_id === `${tag}-d`),
        'a 120-day-old device must be excluded — beyond the default 90-day cap',
    );

    db.prepare("DELETE FROM mobile_events WHERE device_id = ?").run(`${tag}-d`);
});

test('GET /api/telemetry/recent-locations respects a caller-supplied maxAgeMs narrower than the cap', async () => {
    const tag = 'recentlocnarrow-' + Date.now();
    const tenDaysAgo = Date.now() - 10 * 24 * 60 * 60 * 1000;

    stmts.insertEvent.run({
        raw_id: null,
        received_at: tenDaysAgo,
        event_timestamp: tenDaysAgo,
        session_id: `${tag}-s`,
        device_id: `${tag}-d`,
        app_version: '2.0.0-test',
        platform: 'android',
        user_id: `${tag}-u`,
        event_type: 'app_presence_heartbeat',
        station_id: null,
        brand_id: null,
        severity: null,
        message: null,
        data_json: JSON.stringify({ lat: -15.7, lng: -47.9 }),
    });

    const wideEnough = await request(app)
        .get('/api/telemetry/recent-locations?maxAgeMs=' + (15 * 24 * 60 * 60 * 1000))
        .set('X-Monitor-Secret', SECRET);
    assert.ok(wideEnough.body.users.some((u) => u.device_id === `${tag}-d`), '15-day window should include a 10-day-old device');

    const tooNarrow = await request(app)
        .get('/api/telemetry/recent-locations?maxAgeMs=' + (5 * 24 * 60 * 60 * 1000))
        .set('X-Monitor-Secret', SECRET);
    assert.ok(!tooNarrow.body.users.some((u) => u.device_id === `${tag}-d`), '5-day window should exclude a 10-day-old device');
    assert.strictEqual(tooNarrow.body.windowMs, 5 * 24 * 60 * 60 * 1000);

    db.prepare("DELETE FROM mobile_events WHERE device_id = ?").run(`${tag}-d`);
});

test('GET /api/telemetry/recent-locations clamps a caller-supplied maxAgeMs above the 90-day cap', async () => {
    const res = await request(app)
        .get('/api/telemetry/recent-locations?maxAgeMs=' + (365 * 24 * 60 * 60 * 1000))
        .set('X-Monitor-Secret', SECRET);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.windowMs, 90 * 24 * 60 * 60 * 1000, 'a 1-year request must clamp down to the 90-day cap');
});

// ── Heatmap Data ────────────────────────────────────────────────────────────────

test('GET /api/telemetry/heatmap-data?period=24h → 200', async () => {
    const res = await request(app)
        .get('/api/telemetry/heatmap-data?period=24h')
        .set('X-Monitor-Secret', SECRET);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.period, '24h');
    assert.ok(typeof res.body.count === 'number');
    assert.ok(Array.isArray(res.body.points));
});

test('GET /api/telemetry/heatmap-data defaults to 7d', async () => {
    const res = await request(app)
        .get('/api/telemetry/heatmap-data')
        .set('X-Monitor-Secret', SECRET);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.period, '7d');
});

test('GET /api/telemetry/heatmap-data?excludeUserIds=X → drops events from X', async () => {
    // Seed two presence events for two distinct users at distinct locations.
    // Unique IDs per run so re-running the suite doesn't leak rows between runs.
    const runTag = `excl-${Date.now()}`;
    const excludeUid = `${runTag}-EXCLUDE`;
    const keepUid = `${runTag}-KEEP`;
    // Lat/lng unique per run too (avoids point collisions if the DB is reused).
    const excludeLat = -15.85 - Date.now() % 1000 / 1e6;
    const keepLat = -15.80 - Date.now() % 1000 / 1e6;

    const now = Date.now();
    const insert = stmts.insertEvent;
    const baseRow = {
        raw_id: null,
        received_at: now,
        event_timestamp: now,
        app_version: '2.0.0-test',
        platform: 'android',
        event_type: 'app_presence_start',
        station_id: null,
        brand_id: null,
        severity: null,
        message: null,
    };
    insert.run({
        ...baseRow,
        session_id: `${runTag}-s1`,
        device_id: `${runTag}-d1`,
        user_id: excludeUid,
        data_json: JSON.stringify({ lat: excludeLat, lng: -48.03 }),
    });
    insert.run({
        ...baseRow,
        session_id: `${runTag}-s2`,
        device_id: `${runTag}-d2`,
        user_id: keepUid,
        data_json: JSON.stringify({ lat: keepLat, lng: -47.93 }),
    });

    const baseline = await request(app)
        .get('/api/telemetry/heatmap-data?period=24h')
        .set('X-Monitor-Secret', SECRET);
    assert.strictEqual(baseline.status, 200);
    const seededPts = baseline.body.points.filter(
        (p) => (p.lat === excludeLat && p.lng === -48.03) || (p.lat === keepLat && p.lng === -47.93)
    );
    assert.strictEqual(seededPts.length, 2, `expected both seeded points, got ${seededPts.length}`);

    const filtered = await request(app)
        .get(`/api/telemetry/heatmap-data?period=24h&excludeUserIds=${excludeUid}`)
        .set('X-Monitor-Secret', SECRET);
    assert.strictEqual(filtered.status, 200);
    const filteredSeeded = filtered.body.points.filter(
        (p) => (p.lat === excludeLat && p.lng === -48.03) || (p.lat === keepLat && p.lng === -47.93)
    );
    assert.strictEqual(filteredSeeded.length, 1, `expected only KEEP survives, got ${filteredSeeded.length}`);
    assert.strictEqual(filteredSeeded[0].lat, keepLat);
});

// ── Ingestion ───────────────────────────────────────────────────────────────────

function makePayload(overrides = {}) {
    return {
        session_id: 'test-' + Date.now(),
        device_id: 'test-device-001',
        app_version: '2.0.0-test',
        platform: 'android',
        user_id: 'test-uid',
        events: [
            {
                event_type: 'screen_open',
                timestamp: Date.now(),
                data: { screen: 'charger_detail', station_id: 'TEST_001' },
            },
            {
                event_type: 'start_charge_tap',
                timestamp: Date.now() + 1000,
                data: { station_id: 'TEST_001', connector_id: 1 },
            },
        ],
        ...overrides,
    };
}

test('POST /api/telemetry/mobile — valid payload → 202', async () => {
    const payload = makePayload();
    const res = await request(app)
        .post('/api/telemetry/mobile')
        .send(payload);
    assert.strictEqual(res.status, 202);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.received, 2);
    assert.strictEqual(res.body.session_id, payload.session_id);
});

test('POST /api/telemetry/mobile — empty events → 202 with 0 received', async () => {
    const res = await request(app)
        .post('/api/telemetry/mobile')
        .send(makePayload({ events: [] }));
    assert.strictEqual(res.status, 202);
    assert.strictEqual(res.body.received, 0);
});

test('POST /api/telemetry/mobile — missing events → 400', async () => {
    const res = await request(app)
        .post('/api/telemetry/mobile')
        .send({ session_id: 'x', device_id: 'y' });
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.error.includes('events'));
});

test('POST /api/telemetry/mobile — invalid JSON → 400', async () => {
    const res = await request(app)
        .post('/api/telemetry/mobile')
        .set('Content-Type', 'application/json')
        .send('not json{{{');
    assert.strictEqual(res.status, 400);
});

// NOTE: Gzip body test skipped. Supertest doesn't support Content-Encoding: gzip
// properly with raw stream processing. The gzip code path works with real clients.
// To test manually: curl -X POST -H "Content-Encoding: gzip" --data-binary @payload.gz ...

test('POST /api/telemetry/mobile — large batch (50 events) → 202', async () => {
    const events = Array.from({ length: 50 }, (_, i) => ({
        event_type: 'test_event',
        timestamp: Date.now() + i,
        data: { index: i },
    }));
    const res = await request(app)
        .post('/api/telemetry/mobile')
        .send(makePayload({ events }));
    assert.strictEqual(res.status, 202);
    assert.strictEqual(res.body.received, 50);
});

test('POST /api/telemetry/mobile — data persists in DB', async () => {
    const sessionId = 'db-check-' + Date.now();
    await request(app)
        .post('/api/telemetry/mobile')
        .send(makePayload({ session_id: sessionId }));

    const rows = db.prepare(
        'SELECT * FROM mobile_events WHERE session_id = ? ORDER BY id DESC'
    ).all(sessionId);

    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows[0].device_id, 'test-device-001');
    assert.strictEqual(rows[0].user_id, 'test-uid');
    assert.ok(['screen_open', 'start_charge_tap'].includes(rows[0].event_type));
});

// ── Brand ID ingestion ─────────────────────────────────────────────────────────

test('POST /api/telemetry/mobile — envelope brand_id persists to mobile_events.brand_id', async () => {
    const sessionId = 'brand-env-' + Date.now();
    await request(app)
        .post('/api/telemetry/mobile')
        .send(makePayload({ session_id: sessionId, brand_id: 'turbo_station' }));

    const rows = db.prepare(
        'SELECT brand_id FROM mobile_events WHERE session_id = ?'
    ).all(sessionId);

    assert.strictEqual(rows.length, 2);
    assert.ok(rows.every((r) => r.brand_id === 'turbo_station'),
        `expected all rows brand_id=turbo_station, got ${JSON.stringify(rows)}`);
});

test('POST /api/telemetry/mobile — per-event data.brand_id falls back when envelope omitted', async () => {
    const sessionId = 'brand-evt-' + Date.now();
    await request(app)
        .post('/api/telemetry/mobile')
        .send({
            session_id: sessionId,
            device_id: 'd1',
            app_version: '2.0.0-test',
            platform: 'android',
            user_id: 'u1',
            events: [
                { event_type: 'screen_open', timestamp: Date.now(), data: { brand_id: 'zev' } },
                { event_type: 'start_charge_tap', timestamp: Date.now(), data: { station_id: 'X' } },
            ],
        });

    const rows = db.prepare(
        'SELECT event_type, brand_id FROM mobile_events WHERE session_id = ? ORDER BY id'
    ).all(sessionId);

    assert.strictEqual(rows.length, 2);
    const byType = Object.fromEntries(rows.map((r) => [r.event_type, r.brand_id]));
    assert.strictEqual(byType.screen_open, 'zev', 'event with brand_id should record it');
    assert.strictEqual(byType.start_charge_tap, null, 'event without brand_id should be null');
});

test('POST /api/telemetry/mobile — no brand_id anywhere → null column', async () => {
    const sessionId = 'brand-none-' + Date.now();
    await request(app)
        .post('/api/telemetry/mobile')
        .send(makePayload({ session_id: sessionId }));

    const rows = db.prepare(
        'SELECT brand_id FROM mobile_events WHERE session_id = ?'
    ).all(sessionId);

    assert.ok(rows.every((r) => r.brand_id === null), 'all brand_id should be null');
});

// ── Events Query (deploy-monitor / hourly-funnel upstream) ─────────────────────

test('GET /api/telemetry/events without secret → 401', async () => {
    const res = await request(app).get('/api/telemetry/events');
    assert.strictEqual(res.status, 401);
});

test('GET /api/telemetry/events missing required params → 400', async () => {
    const res = await request(app)
        .get('/api/telemetry/events')
        .set('X-Monitor-Secret', SECRET);
    assert.strictEqual(res.status, 400);
});

test('GET /api/telemetry/events empty event_types → 400', async () => {
    const res = await request(app)
        .get('/api/telemetry/events?start_ms=1&end_ms=2&event_types=')
        .set('X-Monitor-Secret', SECRET);
    assert.strictEqual(res.status, 400);
    assert.ok(/event_types/.test(res.body.error));
});

test('GET /api/telemetry/events end_ms <= start_ms → 400', async () => {
    const res = await request(app)
        .get('/api/telemetry/events?start_ms=2000&end_ms=1000&event_types=foo')
        .set('X-Monitor-Secret', SECRET);
    assert.strictEqual(res.status, 400);
});

test('GET /api/telemetry/events returns seeded events in window with parsed data', async () => {
    const tag = 'evtq-' + Date.now();
    const t0 = Date.now();
    await request(app)
        .post('/api/telemetry/mobile')
        .send({
            session_id: tag,
            device_id: 'd-' + tag,
            app_version: '4.17.0',
            platform: 'android',
            user_id: 'u-' + tag,
            brand_id: 'turbo_station',
            events: [
                { event_type: 'start_charge_tap', timestamp: t0, data: { station_id: 'S1', start_flow_id: 'f1' } },
                { event_type: 'charging_confirmed', timestamp: t0 + 100, data: { station_id: 'S1', start_flow_id: 'f1' } },
                { event_type: 'screen_open', timestamp: t0 + 200, data: { screen: 'home' } }, // not requested
            ],
        });

    const res = await request(app)
        .get(`/api/telemetry/events?start_ms=${t0 - 1000}&end_ms=${t0 + 5000}&event_types=start_charge_tap,charging_confirmed`)
        .set('X-Monitor-Secret', SECRET);

    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.body.events));
    const seeded = res.body.events.filter((e) => e.user_id === 'u-' + tag);
    assert.strictEqual(seeded.length, 2, 'should return tap + confirm but not screen_open');
    assert.ok(seeded.every((e) => typeof e.data === 'object' && e.data !== null),
        'data should be parsed object, not JSON string');
    assert.ok(seeded.some((e) => e.data.start_flow_id === 'f1'),
        'parsed data should expose start_flow_id');
    assert.ok(seeded.every((e) => e.app_version === '4.17.0'));
    assert.ok(seeded.every((e) => e.brand_id === 'turbo_station'));
    // The Next.js RawMobileFunnelEvent reader looks INSIDE data — assert the
    // envelope-derived fields are hoisted there too, not just at top level.
    assert.ok(seeded.every((e) => e.data.app_version === '4.17.0'),
        'data.app_version should be hoisted from the column');
    assert.ok(seeded.every((e) => e.data.brand_id === 'turbo_station'),
        'data.brand_id should be hoisted from the column');
});

test('GET /api/telemetry/events filters by brand_id', async () => {
    const tag = 'evtbr-' + Date.now();
    const t0 = Date.now();
    // Seed two events under different brands
    await request(app)
        .post('/api/telemetry/mobile')
        .send({
            session_id: tag + '-turbo',
            device_id: 'd-' + tag + '-t',
            app_version: '4.17.0',
            platform: 'android',
            user_id: 'u-' + tag + '-t',
            brand_id: 'turbo_station',
            events: [{ event_type: 'start_charge_tap', timestamp: t0, data: {} }],
        });
    await request(app)
        .post('/api/telemetry/mobile')
        .send({
            session_id: tag + '-zev',
            device_id: 'd-' + tag + '-z',
            app_version: '4.17.0',
            platform: 'android',
            user_id: 'u-' + tag + '-z',
            brand_id: 'zev',
            events: [{ event_type: 'start_charge_tap', timestamp: t0, data: {} }],
        });

    const res = await request(app)
        .get(`/api/telemetry/events?start_ms=${t0 - 1000}&end_ms=${t0 + 5000}&event_types=start_charge_tap&brand_id=zev`)
        .set('X-Monitor-Secret', SECRET);

    assert.strictEqual(res.status, 200);
    const seeded = res.body.events.filter((e) => e.user_id && e.user_id.startsWith('u-' + tag));
    assert.strictEqual(seeded.length, 1, `expected only zev row, got ${seeded.length}`);
    assert.strictEqual(seeded[0].brand_id, 'zev');
});

test('GET /api/telemetry/events without brand filter returns all brands', async () => {
    const tag = 'evtany-' + Date.now();
    const t0 = Date.now();
    await request(app)
        .post('/api/telemetry/mobile')
        .send({
            session_id: tag + '-a',
            device_id: 'd-' + tag + '-a',
            app_version: '4.17.0',
            platform: 'android',
            user_id: 'u-' + tag + '-a',
            brand_id: 'turbo_station',
            events: [{ event_type: 'start_charge_tap', timestamp: t0, data: {} }],
        });
    await request(app)
        .post('/api/telemetry/mobile')
        .send({
            session_id: tag + '-b',
            device_id: 'd-' + tag + '-b',
            app_version: '4.17.0',
            platform: 'android',
            user_id: 'u-' + tag + '-b',
            brand_id: 'zev',
            events: [{ event_type: 'start_charge_tap', timestamp: t0, data: {} }],
        });

    const res = await request(app)
        .get(`/api/telemetry/events?start_ms=${t0 - 1000}&end_ms=${t0 + 5000}&event_types=start_charge_tap`)
        .set('X-Monitor-Secret', SECRET);

    assert.strictEqual(res.status, 200);
    const seeded = res.body.events.filter((e) => e.user_id && e.user_id.startsWith('u-' + tag));
    assert.strictEqual(seeded.length, 2, 'should return both brands when filter absent');
    const brands = new Set(seeded.map((e) => e.brand_id));
    assert.ok(brands.has('turbo_station') && brands.has('zev'));
});

test('GET /api/telemetry/events honors limit param', async () => {
    const tag = 'evtlim-' + Date.now();
    const t0 = Date.now();
    const events = Array.from({ length: 5 }, (_, i) => ({
        event_type: 'screen_open',
        timestamp: t0 + i,
        data: { i },
    }));
    await request(app)
        .post('/api/telemetry/mobile')
        .send({
            session_id: tag,
            device_id: 'd-' + tag,
            app_version: '4.17.0',
            platform: 'android',
            user_id: 'u-' + tag,
            events,
        });

    const res = await request(app)
        .get(`/api/telemetry/events?start_ms=${t0 - 1000}&end_ms=${t0 + 5000}&event_types=screen_open&limit=3`)
        .set('X-Monitor-Secret', SECRET);

    assert.strictEqual(res.status, 200);
    const seeded = res.body.events.filter((e) => e.user_id === 'u-' + tag);
    assert.ok(seeded.length <= 3, `expected <=3 events, got ${seeded.length}`);
});

// ── Original presence test continues ───────────────────────────────────────────

test('POST /api/telemetry/mobile — presence events get lat/lng stored', async () => {
    const sessionId = 'presence-test-' + Date.now();
    await request(app)
        .post('/api/telemetry/mobile')
        .send(makePayload({
            session_id: sessionId,
            events: [{
                event_type: 'app_presence_heartbeat',
                timestamp: Date.now(),
                data: { lat: -15.588, lng: -56.079, accuracy: 10, presence_id: 'p1' },
            }],
        }));

    const row = db.prepare(
        'SELECT data_json FROM mobile_events WHERE session_id = ? AND event_type = ?'
    ).get(sessionId, 'app_presence_heartbeat');

    assert.ok(row);
    const data = JSON.parse(row.data_json);
    assert.strictEqual(data.lat, -15.588);
    assert.strictEqual(data.lng, -56.079);
});

// ── User Log Dumps ──────────────────────────────────────────────────────────────

function makeLogDump(overrides = {}) {
    return {
        user_id: 'test-uid-logs',
        device_id: 'test-device-001',
        app_version: '2.0.0-test',
        platform: 'android',
        logs: {
            app_logs: [
                { timestamp: Date.now(), level: 'info', message: 'Test log entry 1' },
                { timestamp: Date.now(), level: 'error', message: 'Test error entry' },
            ],
            network_logs: [
                {
                    timestamp: Date.now(),
                    method: 'GET',
                    url: 'https://api.example.com/test',
                    status_code: 200,
                    duration_ms: 150,
                },
            ],
        },
        ...overrides,
    };
}

test('POST /api/telemetry/user-logs — valid payload → 202', async () => {
    const payload = makeLogDump();
    const res = await request(app)
        .post('/api/telemetry/user-logs')
        .send(payload);
    assert.strictEqual(res.status, 202);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.app_logs, 2);
    assert.strictEqual(res.body.network_logs, 1);
    assert.ok(typeof res.body.id === 'number');
});

test('POST /api/telemetry/user-logs — missing logs → 400', async () => {
    const res = await request(app)
        .post('/api/telemetry/user-logs')
        .send({ user_id: 'x', device_id: 'y' });
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.error.includes('logs'));
});

test('POST /api/telemetry/user-logs — empty logs object → 202', async () => {
    const res = await request(app)
        .post('/api/telemetry/user-logs')
        .send(makeLogDump({ logs: { app_logs: [], network_logs: [] } }));
    assert.strictEqual(res.status, 202);
    assert.strictEqual(res.body.app_logs, 0);
    assert.strictEqual(res.body.network_logs, 0);
});

test('POST /api/telemetry/user-logs — data persists in DB', async () => {
    const userId = 'persist-test-' + Date.now();
    await request(app)
        .post('/api/telemetry/user-logs')
        .send(makeLogDump({ user_id: userId }));

    const row = db.prepare(
        'SELECT * FROM user_log_dumps WHERE user_id = ?'
    ).get(userId);

    assert.ok(row, 'Row should exist in DB');
    assert.strictEqual(row.user_id, userId);
    assert.strictEqual(row.device_id, 'test-device-001');
    assert.strictEqual(row.platform, 'android');

    const logs = JSON.parse(row.logs_json);
    assert.strictEqual(logs.app_logs.length, 2);
    assert.strictEqual(logs.network_logs.length, 1);
});

test('GET /api/telemetry/user-logs without secret → 401', async () => {
    const res = await request(app).get('/api/telemetry/user-logs');
    assert.strictEqual(res.status, 401);
});

test('GET /api/telemetry/user-logs?user_id=X with secret → returns dumps', async () => {
    const userId = 'query-test-' + Date.now();

    // Insert two dumps for the same user
    await request(app)
        .post('/api/telemetry/user-logs')
        .send(makeLogDump({ user_id: userId }));
    await request(app)
        .post('/api/telemetry/user-logs')
        .send(makeLogDump({ user_id: userId }));

    const res = await request(app)
        .get(`/api/telemetry/user-logs?user_id=${userId}`)
        .set('X-Monitor-Secret', SECRET);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.user_id, userId);
    assert.strictEqual(res.body.count, 2);
    assert.ok(Array.isArray(res.body.dumps));
    assert.ok(res.body.dumps[0].logs, 'Dump should include parsed logs');
    assert.ok(res.body.dumps[0].logs.app_logs, 'Dump should include app_logs');
});

test('GET /api/telemetry/user-logs without user_id → returns summary list', async () => {
    const res = await request(app)
        .get('/api/telemetry/user-logs')
        .set('X-Monitor-Secret', SECRET);

    assert.strictEqual(res.status, 200);
    assert.ok(typeof res.body.count === 'number');
    assert.ok(Array.isArray(res.body.dumps));
    // Summary should not include full logs_json, just logs_size
    if (res.body.dumps.length > 0) {
        assert.ok(typeof res.body.dumps[0].logs_size === 'number');
        assert.strictEqual(res.body.dumps[0].logs, undefined);
    }
});

test('POST /api/telemetry/user-logs — auto-purges entries older than 3 days', async () => {
    const oldUserId = 'purge-test-old-' + Date.now();
    const fourDaysMs = 4 * 24 * 60 * 60 * 1000;

    // Manually insert an old entry
    db.prepare(
        `INSERT INTO user_log_dumps (received_at, user_id, device_id, app_version, platform, logs_json)
         VALUES (?, ?, ?, ?, ?, ?)`
    ).run(Date.now() - fourDaysMs, oldUserId, 'device', '1.0', 'android', '{"app_logs":[]}');

    // Verify it exists
    const before = db.prepare('SELECT * FROM user_log_dumps WHERE user_id = ?').get(oldUserId);
    assert.ok(before, 'Old entry should exist before purge');

    // POST triggers purge
    await request(app)
        .post('/api/telemetry/user-logs')
        .send(makeLogDump());

    // Old entry should be gone
    const after = db.prepare('SELECT * FROM user_log_dumps WHERE user_id = ?').get(oldUserId);
    assert.ok(!after, 'Old entry should be purged after POST');
});

// ─── 3. Unit Tests: DB resilience (busy_timeout + health-summary reconnect) ─────
//
// Regression coverage for the 2026-05-28 "database is locked" and 2026-06-05
// "cannot open vercel.db: directory does not exist" incidents.

test('lib/db — mobile.db connection sets a non-zero busy_timeout', () => {
    // Without this, a competing writer/reader on mobile.db (e.g. alert-engine's
    // 2-minute tick) can trip SQLITE_BUSY immediately instead of retrying.
    const [{ timeout }] = db.pragma('busy_timeout');
    assert.ok(timeout > 0, `Expected busy_timeout > 0, got ${timeout}`);
});

test('health-summary — createLazyConnection returns null (not throw) when the directory does not exist', () => {
    const { createLazyConnection } = require('../routes/health-summary');
    const missingPath = path.join(os.tmpdir(), `hs-test-missing-${Date.now()}`, 'vercel.db');
    const getConnection = createLazyConnection(missingPath, { retryIntervalMs: 0 });

    assert.strictEqual(getConnection(), null);
});

test('health-summary — createLazyConnection self-heals once the db becomes available', () => {
    const { createLazyConnection } = require('../routes/health-summary');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-test-'));
    const dbPath = path.join(dir, 'vercel.db');
    const getConnection = createLazyConnection(dbPath, { retryIntervalMs: 0 });

    // First attempt: file doesn't exist yet (simulates booting before
    // vercel-drain has created it) — should fail gracefully, not throw.
    assert.strictEqual(getConnection(), null);

    // Simulate vercel-drain creating the db after this process booted.
    const seed = new Database(dbPath);
    seed.exec('CREATE TABLE vercel_requests (endpoint TEXT, method TEXT, status_code INTEGER, last_ts INTEGER)');
    seed.close();

    // Next call retries (retryIntervalMs: 0 here) and should now connect.
    const conn = getConnection();
    assert.ok(conn, 'Expected connection to succeed once the db file exists');
    conn.close();

    fs.rmSync(dir, { recursive: true, force: true });
});

test('health-summary — createLazyConnection throttles retries to at most once per interval', () => {
    const { createLazyConnection } = require('../routes/health-summary');
    const dir = path.join(os.tmpdir(), `hs-test-throttle-${Date.now()}`);
    const dbPath = path.join(dir, 'vercel.db');
    const getConnection = createLazyConnection(dbPath, { retryIntervalMs: 60_000 });

    assert.strictEqual(getConnection(), null);

    // The db becomes available inside the retry window — the very next call
    // must not attempt to reconnect yet, so it should still report null.
    fs.mkdirSync(dir, { recursive: true });
    const seed = new Database(dbPath);
    seed.exec('CREATE TABLE vercel_requests (endpoint TEXT, method TEXT, status_code INTEGER, last_ts INTEGER)');
    seed.close();

    assert.strictEqual(getConnection(), null, 'Should not retry before retryIntervalMs elapses');

    fs.rmSync(dir, { recursive: true, force: true });
});

test('GET /api/telemetry/health-summary without secret → 401', async () => {
    const res = await request(app).get('/api/telemetry/health-summary');
    assert.strictEqual(res.status, 401);
});

test('GET /api/telemetry/health-summary with secret → 200 or graceful 503, never a crash', async () => {
    const res = await request(app)
        .get('/api/telemetry/health-summary')
        .set('X-Monitor-Secret', SECRET);

    // The real vercel.db may or may not be reachable in every environment this
    // suite runs in — either a working summary or a graceful 503 is fine.
    // A 500/crash is the regression this guards against.
    assert.ok([200, 503].includes(res.status), `Unexpected status ${res.status}`);
    if (res.status === 200) {
        assert.ok('statusMix' in res.body);
        assert.ok(Array.isArray(res.body.endpoints));
        assert.strictEqual(typeof res.body.windowMinutes, 'number');
    } else {
        assert.strictEqual(res.body.error, 'vercel.db unavailable');
    }
});

// ─── Cleanup + Run ──────────────────────────────────────────────────────────────

// Clean up test data after all tests
test._cleanup = () => {
    try {
        db.prepare("DELETE FROM mobile_events WHERE session_id LIKE 'test-%' OR session_id LIKE 'gzip-test-%' OR session_id LIKE 'db-check-%' OR session_id LIKE 'presence-test-%' OR session_id LIKE 'brand-env-%' OR session_id LIKE 'brand-evt-%' OR session_id LIKE 'brand-none-%' OR session_id LIKE 'evtq-%' OR session_id LIKE 'evtbr-%' OR session_id LIKE 'evtany-%' OR session_id LIKE 'evtlim-%'").run();
        db.prepare("DELETE FROM mobile_raw WHERE session_id LIKE 'test-%' OR session_id LIKE 'gzip-test-%' OR session_id LIKE 'db-check-%' OR session_id LIKE 'presence-test-%' OR session_id LIKE 'brand-env-%' OR session_id LIKE 'brand-evt-%' OR session_id LIKE 'brand-none-%' OR session_id LIKE 'evtq-%' OR session_id LIKE 'evtbr-%' OR session_id LIKE 'evtany-%' OR session_id LIKE 'evtlim-%'").run();
        db.prepare("DELETE FROM user_log_dumps WHERE user_id LIKE 'test-%' OR user_id LIKE 'persist-test-%' OR user_id LIKE 'query-test-%' OR user_id LIKE 'purge-test-%'").run();
        console.log('\n🧹 Test data cleaned up');
    } catch (err) {
        console.error('Cleanup error:', err.message);
    }
};

runAll().then(() => {
    test._cleanup();
    process.exit(failed > 0 ? 1 : 0);
}).catch((err) => {
    console.error('Test runner error:', err);
    process.exit(1);
});
