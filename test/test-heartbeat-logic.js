#!/usr/bin/env node

const StateTracker = require('./state-tracker');

const tracker = new StateTracker();

console.log('🧪 Testing Heartbeat Timeout Logic with MeterValues\n');

// Test Case 1: Heartbeat timeout, NO transaction, NO MeterValues
console.log('📋 Test 1: Heartbeat timeout WITHOUT transaction and WITHOUT MeterValues');
const testId1 = 'TEST001';
tracker.updateCharger(testId1, {
    lastHeartbeat: new Date(Date.now() - 10 * 60 * 1000).toISOString(), // 10 minutes ago
    lastMeterValue: null,
    activeTransaction: null
});

tracker.checkRestartCondition(testId1);
console.log(`   needsRestart: ${tracker.chargers[testId1].needsRestart}`);
console.log(`   restartReason: ${tracker.chargers[testId1].restartReason}`);
console.log(`   Expected: needsRestart = true ✅\n`);

// Test Case 2: Heartbeat timeout, WITH active transaction
console.log('📋 Test 2: Heartbeat timeout WITH active transaction');
const testId2 = 'TEST002';
tracker.updateCharger(testId2, {
    lastHeartbeat: new Date(Date.now() - 10 * 60 * 1000).toISOString(), // 10 minutes ago
    lastMeterValue: null,
    activeTransaction: '12345'
});

tracker.checkRestartCondition(testId2);
console.log(`   needsRestart: ${tracker.chargers[testId2].needsRestart}`);
console.log(`   restartReason: ${tracker.chargers[testId2].restartReason}`);
console.log(`   Expected: needsRestart = false ✅\n`);

// Test Case 3: Heartbeat timeout, but RECENT MeterValues
console.log('📋 Test 3: Heartbeat timeout but RECENT MeterValues (2min ago)');
const testId3 = 'TEST003';
tracker.updateCharger(testId3, {
    lastHeartbeat: new Date(Date.now() - 10 * 60 * 1000).toISOString(), // 10 minutes ago
    lastMeterValue: new Date(Date.now() - 2 * 60 * 1000).toISOString(), // 2 minutes ago
    activeTransaction: null
});

tracker.checkRestartCondition(testId3);
console.log(`   needsRestart: ${tracker.chargers[testId3].needsRestart}`);
console.log(`   restartReason: ${tracker.chargers[testId3].restartReason}`);
console.log(`   Expected: needsRestart = false ✅\n`);

// Test Case 4: Heartbeat timeout, OLD MeterValues (also old)
console.log('📋 Test 4: Heartbeat timeout AND old MeterValues (10min ago)');
const testId4 = 'TEST004';
tracker.updateCharger(testId4, {
    lastHeartbeat: new Date(Date.now() - 10 * 60 * 1000).toISOString(), // 10 minutes ago
    lastMeterValue: new Date(Date.now() - 10 * 60 * 1000).toISOString(), // 10 minutes ago
    activeTransaction: null
});

tracker.checkRestartCondition(testId4);
console.log(`   needsRestart: ${tracker.chargers[testId4].needsRestart}`);
console.log(`   restartReason: ${tracker.chargers[testId4].restartReason}`);
console.log(`   Expected: needsRestart = true ✅\n`);

// Test Case 5: Recent heartbeat (no timeout)
console.log('📋 Test 5: Recent heartbeat (no timeout)');
const testId5 = 'TEST005';
tracker.updateCharger(testId5, {
    lastHeartbeat: new Date(Date.now() - 2 * 60 * 1000).toISOString(), // 2 minutes ago
    lastMeterValue: null,
    activeTransaction: null
});

tracker.checkRestartCondition(testId5);
console.log(`   needsRestart: ${tracker.chargers[testId5].needsRestart}`);
console.log(`   restartReason: ${tracker.chargers[testId5].restartReason}`);
console.log(`   Expected: needsRestart = false ✅\n`);

console.log('✅ All tests complete');
