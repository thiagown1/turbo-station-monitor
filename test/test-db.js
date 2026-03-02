#!/usr/bin/env node
// Testa inserção e query no SQLite

const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, 'db', 'logs.db');
const db = new Database(dbPath);

console.log('Testando inserção de logs...\n');

// Teste 1: Log OCPP
const insertOCPP = db.prepare(`
  INSERT INTO logs (timestamp, source, charger_id, event_type, meta)
  VALUES (?, ?, ?, ?, ?)
`);

const ocppTimestamp = Math.floor(Date.now() / 1000);
insertOCPP.run(
  ocppTimestamp,
  'ocpp',
  'AR2510070008',
  'StatusNotification',
  JSON.stringify({ status: 'Available', connectorId: 1 })
);
console.log('✅ Log OCPP inserido');

// Teste 2: Log Vercel
const insertVercel = db.prepare(`
  INSERT INTO logs (timestamp, source, endpoint, status_code, duration_ms, region, meta)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const vercelTimestamp = Math.floor(Date.now() / 1000);
insertVercel.run(
  vercelTimestamp,
  'vercel',
  '/api/webhook/status-notification',
  200,
  392,
  'iad1',
  JSON.stringify({ requestId: 'test-123', invocationId: 'inv-456' })
);
console.log('✅ Log Vercel inserido');

// Query: Buscar logs inseridos
console.log('\n📊 Últimos logs inseridos:');
const logs = db.prepare('SELECT * FROM logs ORDER BY timestamp DESC LIMIT 5').all();
logs.forEach(log => {
  console.log(`  - [${log.source}] ${log.charger_id || log.endpoint} @ ${new Date(log.timestamp * 1000).toISOString()}`);
});

// Query: Contar por source
console.log('\n📈 Logs por fonte:');
const stats = db.prepare('SELECT source, COUNT(*) as count FROM logs GROUP BY source').all();
stats.forEach(s => console.log(`  - ${s.source}: ${s.count}`));

// Performance test: Batch insert
console.log('\n⚡ Teste de performance (1000 inserções em batch)...');
const start = Date.now();

const insert = db.prepare('INSERT INTO logs (timestamp, source, charger_id, event_type) VALUES (?, ?, ?, ?)');
const insertMany = db.transaction((logs) => {
  for (const log of logs) {
    insert.run(log.timestamp, log.source, log.charger_id, log.event_type);
  }
});

const testLogs = Array.from({ length: 1000 }, (_, i) => ({
  timestamp: Math.floor(Date.now() / 1000) + i,
  source: 'ocpp',
  charger_id: `TEST${i}`,
  event_type: 'Heartbeat'
}));

insertMany(testLogs);
const duration = Date.now() - start;
console.log(`✅ 1000 logs inseridos em ${duration}ms (${Math.round(1000/duration*1000)} inserts/s)`);

// Cleanup test data
db.prepare("DELETE FROM logs WHERE charger_id LIKE 'TEST%'").run();
console.log('\n🧹 Dados de teste removidos');

const finalCount = db.prepare('SELECT COUNT(*) as count FROM logs').get();
console.log(`\n📊 Total de logs no banco: ${finalCount.count}`);

db.close();
console.log('\n✅ Teste completo!');
