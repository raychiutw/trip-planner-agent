# POI 欄位規格與查詢策略

## POI 欄位規格

### findOrCreatePoi 支援的完整欄位

pois 表欄位（id, type, name, description, note, address, phone, email, website, hours, rating, price, category, lat, lng, country, source, place_id, status, status_reason, status_checked_at, last_refreshed_at, created_at, updated_at），API `PUT /days/:num` 的 `findOrCreatePoi` 全部支援。v2.30.15 (migration 0066)：mapcode col 已 DROP。
`PATCH /pois/:id`（admin 或帶 tripId 的有權限使用者）也支援所有欄位。

> ⚠️ Migration 0045 (v2.19.x) 把 `pois.google_rating` 重命名為 `pois.rating`。新 code 一律用 `rating`；frontend `entry.googleRating` 是 mapDay 從 `poi.rating` 接出的 alias，DB 端不存在 `google_rating` col。

### 各 type 必填 / 建議欄位

> ⚠️ **v2.29.0 (migration 0060-0062)**：`trip_pois` 整表 DROPPED。所有 POI 資料現在分兩處：
> - **`pois`（master）** — 客觀屬性（rating / hours / price / address / phone / place_id / hours / status）
> - **`trip_entry_pois`（junction, entry × poi M:N）** — entry-level metadata（description / note / reservation / reservation_url）。`sort_order=1` 是 master，`sort_order > 1` 是 alternate
> - **`trip_days.hotel_poi_id`（FK → pois）** — 飯店（每 day 一筆，透過 PUT /days/:num 寫入）
> - 舊欄位 `checkout / breakfast_included / breakfast_note / must_buy / context / sort_order(top-level)` 全部 DROPPED

**pois master（PATCH /pois/:id 可修改）：**

| type | 必填 | 建議填 |
|------|------|--------|
| hotel | name, rating | description, address, phone, hours |
| restaurant | name, category, hours, rating | description, phone, address, **price** |
| shopping | name, category, hours, rating | description, phone, address |
| parking | name, description | hours |
| attraction | name, rating | description, hours, address, phone |
| transport | name | description, hours |
| activity | name, rating, hours | description, phone, website |

> ⚠️ **客觀屬性 (hours / price / rating / address / phone / hours)** 一律寫 `pois` master。新增 POI 走 `findOrCreatePoi` 自動寫；既有 POI 補資料走 `POST /api/pois/{id}/enrich`（首選），或 `PATCH /api/pois/{id}` 手動覆寫。

**trip_entry_pois override（entry-level metadata）：**

| 欄位 | 寫入路徑 | 說明 |
|------|---------|------|
| description | POST /entries/:eid/trip-pois \| POST /alternates | entry-level POI 描述（覆蓋 pois.description）|
| note | 同上 | 該 entry 上此 POI 的 per-POI 備註（`trip_entry_pois.note`） |
| reservation | 同上 | 餐廳預訂號 / 連結 |
| reservation_url | 同上 | 預訂頁面 URL |
| sort_order | 自動 assign（max + 1 = alternate）| 1 = master，> 1 = alternate；改 master 走 `PATCH /entries/:eid/master`、重排走 `PATCH /entries/:eid/alternates/reorder` |

> ⚠️ **v2.29.0 後沒有 PATCH /trip-pois/:tpid 這個 endpoint。** 更新 alternate metadata（description / note / reservation）目前需 DELETE + POST 重建 — 若有需要可加 PATCH endpoint。

pois.type 允許值：`hotel`, `restaurant`, `shopping`, `parking`, `attraction`, `transport`, `activity`, `other`（v2.1.2.0+ 納入 `activity`）

### Entry × POI canonical 結構（v2.29.0）

每個 timeline entry 透過 `trip_entry_pois` junction table 掛 1 個 master (sort_order=1) + N 個 alternates (sort_order > 1)。

- 建 entry + 第一個 POI：`POST /api/trips/:id/days/:num/entries`（body 扁平帶 `name` + `poi_type` 等，建 entry 同時建/找 master POI；見下表）
- 後續加 POI 到既有 entry：`POST /api/trips/:id/entries/:eid/trip-pois`（legacy name kept；backend 寫 trip_entry_pois as alternate）或 `POST /api/trips/:id/entries/:eid/alternates`
- 變更 master：`PATCH /api/trips/:id/entries/:eid/master` body `{ poiId, entryPoisVersion? }`
- 從搜尋結果 find-or-create master：`PUT /api/trips/:id/entries/:eid/poi-id` body `{ name, lat, lng, ... }`
- 刪 alternate：`DELETE /api/trips/:id/entries/:eid/alternates/:poiId?entryPoisVersion=N`
- 重排 alternates：`PATCH /api/trips/:id/entries/:eid/alternates/reorder` body `{ order: [poiId, poiId, ...], entryPoisVersion? }`

