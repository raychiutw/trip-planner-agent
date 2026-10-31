# API Helper 模板

Phase 1 第一步在 `/tmp/api-helper.js` 建立共用 helper，後續所有 API 呼叫都透過它。

```js
const https = require('https');
const TRIP_ID = '{tripId}';  // Phase 0 產生後填入
const BASE = 'trip-planner-dby.pages.dev';
const HEADERS = {
  'Authorization': process.env.TRIPLINE_API_TOKEN,
  'Authorization': process.env.TRIPLINE_API_TOKEN,
  'Content-Type': 'application/json',
  'Origin': 'https://trip-planner-dby.pages.dev',
};
function apiCall(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const req = https.request({
      hostname: BASE, path, method,
      headers: { ...HEADERS, 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(b); } });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
module.exports = { apiCall, TRIP_ID };
```

呼叫前先 `export $(grep TRIPLINE_API_TOKEN .env.local | xargs)`，再 `node -e "..."` 引用 helper。
