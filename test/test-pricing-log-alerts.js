#!/usr/bin/env node
/**
 * Pricing log alert rules: [ADMISSION-TARIFF-FALLBACK] and [MARKET-PRICING-ALERT].
 *
 * Runs the real detectors against an in-memory vercel_logs fixture with the
 * drain's schema and indexes, and the real 1 h debounce (shouldSendAlert)
 * backed by an in-memory cache. No network, no files.
 */

const test = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const AlertEngine = require('../services/alert-engine');
const rules = require('../services/pricing-log-alerts');

const { QUERY_WINDOW } = AlertEngine;
const NOW = Date.UTC(2026, 10, 2, 18, 0, 0);

function createVercelDb() {
    const db = new Database(':memory:');
    // Same table + indexes as services/vercel-drain.js.
    db.exec(`
        CREATE TABLE vercel_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp INTEGER NOT NULL,
            event_id TEXT, log_type TEXT, endpoint TEXT, method TEXT,
            status_code INTEGER, duration_ms INTEGER, region TEXT, level TEXT,
            request_id TEXT, body TEXT, meta TEXT
        );
        CREATE INDEX idx_vercel_logs_timestamp ON vercel_logs(timestamp);
        CREATE INDEX idx_vercel_logs_endpoint_ts ON vercel_logs(endpoint, timestamp);
        CREATE INDEX idx_vercel_logs_status_ts ON vercel_logs(status_code, timestamp);
        CREATE INDEX idx_vercel_logs_request_id ON vercel_logs(request_id);
    `);
    return db;
}

