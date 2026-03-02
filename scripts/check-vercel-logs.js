#!/usr/bin/env node
const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'db', 'logs.db'));

console.log('📊 Vercel Logs in Database:\n');

// Count total Vercel logs
const count = db.prepare('SELECT COUNT(*) as total FROM logs WHERE source = ?').get('vercel');
console.log(`Total Vercel logs: ${count.total}`);

if (count.total > 0) {
  console.log('\n📝 Recent Vercel logs:\n');
  
  // Get recent logs
  const logs = db.prepare(`
    SELECT timestamp, endpoint, status_code, duration_ms, region, meta
    FROM logs 
    WHERE source = 'vercel'
    ORDER BY timestamp DESC 
    LIMIT 10
  `).all();
  
  logs.forEach((log, idx) => {
    const date = new Date(log.timestamp);
    const meta = JSON.parse(log.meta || '{}');
    
    console.log(`${idx + 1}. [${date.toISOString()}]`);
    console.log(`   Endpoint: ${log.endpoint || 'N/A'}`);
    console.log(`   Status: ${log.status_code || 'N/A'} | Duration: ${log.duration_ms || 'N/A'}ms | Region: ${log.region || 'N/A'}`);
    console.log(`   Method: ${meta.method || 'N/A'} | Type: ${meta.type || 'N/A'}`);
    if (meta.error) console.log(`   Error: ${meta.error}`);
    console.log('');
  });
}

db.close();