OCC token `entryPoisVersion`（integer counter on `trip_entries.entry_pois_version`，migration 0058）— mutating endpoint 都接受並 bump；GET 也回。Cross-tab swap mismatch → `409 STALE_ENTRY`，client refetch。

### 資料所有權

- `pois` = AI 維護的 master（rating / address / hours / phone / price 等客觀資訊）
- `trip_entry_pois` = entry-level metadata（description / note / reservation / reservation_url）— 同 POI 在不同 entry 可有不同筆記
- `trip_days.hotel_poi_id` = 飯店 FK，描述性欄位（checkout / breakfast 已 DROP，restaurants 餐廳 description 改 entry-level）

### API 操作端點

| 操作 | 端點 | 說明 |
|------|------|------|
| 新增 entry | `POST /api/trips/{id}/days/{dayNum}/entries` | 必填 `name`（扁平欄位，即 master POI 名稱）；選填 `poi_type`（hotel/restaurant/shopping/parking/attraction/transport/activity/other，預設 attraction）、`start_time`/`end_time`（HH:MM，或 legacy `time`）、`description`、`note`、`lat`/`lng`、`rating`、`sort_order`（省略 append 到最後）。**沒有 `title`、沒有巢狀 `poi: {...}`**。新 POI 無 `place_id` → enrich 會 400，須先 `PATCH /api/pois/{id}`（body `{ place_id, tripId }`）寫 `place_id` 再 enrich|
| 新增 alternate POI（推薦）| `POST /api/trips/{id}/entries/{eid}/alternates` | body 帶 `{ poiId }`（既有 POI）或 `{ name, lat, lng, type?, ... }`（find-or-create）+ 選 `entryPoisVersion` |
| 新增 alternate POI（legacy endpoint）| `POST /api/trips/{id}/entries/{eid}/trip-pois` | v2.29 後 backend 寫 trip_entry_pois，endpoint 名稱保留向後相容 |
| 變更 master | `PATCH /api/trips/{id}/entries/{eid}/master` | body `{ poiId, entryPoisVersion? }`；POI 必須已是 alternate 或新 POI |
| Search-driven master swap | `PUT /api/trips/{id}/entries/{eid}/poi-id` | body 帶 `{ poiId }` 或 `{ name, lat, lng, ... }` find-or-create |
| 刪 alternate | `DELETE /api/trips/{id}/entries/{eid}/alternates/{poiId}?entryPoisVersion=N` | 不能刪 master（刪 entry 整筆走 DELETE /entries/:eid）|
| 重排 alternates | `PATCH /api/trips/{id}/entries/{eid}/alternates/reorder` | body `{ order: [poiId,...], entryPoisVersion? }` |
| 飯店設定 / 變更 | `PUT /api/trips/{id}/days/{num}` body `hotel: { name, lat, lng, ... }` | findOrCreatePoi 後寫 `trip_days.hotel_poi_id` |
| 修改 pois master | `PATCH /api/pois/{id}` | admin 或帶 `tripId` 的有權限使用者 — 接受 hours / price / rating / address / phone 等客觀欄位 |
| 刪除 pois master | `DELETE /api/pois/{id}` | admin only — ON DELETE RESTRICT，被 trip_days.hotel_poi_id / trip_entry_pois 引用時 fail |
| **POI 補資料 / refresh（首選）** | `POST /api/pois/{id}/enrich` | **backend 直接打 Google Place Details API，自動寫 rating/address/phone/hours + business_status lifecycle。優先用此 endpoint 而非手動 PATCH。** |

## POI 補資料策略（migration 0051+ 後 v2.23.0）

### 第一原則：用 backend enrich endpoint，不爬網頁

**`POST /api/pois/{id}/enrich`** 是 source of truth。Backend 直接打 Google Place Details API（API Routes v1）拿：

