#!/usr/bin/env node
/**
 * Regression test for WhatsApp delivery confirmation + unsent-alert retry
 * (2026-07-18, follow-up to the 2026-07-16 cable-theft investigation).
 *
 * A 2xx from POST /api/support/conversations/{conv}/messages only means the
 * message was QUEUED — Evolution fires async and delivery_status can flip to
 * 'failed' (e.g. instance disconnected). The engine used to mark sent=1 on the
 * 2xx and never retried, silently losing alerts. Now it must:
 *   - only mark sent after polling the conversation and seeing delivery_status='sent'
 *   - keep unconfirmed/failed alerts at sent=0
 *   - retry recent (<30min) unsent alerts each tick, late-confirming a stored
 *     wa_message_id first so slow deliveries don't duplicate in the group
 */

process.env.SUPPORT_API_SECRET = 'test-secret';
process.env.WHATSAPP_DELIVERY_POLL_MS = '1,1,1'; // keep polls fast in tests
delete process.env.ALERT_TELEGRAM_GROUP; // telegram disabled (prod default)

const assert = require('assert');
const Database = require('better-sqlite3');
const AlertEngine = require('../services/alert-engine');

const CONV = 'conv_jiuijxjtmnet23i9'; // module default ALERT_WHATSAPP_CONV

// ---------------------------------------------------------------------------
// fetch stub: routes by HTTP method, records every call.
// ---------------------------------------------------------------------------
let fetchCalls = [];
function stubFetch({ post, get }) {
    fetchCalls = [];
    global.fetch = async (url, opts = {}) => {
        const method = (opts.method || 'GET').toUpperCase();
        fetchCalls.push({ url, method });
        const handler = method === 'POST' ? post : get;
        const resp = typeof handler === 'function' ? handler(fetchCalls) : handler;
        return {
            ok: resp.status >= 200 && resp.status < 300,
            status: resp.status,
            json: async () => resp.json,
        };
    };
}
const posts = () => fetchCalls.filter(c => c.method === 'POST');
const gets = () => fetchCalls.filter(c => c.method === 'GET');

// Engine instance without the constructor (no live DBs opened).
function bareEngine() {
    return Object.create(AlertEngine.prototype);
}

// Engine with a real in-memory alerts DB (schema via the real initAlertsSchema).
function dbEngine() {
    const engine = bareEngine();
    engine.alertsDb = new Database(':memory:');
    engine.initAlertsSchema();
    engine.formatAlertMessage = () => 'formatted-alert-message';
    return engine;
}

function insertAlert(engine, { createdAt = Date.now(), sent = 0, waMessageId = null } = {}) {
    const info = engine.alertsDb
        .prepare(`INSERT INTO alerts (created_at, severity, title, sent, wa_message_id) VALUES (?, 'warning', 'test alert', ?, ?)`)
        .run(createdAt, sent, waMessageId);
    return info.lastInsertRowid;
}

function alertRow(engine, id) {
    return engine.alertsDb.prepare('SELECT * FROM alerts WHERE id = ?').get(id);
}

const checks = [];
function check(name, fn) {
    checks.push([name, fn]);
}

// ---------------------------------------------------------------------------
// sendWhatsappAlert — confirmation semantics
// ---------------------------------------------------------------------------

check('delivered=true only after the GET shows delivery_status=sent', async () => {
    stubFetch({
        post: { status: 200, json: { id: 'msg_1' } },
        get: { status: 200, json: { messages: [{ id: 'msg_1', delivery_status: 'sent' }] } },
    });
    const r = await bareEngine().sendWhatsappAlert('hello');
    assert.deepStrictEqual(r, { delivered: true, messageId: 'msg_1' });
    assert.strictEqual(posts().length, 1);
    assert.ok(gets().length >= 1, 'must poll for delivery');
});

check('delivered=false when delivery_status=failed (messageId kept for late-confirm)', async () => {
    stubFetch({
        post: { status: 200, json: { id: 'msg_2' } },
        get: { status: 200, json: { messages: [{ id: 'msg_2', delivery_status: 'failed' }] } },
    });
    const r = await bareEngine().sendWhatsappAlert('hello');
    assert.deepStrictEqual(r, { delivered: false, messageId: 'msg_2' });
});

check('delivered=false when status stays pending through the whole poll window', async () => {
    stubFetch({
        post: { status: 200, json: { id: 'msg_3' } },
        get: { status: 200, json: { messages: [{ id: 'msg_3', delivery_status: 'pending' }] } },
    });
    const r = await bareEngine().sendWhatsappAlert('hello');
    assert.deepStrictEqual(r, { delivered: false, messageId: 'msg_3' });
    assert.strictEqual(gets().length, 3, 'one GET per WHATSAPP_DELIVERY_POLL_MS entry');
});

check('POST failure → delivered=false, no delivery polling', async () => {
    stubFetch({ post: { status: 503, json: null }, get: { status: 200, json: { messages: [] } } });
    const r = await bareEngine().sendWhatsappAlert('hello');
    assert.deepStrictEqual(r, { delivered: false, messageId: null });
    assert.strictEqual(gets().length, 0);
});

check('2xx without a message id is treated as unconfirmed (no blind trust)', async () => {
    stubFetch({ post: { status: 200, json: {} }, get: { status: 200, json: { messages: [] } } });
    const r = await bareEngine().sendWhatsappAlert('hello');
    assert.deepStrictEqual(r, { delivered: false, messageId: null });
    assert.strictEqual(gets().length, 0);
});

