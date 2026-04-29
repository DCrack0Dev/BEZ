const axios = require('axios');

const jsonStr = `{
  "apiKey":"FXSK-DEFAULT-KEY-2025",
  "accountData":{
    "balance":1000.00,
    "equity":1000.00,
    "pnl_today":0.00,
    "margin":0.00,
    "freeMargin":1000.00,
    "accountId":12345,
    "eaSymbol":"XAUUSD",
    "price":2000.00000,
    "fastEMA":2000.00000,
    "slowEMA":2000.00000,
    "bbUpper":2000.00000,
    "bbLower":2000.00000
  },
  "chart":[
    {"x":1,"open":2000.0,"high":2001.0,"low":1999.0,"close":2000.5}
  ],
  "positions":[]
}`;

axios.post('http://localhost:5000/api/ea/update', JSON.parse(jsonStr))
  .then(res => console.log('Response:', res.data))
  .catch(err => console.error('Error:', err.message));