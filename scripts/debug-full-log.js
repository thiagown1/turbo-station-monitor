const Database = require('better-sqlite3');
const db = new Database('./db/logs.db');

// Get one full row to see all fields
const log = db.prepare('SELECT * FROM logs WHERE source = ? LIMIT 1').get('vercel');

console.log('📊 Full Vercel log entry:\n');
console.log(JSON.stringify(log, null, 2));

db.close();
