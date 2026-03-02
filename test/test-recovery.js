#!/usr/bin/env node

const StateTracker = require('./state-tracker');

const tracker = new StateTracker();

console.log('🧪 Testing Charger Recovery Logic\n');

// Test Case 1: Charger flagged, then receives heartbeat (recovery)
console.log('📋 Test 1: Charger recovery via recent heartbeat');
const testId1 = 'TEST_RECOVERY_1';

// First, flag it for restart
tracker.updateCharger(testId1, {
    lastHeartbeat: new Date(Date.now() - 10 * 60 * 1000).toISOString(), // 10 min ago
    consecutiveErrors: 5,
    status: 'Faulted'
});
console.log(`   Before: needsRestart = ${tracker.chargers[testId1].needsRestart}`);

// Now simulate recovery: recent heartbeat
tracker.updateCharger(testId1, {
    lastHeartbeat: new Date(Date.now() - 30 * 1000).toISOString(), // 30s ago
    consecutiveErrors: 0,
    status: 'Available'
});
console.log(`   After recovery: needsRestart = ${tracker.chargers[testId1].needsRestart}`);
console.log(`   Expected: false ✅\n`);

// Test Case 2: Recovery via MeterValues
console.log('📋 Test 2: Charger recovery via recent MeterValues');
const testId2 = 'TEST_RECOVERY_2';

tracker.updateCharger(testId2, {
    lastHeartbeat: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    consecutiveErrors: 4,
    status: 'Faulted'
});
console.log(`   Before: needsRestart = ${tracker.chargers[testId2].needsRestart}`);

tracker.updateCharger(testId2, {
    lastMeterValue: new Date(Date.now() - 1 * 60 * 1000).toISOString(), // 1 min ago
    consecutiveErrors: 0
});
console.log(`   After MeterValues: needsRestart = ${tracker.chargers[testId2].needsRestart}`);
console.log(`   Expected: false ✅\n`);

// Test Case 3: Recovery via healthy status
console.log('📋 Test 3: Charger recovery via healthy status change');
const testId3 = 'TEST_RECOVERY_3';

tracker.updateCharger(testId3, {
    status: 'Faulted',
    consecutiveErrors: 3
});
console.log(`   Before: needsRestart = ${tracker.chargers[testId3].needsRestart}, status = ${tracker.chargers[testId3].status}`);

tracker.updateCharger(testId3, {
    status: 'Available',
    consecutiveErrors: 0,
    lastHeartbeat: new Date(Date.now() - 30 * 1000).toISOString()
});
console.log(`   After status change: needsRestart = ${tracker.chargers[testId3].needsRestart}, status = ${tracker.chargers[testId3].status}`);
console.log(`   Expected: false ✅\n`);

// Test Case 4: Still broken (no recovery signals)
console.log('📋 Test 4: Charger still broken (no recovery)');
const testId4 = 'TEST_NO_RECOVERY';

tracker.updateCharger(testId4, {
    lastHeartbeat: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    consecutiveErrors: 5,
    status: 'Faulted'
});
console.log(`   Flagged: needsRestart = ${tracker.chargers[testId4].needsRestart}`);

// Update but still old data
tracker.updateCharger(testId4, {
    lastHeartbeat: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    status: 'Faulted'
});
console.log(`   Still broken: needsRestart = ${tracker.chargers[testId4].needsRestart}`);
console.log(`   Expected: true ✅\n`);

console.log('✅ All recovery tests complete');
