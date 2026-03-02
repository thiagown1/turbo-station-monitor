const Database = require('better-sqlite3');
const db = new Database('./db/logs.db');

const logs = db.prepare('SELECT meta FROM logs WHERE source = ? LIMIT 5').all('vercel');

console.log('📄 Raw metadata from Vercel logs:\n');
logs.forEach((log, i) => {
  console.log(`Log ${i + 1}:`);
  console.log(log.meta);
  console.log('---\n');
});

db.close();
