#!/usr/bin/env node
// Cria o schema do banco SQLite

const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, 'db', 'logs.db');
const db = new Database(dbPath);

console.log('Criando schema do banco de dados...');

// Tabela principal de logs
db.exec(`
  CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL,
    source TEXT NOT NULL CHECK(source IN ('ocpp', 'vercel')),
    
    -- OCPP fields
    charger_id TEXT,
    event_type TEXT,
    
    -- Vercel fields
    endpoint TEXT,
    status_code INTEGER,
    duration_ms INTEGER,
    region TEXT,
    
    -- Metadados flexíveis (JSON compacto)
    meta TEXT
  );
`);

// Índices otimizados
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_timestamp ON logs(timestamp DESC);
  CREATE INDEX IF NOT EXISTS idx_source ON logs(source);
  CREATE INDEX IF NOT EXISTS idx_charger ON logs(charger_id) WHERE charger_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_errors ON logs(status_code) WHERE status_code >= 400;
  CREATE INDEX IF NOT EXISTS idx_endpoint ON logs(endpoint) WHERE endpoint IS NOT NULL;
`);

// Tabela de alertas
db.exec(`
  CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at INTEGER NOT NULL,
    charger_id TEXT,
    severity TEXT CHECK(severity IN ('critical', 'warning', 'info')),
    title TEXT NOT NULL,
    description TEXT,
    ocpp_log_ids TEXT,
    vercel_log_ids TEXT,
    sent BOOLEAN DEFAULT 0,
    sent_at INTEGER
  );
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_alerts_ts ON alerts(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_alerts_sent ON alerts(sent);
`);

// Verificar schema
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log('\n✅ Tabelas criadas:');
tables.forEach(t => console.log(`  - ${t.name}`));

const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all();
console.log('\n✅ Índices criados:');
indexes.forEach(i => console.log(`  - ${i.name}`));

// Stats
const info = db.prepare("SELECT COUNT(*) as count FROM logs").get();
console.log(`\n📊 Logs no banco: ${info.count}`);

db.close();
console.log('\n✅ Banco criado com sucesso: db/logs.db');
