#!/usr/bin/env node
/**
 * Test Vercel Drain Webhook
 * 
 * Sends sample NDJSON payloads to the webhook to verify it's working
 */

const http = require('http');

const PORT = process.env.PORT || 3001;
const HOST = process.env.HOST || 'localhost';

// Sample Vercel log entries (NDJSON format)
const sampleLogs = [
  // Valid request - should be saved
  {
    timestamp: new Date().getTime(),
    type: 'request',
    requestId: 'req_123abc',
    requestPath: '/api/ocpp/webhook',
    requestMethod: 'POST',
    responseStatusCode: 200,
    requestDuration: 145,
    region: 'iad1',
    requestUserAgent: 'OCPP-Client/1.6',
    requestIp: '203.0.113.42'
  },
  
  // 308 redirect - should be filtered
  {
    timestamp: new Date().getTime(),
    type: 'request',
    requestId: 'req_456def',
    requestPath: '/',
    requestMethod: 'GET',
    responseStatusCode: 308,
    requestDuration: 5,
    region: 'iad1'
  },
  
  // Favicon - should be filtered
  {
    timestamp: new Date().getTime(),
    type: 'request',
    requestId: 'req_789ghi',
    requestPath: '/favicon.ico',
    requestMethod: 'GET',
    responseStatusCode: 200,
    requestDuration: 10,
    region: 'iad1',
    requestUserAgent: 'vercel-favicon/1.0'
  },
  
  // Error 500 - should be saved
  {
    timestamp: new Date().getTime(),
    type: 'request',
    requestId: 'req_error',
    requestPath: '/api/charging/start',
    requestMethod: 'POST',
    responseStatusCode: 500,
    requestDuration: 2500,
    region: 'iad1',
    error: 'Database connection failed',
    message: 'Internal server error'
  },
  
  // Middleware log - should be filtered
  {
    timestamp: new Date().getTime(),
    type: 'middleware',
    requestId: 'req_mid',
    message: 'Middleware executed',
    region: 'iad1'
  },
  
  // High latency - should be saved
  {
    timestamp: new Date().getTime(),
    type: 'request',
    requestId: 'req_slow',
    requestPath: '/api/data',
    requestMethod: 'GET',
    responseStatusCode: 200,
    requestDuration: 3500,
    region: 'sfo1',
    memory: 256000000,
    cpu: 85
  }
];

// Convert to NDJSON format
const ndjsonPayload = sampleLogs.map(log => JSON.stringify(log)).join('\n');

console.log('[test] Sending test payload to vercel-drain webhook...');
console.log(`[test] Target: http://${HOST}:${PORT}/vercel-drain`);
console.log(`[test] Total logs: ${sampleLogs.length}`);
console.log(`[test] Expected saved: 3 (valid request, error 500, slow request)`);
console.log(`[test] Expected filtered: 3 (308, favicon, middleware)`);
console.log('');

const options = {
  hostname: HOST,
  port: PORT,
  path: '/vercel-drain',
  method: 'POST',
  headers: {
    'Content-Type': 'application/x-ndjson',
    'Content-Length': Buffer.byteLength(ndjsonPayload)
  }
};

const req = http.request(options, (res) => {
  let data = '';
  
  res.on('data', (chunk) => {
    data += chunk;
  });
  
  res.on('end', () => {
    console.log(`[test] Response status: ${res.statusCode}`);
    
    try {
      const response = JSON.parse(data);
      console.log('[test] Response:', JSON.stringify(response, null, 2));
      
      if (response.success) {
        console.log('');
        console.log('✅ Test passed!');
        console.log(`   - Received: ${response.received}`);
        console.log(`   - Saved: ${response.saved}`);
        console.log(`   - Filtered: ${response.filtered}`);
        
        if (response.saved === 3 && response.filtered === 3) {
          console.log('   - Filter logic working correctly! ✨');
        } else {
          console.log('   - ⚠️  Filter counts don\'t match expected values');
        }
      } else {
        console.log('❌ Test failed:', response);
      }
    } catch (err) {
      console.error('[test] Failed to parse response:', err.message);
      console.error('[test] Raw response:', data);
    }
  });
});

req.on('error', (err) => {
  console.error('❌ Request failed:', err.message);
  console.error('   Make sure vercel-drain service is running:');
  console.error(`   pm2 start ecosystem.config.js --only vercel-drain`);
  console.error(`   OR: node vercel-drain.js`);
});

req.write(ndjsonPayload);
req.end();
