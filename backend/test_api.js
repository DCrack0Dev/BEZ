const http = require('http');
const fs = require('fs');

const req = http.request({
  hostname: 'localhost',
  port: 5000,
  path: '/api/account',
  method: 'GET',
  headers: {
    'x-api-key': 'FXSK-DEFAULT-KEY-2025'
  }
}, res => {
  let data = '';
  res.on('data', chunk => { data += chunk; });
  res.on('end', () => {
    fs.writeFileSync('test_output.json', data);
    console.log('done');
  });
});

req.end();