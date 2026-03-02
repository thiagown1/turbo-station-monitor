#!/usr/bin/env node

// Simula o cenário real: GO2508130004 Faulted → Available

const StateTracker = require('./state-tracker');
const tracker = new StateTracker();

console.log('🧪 Simulando Cenário Real: GO2508130004\n');

// Passo 1: Carregador entra em Faulted (23:08)
console.log('📋 Passo 1: Carregador FAULTED (23:08)');
tracker.updateCharger('GO2508130004', {
    status: 'Faulted',
    lastFaultReason: 'Status: Faulted (error: OverCurrentFailure) [vendor: 02,40,120,0]',
    lastHeartbeat: new Date('2026-02-12T02:08:00Z').toISOString(),
    consecutiveErrors: 0
});

console.log('  status:', tracker.chargers['GO2508130004'].status);
console.log('  lastFaultReason:', tracker.chargers['GO2508130004'].lastFaultReason);
console.log('  needsRestart:', tracker.chargers['GO2508130004'].needsRestart);

// Passo 2: Carregador se recupera (02:57)
console.log('\n📋 Passo 2: Carregador RECUPERADO (02:57)');
tracker.updateCharger('GO2508130004', {
    status: 'Available',
    lastHeartbeat: new Date('2026-02-12T05:57:00Z').toISOString(),
    consecutiveErrors: 0
});

console.log('  status:', tracker.chargers['GO2508130004'].status);
console.log('  needsRestart:', tracker.chargers['GO2508130004'].needsRestart);
console.log('  lastFaultReason (preserved):', tracker.chargers['GO2508130004'].lastFaultReason);

console.log('\n✅ Teste completo');
console.log('\n📝 Alertas esperados:');
console.log('  1. 🔴 Carregador em FALHA (23:08) - com detalhes do erro');
console.log('  2. ✅ Carregador RECUPERADO (02:57) - mostrando de qual problema se recuperou');
