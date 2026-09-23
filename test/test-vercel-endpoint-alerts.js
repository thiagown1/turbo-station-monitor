#!/usr/bin/env node

const assert = require('assert');
const AlertEngine = require('../services/alert-engine');
const {
    normalizeEndpoint,
    groupByNormalizedEndpoint,
    getVercel5xxAlertPolicy,
    collapseOpaqueIds,
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

// Record ids in the path are one problem, not one problem per record: without
// collapsing them the 1h debounce never closes and every station alerts alone.
const stationVariants = [
    '/api/stations/AR2510070008/pricing-impact?from=2026-09-01&to=2026-09-16',
    '/api/stations/AR2506170006/pricing-impact?from=2026-09-09&to=2026-09-15',
    '/api/stations/TSAC2606080001/pricing-impact?from=2026-09-05&to=2026-09-15',
    '/api/stations/124030001957/pricing-impact?from=2026-07-01&to=2026-07-31',
];
const stationGrouped = groupByNormalizedEndpoint(
    stationVariants.map((endpoint, id) => ({ id, endpoint })),
);
assert.deepStrictEqual(Object.keys(stationGrouped), ['/api/stations/:id/pricing-impact']);
assert.strictEqual(stationGrouped['/api/stations/:id/pricing-impact'].length, 4);

assert.strictEqual(collapseOpaqueIds('/api/users/v1eSTsW7QvU8yZw4DnKeZHtqOpz1'), '/api/users/:id');
assert.strictEqual(
    collapseOpaqueIds('/api/x/521126c4-a847-4126-9f0a-5d53b0c4f8ca'),
    '/api/x/:id',
);

// Route names must survive: collapsing two different routes would hide an incident.
for (const route of [
    '/api/payments/process',
    '/api/ocpp-logs/history',
    '/api/monitor/mobile-telemetry',
    '/api/cron/market-pricing-watchdog',
    '/api/stations/accessible',
    '/api/auth/resolve-brand-account',
    '/api/brands/turbo_station',
    '/api/users/me/theme',
    '/api/webhook/status-notification',
    '/api/blog/quanto-custa-carregar-carro-eletrico-em-posto-publico',
]) {
    assert.strictEqual(collapseOpaqueIds(route), route, `route must not collapse: ${route}`);
}

// The telemetry alias is resolved before id collapsing and must still win.
assert.deepStrictEqual(
    Object.keys(groupByNormalizedEndpoint([{ id: 1, endpoint: '/api/monitor/heatmap-data?period=7d' }])),
    ['/api/monitor/mobile-telemetry'],
);

// Distinct routes stay distinct even when both carry ids.
assert.notStrictEqual(
    collapseOpaqueIds('/api/stations/AR2510070008/pricing-impact'),
    collapseOpaqueIds('/api/stations/AR2510070008/metrics'),
);

assert.strictEqual(collapseOpaqueIds(null), '');
assert.strictEqual(collapseOpaqueIds(undefined), '');

console.log('✅ Vercel endpoint alert normalization tests passed');