function insertLog(db, { timestamp = NOW - 60_000, body, endpoint = '/api/charging/start', status = 202 }) {
    db.prepare(
        'INSERT INTO vercel_logs (timestamp, endpoint, method, status_code, level, body) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(timestamp, endpoint, 'POST', status, 'warning', body);
}

function fallbackLine(stationId, reason = 'market_catalog_expired', extra = {}) {
    return `${rules.ADMISSION_FALLBACK_TAG} ${JSON.stringify({
        stationId, reason, fallbackPrice: 1.99, route: '/api/charging/start', ...extra,
    })}`;
}

/** Engine double: real detectors + real debounce, in-memory state only. */
function createEngine(db) {
    const engine = Object.create(AlertEngine.prototype);
    engine.vercelDb = db;
    engine.debounceCache = {};
    engine.saveDebounceCache = () => {};
    engine.stationLookup = (id) => (id === 'AR2510070008' ? { name: 'Posto Centro' } : null);
    return engine;
}

/** Pretend `ms` passed since every debounce entry was written. */
function ageDebounce(engine, ms) {
    for (const key of Object.keys(engine.debounceCache)) engine.debounceCache[key] -= ms;
}

test('fallback tag → one critical alert with stations, counts and reasons', () => {
    const db = createVercelDb();
    insertLog(db, { body: fallbackLine('AR2510070008') });
    insertLog(db, { body: fallbackLine('AR2510070008', 'catalog_unreadable') });
    insertLog(db, { body: fallbackLine('AR2510070008') });
    insertLog(db, { body: fallbackLine('GUTS2606030001') });
    insertLog(db, { body: 'GET /api/stations 200', status: 200 });

    const alerts = createEngine(db).detectAdmissionTariffFallback(NOW);

    assert.strictEqual(alerts.length, 1);
    const [a] = alerts;
    assert.strictEqual(a.type, 'admission_tariff_fallback');
    assert.strictEqual(a.severity, 'critical');
    assert.strictEqual(a.urgentCopy, true);
    assert.strictEqual(a.count, 4);
    assert.deepStrictEqual(a.station_ids, ['AR2510070008', 'GUTS2606030001']);
    assert.match(a.description, /4 início\(s\) de recarga admitido\(s\) com preço de fallback/);
    assert.match(a.description, /- Posto Centro \(AR2510070008\): 3x · motivo: market_catalog_expired \(2x\), catalog_unreadable \(1x\) · nova/);
    assert.match(a.description, /- GUTS2606030001: 1x · motivo: market_catalog_expired \(1x\) · nova/);
    assert.match(a.description, /Preço de fallback: R\$ 1,99 \(4x\) por kWh/);
    assert.match(a.description, /Ação: verificar catálogo de preços \/ rota-api \/ cron market-pricing/);
});

test('same station within the 1 h cooldown → no new alert', () => {
    const db = createVercelDb();
    const engine = createEngine(db);
    insertLog(db, { body: fallbackLine('AR2510070008') });
    assert.strictEqual(engine.detectAdmissionTariffFallback(NOW).length, 1);

    ageDebounce(engine, 30 * 60 * 1000);
    insertLog(db, { timestamp: NOW - 10_000, body: fallbackLine('AR2510070008') });
    assert.deepStrictEqual(engine.detectAdmissionTariffFallback(NOW), []);
});

test('same station after the cooldown → alerts again', () => {
    const db = createVercelDb();
    const engine = createEngine(db);
    insertLog(db, { body: fallbackLine('AR2510070008') });
    assert.strictEqual(engine.detectAdmissionTariffFallback(NOW).length, 1);

    ageDebounce(engine, 61 * 60 * 1000);
    assert.strictEqual(engine.detectAdmissionTariffFallback(NOW).length, 1);
});

test('new station while another is in cooldown → alerts at once, marks only the new one', () => {
    const db = createVercelDb();
    const engine = createEngine(db);
    insertLog(db, { body: fallbackLine('AR2510070008') });
    assert.strictEqual(engine.detectAdmissionTariffFallback(NOW).length, 1);

    ageDebounce(engine, 2 * 60 * 1000);
    insertLog(db, { timestamp: NOW - 5_000, body: fallbackLine('GUTS2606030001') });
    const alerts = engine.detectAdmissionTariffFallback(NOW);

    assert.strictEqual(alerts.length, 1);
    assert.deepStrictEqual(alerts[0].new_station_ids, ['GUTS2606030001']);
    assert.match(alerts[0].description, /- GUTS2606030001: 1x · motivo: market_catalog_expired \(1x\) · nova/);
    // The station in cooldown is still listed (full picture), without the marker.
    assert.match(alerts[0].description, /- Posto Centro \(AR2510070008\): 1x · motivo: market_catalog_expired \(1x\)\\n/);
});

test('no tag in the window → nothing; tagged rows older than the window are ignored', () => {
    const db = createVercelDb();
    insertLog(db, { body: 'POST /api/charging/start status=202', status: 202 });
    insertLog(db, { body: 'admission tariff fallback without the bracket tag' });
    insertLog(db, { timestamp: NOW - QUERY_WINDOW - 1, body: fallbackLine('AR2510070008') });
    insertLog(db, { timestamp: NOW + 1, body: fallbackLine('AR2510070008') });
    const engine = createEngine(db);

    assert.deepStrictEqual(engine.detectAdmissionTariffFallback(NOW), []);
    assert.deepStrictEqual(engine.detectMarketPricingAlerts(NOW), []);
    assert.deepStrictEqual(engine.debounceCache, {}, 'no cooldown consumed without a match');
});

test('PII in the log body never reaches the message', () => {
    const db = createVercelDb();
    const uid = 'D6yxkRCfOJZc8WBlCG13QEoO7Zl1';
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJl';
    insertLog(db, {
        body: fallbackLine('AR2510070008', `catalog expired for maria.silva@example.com uid=${uid}`, {
            userId: uid, email: 'maria.silva@example.com', phone: '+55 61 99876-5432', token: jwt,
        }),
    });
    insertLog(db, {
        body: `${rules.ADMISSION_FALLBACK_TAG} stationId=GUTS2606030001 reason="lookup by ${uid} tel +5561998765432" ` +
            `route=/api/users/${uid}/charge?email=maria.silva@example.com Authorization: Bearer ${jwt}`,
    });
    insertLog(db, {
        body: `${rules.MARKET_PRICING_TAG} kind=catalog_expiring catalog expires 2026-11-02 in 4h; ` +
            `last edit by joao@example.com user_id=${uid} phone 61 99876-5432 token ${jwt}`,
    });
    const engine = createEngine(db);
    const alerts = [...engine.detectAdmissionTariffFallback(NOW), ...engine.detectMarketPricingAlerts(NOW)];
    assert.strictEqual(alerts.length, 2);

    for (const alert of alerts) {
        const message = engine.formatAlertMessage(alert);
        for (const secret of ['maria.silva', 'example.com', 'joao@', uid, 'eyJ', '99876', '998765432', 'Bearer ey']) {
            assert.ok(!message.includes(secret), `message leaked "${secret}":\n${message}`);
        }
    }
    const [fallback, market] = alerts;
    assert.match(fallback.description, /\/api\/users\/\[id\]\/charge/, 'route keeps its shape, drops the uid and query');
    assert.match(market.description, /2026-11-02/, 'calendar dates survive redaction');
});

test('query stays bounded by the timestamp index', () => {
    const db = createVercelDb();
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${rules.TAGGED_LOG_QUERY}`)
        .all(NOW - QUERY_WINDOW, NOW, rules.ADMISSION_FALLBACK_TAG, rules.TAGGED_LOG_ROW_LIMIT)
        .map((r) => r.detail)
        .join(' | ');
    assert.match(plan, /SEARCH vercel_logs USING INDEX idx_vercel_logs_timestamp \(timestamp>\? AND timestamp<\?\)/, plan);
    assert.doesNotMatch(plan, /SCAN vercel_logs/, plan);

    const calls = [];
    const spyDb = { prepare: (sql) => ({ all: (...params) => { calls.push({ sql, params }); return []; } }) };
    const engine = createEngine(spyDb);
    engine.detectAdmissionTariffFallback(NOW);
    engine.detectMarketPricingAlerts(NOW);
    assert.deepStrictEqual(calls.map((c) => c.params), [
        [NOW - QUERY_WINDOW, NOW, rules.ADMISSION_FALLBACK_TAG, rules.TAGGED_LOG_ROW_LIMIT],
        [NOW - QUERY_WINDOW, NOW, rules.MARKET_PRICING_TAG, rules.TAGGED_LOG_ROW_LIMIT],
    ]);
    for (const { sql } of calls) {
        assert.match(sql, /timestamp > \?\s+AND timestamp <= \?/);
        assert.doesNotMatch(sql, /LIKE/i);
    }
    assert.throws(() => rules.queryTaggedVercelLogs(spyDb, rules.MARKET_PRICING_TAG, undefined, NOW), /finite timestamp range/);
});

test('market-pricing tag → one alert per kind, 1 h cooldown per kind, summary truncated', () => {
    const db = createVercelDb();
    const engine = createEngine(db);
    insertLog(db, { body: `${rules.MARKET_PRICING_TAG} {"kind":"daily_apply_rejected","message":"daily apply rejected 42 of 42 station prices"}` });
    insertLog(db, { body: `${rules.MARKET_PRICING_TAG} catalog expires in 3.5h (expiresAt=2026-11-02T21:30:00Z)` });
    insertLog(db, { body: `${rules.MARKET_PRICING_TAG} catalog expires in 3.4h ${'x'.repeat(600)}` });

    const alerts = engine.detectMarketPricingAlerts(NOW);
    const byKind = Object.fromEntries(alerts.map((a) => [a.kind, a]));
    assert.deepStrictEqual(Object.keys(byKind).sort(), ['catalog_expiring', 'daily_apply_rejected']);
    assert.strictEqual(byKind.daily_apply_rejected.severity, 'critical');
    assert.strictEqual(byKind.daily_apply_rejected.urgentCopy, true);
    assert.match(byKind.daily_apply_rejected.description, /aplicação diária rejeitou todos os preços \(1x/);
    assert.match(byKind.daily_apply_rejected.description, /Log: daily apply rejected 42 of 42 station prices/);
    assert.strictEqual(byKind.catalog_expiring.count, 2);
    const logLine = byKind.catalog_expiring.description.split('\\n').find((l) => l.startsWith('Log: '));
    assert.ok(Array.from(logLine.slice(5)).length <= 300, 'summary capped at 300 chars');

    // Same kinds again within the hour → silent; a new kind still alerts.
    ageDebounce(engine, 20 * 60 * 1000);
    insertLog(db, { timestamp: NOW - 1_000, body: `${rules.MARKET_PRICING_TAG} watchdog fallback price expired` });
    const again = engine.detectMarketPricingAlerts(NOW);
    assert.deepStrictEqual(again.map((a) => a.kind), ['watchdog_fallback_expired']);
});

test('kind inference covers the four pipeline problems', () => {
    assert.strictEqual(rules.inferMarketPricingKind('daily apply rejected all prices'), 'daily_apply_rejected');
    assert.strictEqual(rules.inferMarketPricingKind('catalog expires in 5h'), 'catalog_expiring');
    assert.strictEqual(rules.inferMarketPricingKind('catalog unreadable: failed to read doc'), 'catalog_unreadable');
    assert.strictEqual(rules.inferMarketPricingKind('watchdog fallback expired'), 'watchdog_fallback_expired');
    assert.strictEqual(rules.inferMarketPricingKind('something else'), 'other');
});

test('runDetection sends pricing alerts to the normal group and copies them to URGENTE', async () => {
    const db = createVercelDb();
    insertLog(db, { timestamp: Date.now() - 30_000, body: fallbackLine('AR2510070008') });
    const engine = createEngine(db);
    for (const name of ['detectIngestStalls', 'detectVercel5xxErrors', 'detectVercelTimeouts', 'detectHighLatency',
        'detectChargerFaults', 'detectOcppVercelCorrelation', 'detectMarketPricingAlerts']) {
        engine[name] = () => [];
    }
    const sent = { normal: [], urgent: [] };
    engine.retryUnsentAlerts = async () => {};
    engine.saveAlert = () => 1;
    engine.recordWaMessageId = () => {};
    engine.markAlertSent = () => {};
    engine.dispatchAlert = async (message) => { sent.normal.push(message); return { sent: true, waMessageId: 'm1' }; };
    engine.sendUrgentWhatsappAlert = async (message) => { sent.urgent.push(message); return true; };

    await engine.runDetection();

    assert.strictEqual(sent.normal.length, 1);
    assert.deepStrictEqual(sent.urgent, sent.normal);
    assert.match(sent.normal[0], /^🔴 \*URGENTE: recargas admitidas com preço de fallback\*/);
});
