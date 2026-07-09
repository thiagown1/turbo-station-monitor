const http = require('http');

const req = http.request({
  hostname: 'localhost',
  port: 3005,
  path: '/api/support/test-runner/run',
  method: 'POST',
  headers: { 'Content-Type': 'application/json' }
}, res => {
  res.on('data', d => process.stdout.write(d));
});
req.write('{}');
req.end();
