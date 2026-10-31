# Browse 批次評分腳本模板

Phase 2 Step 2b 用此腳本透過 `/browse` daemon 批次查詢所有 POI 的 Google 評分。

## 腳本模板

```js
const { execSync } = require('child_process');
const B = process.env.BROWSE_BIN || (process.env.HOME || process.env.USERPROFILE) + '/.claude/skills/gstack/browse/dist/browse';

const queries = [
  // [搜尋關鍵字, entryId or null, poiId or null]
  ['景點名稱+地區', 'entryId', null],
  ['餐廳名稱+地區', null, 'poiId'],
];

(async () => {
  for (const [query, eid, pid] of queries) {
    execSync(`"${B}" goto "https://www.google.com/maps/search/${encodeURIComponent(query)}"`, { timeout: 10000 });
    await new Promise(r => setTimeout(r, 1500));
    const text = execSync(`"${B}" text`, { timeout: 10000, encoding: 'utf8' });
    const matches = text.match(/(\d\.\d)/g);
    let rating = null;
    if (matches) for (const m of matches) {
      const n = parseFloat(m);
      if (n >= 1.0 && n <= 5.0) { rating = n; break; }
    }
    console.log(`${query} → ${rating || 'not found'}`);
  }
})();
```

## 使用方式

1. 從 Step 2a 收集的 POI 清單填入 `queries` 陣列
2. 執行腳本收集評分
3. Step 2c 依結果分兩類 PATCH：
   - **entry 評分**：`PATCH /api/trips/{tripId}/entries/{eid}` Body: `{ google_rating: X.X }`
   - **POI 評分**（餐廳/商店）：`PATCH /api/pois/{poiId}` Body: `{ rating: X.X }`（migration 0045 後 pois 表欄位為 `rating`）
4. 用 `Promise.all` 批次 PATCH 所有評分
