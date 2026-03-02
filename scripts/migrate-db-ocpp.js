#!/usr/bin/env node
// Migrate DB: add OCPP-specific columns and indexes for persistent OCPP event storage

const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, 'db', 'logs.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

console.log('🔧 Migrando banco para suportar logs OCPP persistentes...\n');

// Add new columns for OCPP events (if not exist)
const columns = db.prepare('PRAGMA table_info(logs)').all().map(c => c.name);

const migrations = [
    { col: 'severity', type: 'TEXT', desc: 'Severidade do evento (info/warning/error/critical)' },
    { col: 'category', type: 'TEXT', desc: 'Categoria do evento OCPP (transaction_start, charger_faulted, etc)' },
    { col: 'logger', type: 'TEXT', desc: 'Logger OCPP (charger_XXXXX)' },
    { col: 'message', type: 'TEXT', desc: 'Mensagem completa do evento OCPP' },
];

migrations.forEach(m => {
    if (!columns.includes(m.col)) {
        db.prepare(`ALTER TABLE logs ADD COLUMN ${m.col} TEXT`).run();
        console.log(`  ✅ Coluna '${m.col}' adicionada — ${m.desc}`);
    } else {
        console.log(`  ⏭️  Coluna '${m.col}' já existe`);
    }
});

// Add indexes for OCPP queries
const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map(i => i.name);

const newIndexes = [
    { name: 'idx_category', sql: 'CREATE INDEX IF NOT EXISTS idx_category ON logs(category) WHERE category IS NOT NULL' },
    { name: 'idx_severity', sql: 'CREATE INDEX IF NOT EXISTS idx_severity ON logs(severity) WHERE severity IS NOT NULL' },
    { name: 'idx_source_ts', sql: 'CREATE INDEX IF NOT EXISTS idx_source_ts ON logs(source, timestamp DESC)' },
    { name: 'idx_charger_ts', sql: 'CREATE INDEX IF NOT EXISTS idx_charger_ts ON logs(charger_id, timestamp DESC) WHERE charger_id IS NOT NULL' },
];

newIndexes.forEach(idx => {
    db.prepare(idx.sql).run();
    console.log(`  ✅ Index '${idx.name}' criado`);
});

// Stats
const total = db.prepare('SELECT COUNT(*) as c FROM logs').get().c;
const ocpp = db.prepare("SELECT COUNT(*) as c FROM logs WHERE source = 'ocpp'").get().c;
const vercel = db.prepare("SELECT COUNT(*) as c FROM logs WHERE source = 'vercel'").get().c;

console.log(`\n📊 Estado do banco:`);
console.log(`   Total: ${total} registros`);
console.log(`   Vercel: ${vercel}`);
console.log(`   OCPP: ${ocpp}`);
console.log(`\n✅ Migração concluída!`);

db.close();