- `rating`（1.0–5.0）
- `lat / lng`（4 位小數）
- `address`（formatted_address，含縣市區番地）
- `phone`（international_phone_number，E.164 `+81-XX-XXXX-XXXX`）
- `hours`（regular_opening_hours.weekday_descriptions，**全週時段 + 公休日**）
- `business_status`（→ pois.status：active / closed / missing）

寫入規則：
- COALESCE 保留 NULL，覆蓋既有值（new non-null > old）
- 同步寫 `last_refreshed_at` + `status_checked_at`

### 觸發場景

| 場景 | 動作 |
|------|------|
| LLM 補單一 POI 缺漏欄位 | `POST /api/pois/{poi_id}/enrich`（admin token 或帶 `?tripId={id}`） |
| 跨行程批次補資料 | `/tp-patch` skill 用 admin token 對所有 `place_id IS NOT NULL AND status='active'` 的 POI loop call enrich |
| 既有 cron refresh | `scripts/google-poi-refresh-30d.ts` 自動跑（50/day quota cap，每月所有 active POI 滾動更新一次） |
| 新增 POI 缺 place_id | 先用 `findOrCreatePoi` 建 pois 行 → 跑 `GET /api/poi-search?q=...` 取 place_id 寫回 → 再 enrich |

### 範例：批次補

```bash
TOKEN=$(cat /tmp/admin-token.txt)
# 取得 1 hour TTL admin token via OAuth client_credentials:
#   curl -X POST https://trip-planner-dby.pages.dev/api/oauth/token \
#     -H "Content-Type: application/x-www-form-urlencoded" \
#     -d "grant_type=client_credentials&client_id=$CID&client_secret=$CSEC&scope=admin"

# 取得需 enrich 的 POI（有 place_id + active + 缺漏 hours/address/phone）
npx wrangler d1 execute trip-planner-db --remote --command "
SELECT id, name FROM pois
WHERE place_id IS NOT NULL AND status='active'
  AND (hours IS NULL OR address IS NULL OR phone IS NULL)
" --json

# 對每筆 POST enrich
for pid in 458 467 489 ...; do
  curl -s -X POST -H "Authorization: Bearer $TOKEN" \
    "https://trip-planner-dby.pages.dev/api/pois/$pid/enrich"
  sleep 0.6  # rate limit (autoplan T11 50/day cap built into pois-due-refresh endpoint)
done
```

### 不要做的事（anti-patterns）

| ❌ Anti-pattern | ✅ 正確做法 |
|---|---|
| `/browse` 爬 Google Maps 詳情頁手動抽 | `POST /api/pois/:id/enrich` |
| WebSearch「POI 名稱 營業時間」 | 同上 |
| LLM 直接打 Google Place Details API（key 暴露 + quota 失控） | 同上（透過 backend 統一管理 quota） |
| `PATCH /pois/:id` 手動寫 hours/address/phone | enrich 自動處理（除非用戶要 manual override） |

`/browse` Google Maps 對未登入訪客限制了 hours panel（只看到當日），且 raw text 抽取易被相鄰元素污染。WebSearch 摘要雖然偶爾完整，但聚合多 source 結果不一致。**只有 enrich endpoint 拿到 Google Place Details API 的權威結構化資料**。

## Google Maps 驗證（鐵律）

**Google Maps 是所有 POI 資料的 source of truth。** 新增或更新 POI 前，必須先確認 Google Maps 上存在該 POI（透過 `GET /api/poi-search?q=...` text search，回傳 place_id + 基本資訊）。查不到 = 無效，不得新增或保留。

驗證流程：

1. `GET /api/poi-search?q=POI 名稱 城市` → 拿 results array
2. 取第一個結果的 `place_id`（必填，沒 place_id 不能 enrich）
3. `findOrCreatePoi` 建 pois 行 + 寫 `place_id`
4. `POST /api/pois/{id}/enrich` 補完整欄位

### 歇業偵測 / 不存在 POI 處理

`POST /api/pois/:id/enrich` 自動處理：
- Place Details API 回 `business_status='CLOSED_PERMANENTLY'` → `pois.status='closed' + status_reason='永久歇業'`
- Place Details API 404 → `pois.status='missing' + status_reason='Google Maps 查無資料'`
- `business_status='CLOSED_TEMPORARILY'` → 仍 `status='active'`（暫時性，不警告）

`status='closed'` 或 `status='missing'` 的 POI：依 `modify-steps.md §5` 流程刪除。

### 必填驗證

新增或替換 POI 時，至少 `name + place_id` 必填。lat/lng/address/phone/hours 由 enrich 補。