check('dispatchAlert reports sent=false + propagates waMessageId when unconfirmed', async () => {
    stubFetch({
        post: { status: 200, json: { id: 'msg_4' } },
        get: { status: 200, json: { messages: [{ id: 'msg_4', delivery_status: 'pending' }] } },
    });
    const r = await bareEngine().dispatchAlert('hello');
    assert.deepStrictEqual(r, { sent: false, waMessageId: 'msg_4' });
});

// ---------------------------------------------------------------------------
// Schema migration
// ---------------------------------------------------------------------------

check('initAlertsSchema adds wa_message_id to a pre-existing old-schema DB', async () => {
    const engine = bareEngine();
    engine.alertsDb = new Database(':memory:');
    engine.alertsDb.exec(`
        CREATE TABLE alerts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at INTEGER NOT NULL,
            charger_id TEXT,
            severity TEXT,
            title TEXT NOT NULL,
            description TEXT,
            ocpp_log_ids TEXT,
            vercel_log_ids TEXT,
            evidence_json TEXT,
            sent BOOLEAN DEFAULT 0,
            sent_at INTEGER
        );
    `);
    engine.initAlertsSchema();
    const cols = engine.alertsDb.prepare('PRAGMA table_info(alerts)').all().map(r => r.name);
    assert.ok(cols.includes('wa_message_id'), 'migration must add wa_message_id');
});

// ---------------------------------------------------------------------------
// retryUnsentAlerts
// ---------------------------------------------------------------------------

check('retry late-confirms a stored wa_message_id without re-sending', async () => {
    const engine = dbEngine();
    const id = insertAlert(engine, { waMessageId: 'msg_old' });
    stubFetch({
        post: { status: 200, json: { id: 'msg_should_not_happen' } },
        get: { status: 200, json: { messages: [{ id: 'msg_old', delivery_status: 'sent' }] } },
    });
    await engine.retryUnsentAlerts();
    const row = alertRow(engine, id);
    assert.strictEqual(row.sent, 1, 'late-confirmed alert marked sent');
    assert.strictEqual(posts().length, 0, 'no duplicate message posted');
});

check('retry re-sends when the earlier message actually failed', async () => {
    const engine = dbEngine();
    const id = insertAlert(engine, { waMessageId: 'msg_failed' });
    stubFetch({
        post: { status: 200, json: { id: 'msg_retry' } },
        get: (calls) => {
            // Before the re-POST: report the old message as failed. After it:
            // confirm the new message as sent.
            const posted = calls.some(c => c.method === 'POST');
            return posted
                ? { status: 200, json: { messages: [{ id: 'msg_retry', delivery_status: 'sent' }] } }
                : { status: 200, json: { messages: [{ id: 'msg_failed', delivery_status: 'failed' }] } };
        },
    });
    await engine.retryUnsentAlerts();
    const row = alertRow(engine, id);
    assert.strictEqual(posts().length, 1, 'one re-send');
    assert.strictEqual(row.sent, 1);
    assert.strictEqual(row.wa_message_id, 'msg_retry', 'new message id recorded');
});

check('retry re-sends an alert that never had a wa_message_id', async () => {
    const engine = dbEngine();
    const id = insertAlert(engine);
    stubFetch({
        post: { status: 200, json: { id: 'msg_fresh' } },
        get: { status: 200, json: { messages: [{ id: 'msg_fresh', delivery_status: 'sent' }] } },
    });
    await engine.retryUnsentAlerts();
    const row = alertRow(engine, id);
    assert.strictEqual(posts().length, 1);
    assert.strictEqual(row.sent, 1);
    assert.strictEqual(row.wa_message_id, 'msg_fresh');
});

check('an unconfirmed retry stays sent=0 (retried again next tick)', async () => {
    const engine = dbEngine();
    const id = insertAlert(engine);
    stubFetch({
        post: { status: 200, json: { id: 'msg_pending' } },
        get: { status: 200, json: { messages: [{ id: 'msg_pending', delivery_status: 'pending' }] } },
    });
    await engine.retryUnsentAlerts();
    const row = alertRow(engine, id);
    assert.strictEqual(row.sent, 0);
    assert.strictEqual(row.wa_message_id, 'msg_pending', 'id recorded for late-confirm next tick');
});

check('alerts older than the 30min retry window are left alone', async () => {
    const engine = dbEngine();
    const id = insertAlert(engine, {
        createdAt: Date.now() - (AlertEngine.UNSENT_RETRY_WINDOW_MS + 60 * 1000),
    });
    stubFetch({
        post: { status: 200, json: { id: 'msg_stale' } },
        get: { status: 200, json: { messages: [] } },
    });
    await engine.retryUnsentAlerts();
    assert.strictEqual(fetchCalls.length, 0, 'no network traffic for stale alerts');
    assert.strictEqual(alertRow(engine, id).sent, 0);
});

check('already-sent alerts are never retried', async () => {
    const engine = dbEngine();
    insertAlert(engine, { sent: 1 });
    stubFetch({
        post: { status: 200, json: { id: 'x' } },
        get: { status: 200, json: { messages: [] } },
    });
    await engine.retryUnsentAlerts();
    assert.strictEqual(fetchCalls.length, 0);
});

// ---------------------------------------------------------------------------

(async () => {
    console.log('🧪 WhatsApp delivery confirmation + retry\n');
    let failures = 0;
    for (const [name, fn] of checks) {
        try {
            await fn();
            console.log(`  ✅ ${name}`);
        } catch (e) {
            failures++;
            console.error(`  ❌ ${name}: ${e.message}`);
        }
    }
    console.log(`\n${failures === 0 ? '✅ All checks passed' : `❌ ${failures} check(s) failed`}`);
    process.exit(failures === 0 ? 0 : 1);
})();
