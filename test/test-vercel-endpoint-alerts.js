#!/usr/bin/env node

const assert = require('assert');
const AlertEngine = require('../services/alert-engine');
const {
    normalizeEndpoint,
    groupByNormalizedEndpoint,
    getVercel5xxAlertPolicy,
} = AlertEngine;

const variants = [
    '/api/ocpp-logs/history?charger_id=A&start_time=2026-08-13T20%3A00%3A00',
    '/api/ocpp-logs/history?charger_id=B&start_time=2026-08-13T20%3A01%3A00',
    'https://app.turbostation.com.br/api/ocpp-logs/history?charger_id=C',
];

assert.deepStrictEqual(
    variants.map(normalizeEndpoint),
    Array(3).fill('/api/ocpp-logs/history'),
    'query strings and absolute URLs must collapse to one route',
);

const grouped = groupByNormalizedEndpoint(variants.map((endpoint, id) => ({ id, endpoint })));
assert.deepStrictEqual(Object.keys(grouped), ['/api/ocpp-logs/history']);
assert.strictEqual(grouped['/api/ocpp-logs/history'].length, 3);

assert.deepStrictEqual(getVercel5xxAlertPolicy('/api/ocpp-logs/history', 1), {
    shouldAlert: false,
    severity: 'warning',
    title: 'Instabilidade no serviço de logs',
});
assert.strictEqual(getVercel5xxAlertPolicy('/api/ocpp-logs/history', 3).shouldAlert, true);
assert.deepStrictEqual(getVercel5xxAlertPolicy('/api/payments/process', 1), {
    shouldAlert: true,
    severity: 'critical',
    title: null,
});

const telemetryRows = [
    { id: 101, endpoint: '/api/monitor/heatmap-data?period=7d', status_code: 504 },
    { id: 102, endpoint: '/api/monitor/online-users', status_code: 504 },
];
const telemetryGrouped = groupByNormalizedEndpoint(telemetryRows);
assert.deepStrictEqual(Object.keys(telemetryGrouped), ['/api/monitor/mobile-telemetry']);
assert.strictEqual(telemetryGrouped['/api/monitor/mobile-telemetry'].length, 2);
assert.deepStrictEqual(getVercel5xxAlertPolicy('/api/monitor/mobile-telemetry', 1), {
    shouldAlert: true,
    severity: 'warning',
    title: 'Instabilidade na telemetria móvel',
});

const rows = variants.map((endpoint, index) => ({
    id: index + 1,
    timestamp: Date.now() - index,
    endpoint,
    status_code: 504,
    duration_ms: 10_000,
    meta: null,
}));
const debounceKeys = [];
const fakeEngine = {
    vercelDb: { prepare: () => ({ all: () => rows }) },
    shouldSendAlert: (type, key) => {
        debounceKeys.push([type, key]);
        return true;
    },
};
const alerts = AlertEngine.prototype.detectVercel5xxErrors.call(fakeEngine);

assert.strictEqual(alerts.length, 1);
assert.strictEqual(alerts[0].endpoint, '/api/ocpp-logs/history');
assert.strictEqual(alerts[0].severity, 'warning');
assert.strictEqual(alerts[0].count, 3);
assert.deepStrictEqual(debounceKeys, [['vercel_5xx', '/api/ocpp-logs/history']]);

console.log('✅ Vercel endpoint alert normalization tests passed');
