---
name: tp-search-strategies
description: POI 搜尋策略內部參考 — rating / hours / phone / business_status / website / reservation / location / address 的查詢方式。不直接 invoke，被 tp-create、tp-edit、tp-patch 引用。
user-invocable: false
---

# 行程資料策略參考

Event type schema（各類型物件必填欄位）見 `references/event-schema.md`。

## 第一原則：用 backend enrich endpoint，不爬網頁

**v2.23.0 (migration 0051) 之後，POI 補資料統一透過 `POST /api/pois/{id}/enrich`。** Backend 直接打 Google Place Details API（API Routes v1）拿 rating / address / phone / hours / business_status，COALESCE 寫進 pois 表。

不要 `/browse` 爬 Google Maps 詳情頁，不要 WebSearch 摘要拼湊 — 兩者都比 backend Place Details 取得的資料粗糙（Google Maps 對未登入訪客限制 hours，WebSearch 結果聚合多 source 不一致）。

完整呼叫流程見 `references/poi-spec.md` §「POI 補資料策略」。

## 前置步驟：POI 存在驗證（鐵律）

新增或更新 POI 前，必須通過存在驗證。查不到 = 無效 POI，不得新增或保留。

**驗證流程：**

1. **`GET /api/poi-search?q=POI 名稱 城市&region=JP|TW|KR&limit=20`** → 回傳 results array（含 place_id、name、formatted_address、location）
2. 確認 results 有匹配項（place_id 必填）
3. 找到 → 用 `findOrCreatePoi` 建 pois 行 + 寫 place_id；接著 `POST /api/pois/{id}/enrich` 補完整欄位
4. 找不到 → 判定無效：
   - **新增場景**（tp-create/tp-edit/tp-request）→ **不新增**，替換為 Google Maps 上可查到的真實店家
   - **既有 POI**（tp-patch/tp-rebuild）→ 既有 POI 的 enrich 會自動把 status 設成 'missing'；觸發歇業偵測清理（見 `tp-shared/references/modify-steps.md §5`）

## Field Sources（透過 enrich endpoint 取得）

下表列出每個欄位的 source（Place Details API 哪個 field）。Skill 不直接呼叫 Google API；資訊只供 debug + 補資料判斷用。

### rating

- 適用：hotel / restaurant / shopping / attraction / activity / gasStation
- Source: Place Details `rating`（1.0-5.0，userRatingCount 補強信心度）
- 寫入：`pois.rating`（v2.19.x migration 0045 col rename 為 `rating`）
- 找不到 → 不填 NULL（行政區、街道等 generic POI 沒 rating）

### hours（營業時間 + 公休日）

- 適用：restaurant / shopping / attraction / activity / parking / transport
- Source: Place Details `regularOpeningHours.weekdayDescriptions`（array of "星期一: 11:00 – 14:30, 17:00 – 22:00" 全週）
- 寫入：`pois.hours`（v2.29.0 後 `trip_pois` 整表 DROPPED，純 pois master — migration 0055 早已 drop trip_pois.hours col，0062 又 drop 整表）
- **公休日**：weekday_descriptions 自動含「星期X: 休息」格式，不需另外處理
- 24h / 全年無休 → "24 時間営業" / "全年無休"

### phone

- 適用：hotel / restaurant / shopping / attraction / activity
- Source: Place Details `internationalPhoneNumber`（E.164 `+81-XX-XXXX-XXXX`）
- 寫入：`pois.phone`

### website

- 適用：hotel / restaurant / shopping / attraction / activity
- Source: Place Details `websiteUri`
- 寫入：`pois.website`（必須 `http://` / `https://` 開頭）

### address

- 適用：所有 type
- Source: Place Details `formattedAddress`
- 寫入：`pois.address`（含完整縣市區段）

### business_status

- 適用：所有 type
- Source: Place Details `businessStatus`
  - `OPERATIONAL` → `pois.status='active'`
  - `CLOSED_PERMANENTLY` → `pois.status='closed' + status_reason='永久歇業'`
  - `CLOSED_TEMPORARILY` → 仍 `status='active'`（暫時性不警告）
  - 404 → `pois.status='missing' + status_reason='Google Maps 查無資料'`
- 寫入：`pois.status` + `pois.status_reason`
- `closed` 或 `missing` 觸發歇業清理（見 modify-steps.md §5）

### location（lat/lng）

- 適用：所有 type
- Source: Place Details `location.latitude` / `location.longitude`（4 位小數）
- 寫入：`pois.lat` / `pois.lng`
- 同步 entry 用：trip_entries.location 仍是獨立 JSON（含 googleQuery / appleQuery），但 lat/lng 應跟 pois 一致。v2.30.15: mapcode 已從 pois 整段 DROP，不再寫入。

### reservation（餐廳專屬，非 Place Details 欄位）

- 適用：restaurant
- Source: WebSearch（Place Details 沒提供 reservation status）
  1. 搜尋 `{name} 予約 tabelog`
  2. 搜尋 `{name} hotpepper 予約`
  3. 搜尋 `{name} TableCheck`
  4. 搜尋 `{name} 予約 公式サイト`
- 寫入：`trip_entry_pois.reservation`（entry-level metadata，v2.29.0 後從 `trip_pois` 遷到 `trip_entry_pois`）+ `reservation_url`
  - 有預約頁面 → `available: "yes"` + method/url
  - 電話預約 → `method: "phone"`
  - 不可預約 → `available: "no"`
  - 找不到 → `available: "unknown"`
- 搜尋 `{name} 人気 予約` 判斷 `recommended: true/false`

驗證：available 三選一 / method 搭配 url 或 phone / recommended boolean

## 範例：補單一 POI 缺漏欄位

```bash
TOKEN=$(cat /tmp/admin-token.txt)  # OAuth client_credentials admin scope
POI_ID=458

# 1. 確認 POI 有 place_id（沒 place_id 不能 enrich）
npx wrangler d1 execute trip-planner-db --remote --command \
  "SELECT id, name, place_id FROM pois WHERE id = $POI_ID" --json

# 2. 若沒 place_id：先 search
curl -s -G -H "Authorization: Bearer $TOKEN" \
  --data-urlencode "q=花織そば 沖縄" \
  "https://trip-planner-dby.pages.dev/api/poi-search"
# → 拿到 place_id，PATCH 寫回 pois.place_id

# 3. enrich
curl -s -X POST -H "Authorization: Bearer $TOKEN" \
  "https://trip-planner-dby.pages.dev/api/pois/$POI_ID/enrich"
# → 自動寫 rating/address/phone/hours/business_status
```

## 範例：批次補多筆

```bash
TOKEN=$(cat /tmp/admin-token.txt)

# 取得需 enrich 的 POI（有 place_id + active + 缺漏 hours/address/phone）
PIDS=$(npx wrangler d1 execute trip-planner-db --remote --command "
  SELECT id FROM pois
  WHERE place_id IS NOT NULL AND status='active'
    AND (hours IS NULL OR address IS NULL OR phone IS NULL)
" --json | grep -oE '"id":\s*[0-9]+' | grep -oE '[0-9]+')

for pid in $PIDS; do
  curl -s -X POST -H "Authorization: Bearer $TOKEN" \
    "https://trip-planner-dby.pages.dev/api/pois/$pid/enrich" \
    | grep -oE '"status":"[^"]*"'
  sleep 0.6  # rate limit
done
```

## Anti-patterns

| ❌ Anti-pattern | ✅ 正確做法 |
|---|---|
| `/browse goto google.com/maps/search/...` 抓 raw text | `POST /api/pois/:id/enrich` |
| WebSearch「POI 名稱 営業時間」拼湊 hours | 同上 |
| LLM 直接呼叫 Google Place Details API | 同上（透過 backend 統一 quota / key 管理） |
| `PATCH /pois/:id` 手動寫 rating/hours/phone | enrich 自動處理（除非用戶 explicit override） |
| `PATCH /trip-pois/:tpid` 寫任何欄位 | v2.29.0 整個 endpoint 已刪除（`trip_pois` 表 DROPPED）— 改 `PATCH /api/pois/:id` 或 `POST /api/pois/:id/enrich`（客觀屬性），entry-level metadata 改透過 `POST /entries/:eid/alternates`（建立時）|

完整 schema + endpoint reference 見 `references/poi-spec.md`。
