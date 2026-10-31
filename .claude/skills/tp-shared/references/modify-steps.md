# 行程修改共用步驟

## travel 欄位語意（鐵律）

> ⚠️ **travel = 從此地「出發」去下一站的交通方式**，不是「到達此地」。

前端渲染：travel 資訊顯示在該 entry 下方、下一個 entry 上方，代表「離開此景點的交通」。

| entry | travel 意義 |
|-------|-----------|
| 板橋出發 | `driving` 60 min = 從板橋開車 60 分到下一站 |
| 幾米廣場 | `null` = 不需移動（下一站在附近） |
| 午餐 | `driving` 25 min = 午餐後開車 25 分到梅花湖 |
| 返回板橋 | `null` = 最後一站，無後續移動 |

> ⚠️ **v2.24.0 起 trip_segments 是 SoT**：travel 寫入 `trip_segments` table（每對 from→to entry 一筆 row）。
> Skill 只需做結構修改（POST/PATCH/PUT/DELETE entry），**不再手動計算 travel** — 改呼叫
> `POST /api/trips/:id/recompute-travel?day=N` 讓 backend 跑 1km gate（≤1km walking、>1km driving）
> + Google Routes API + 寫 `trip_segments`；`trip_entries.travel_*` legacy 已移除，不 dual-write。

**規則：**
- 第一個 entry 通常有 travel（從出發地到第一個景點）
- 最後一個 entry 的 travel 為 null（已到終點）
- 同地點連續 entry（如農場內的早餐→體驗→退房）travel 為 null（≤1km gate 自動判定）
- 插入/移除/移動 entry 時，**必須在最後呼叫 `POST /recompute-travel`** 讓 backend 重算，並 trip-wide 清掉不再相鄰的幽靈段
- `mode='transit'` 既有 segment **不會**被 recompute 覆寫（user 手填分鐘保留）

## 行程修改共用步驟

tp-edit、tp-request、tp-rebuild 修改行程資料時的共用流程：

### 1. POI 必填欄位（新增或替換時）

| 欄位 | 規則 | 說明 |
|------|------|------|
| `source` | R13 | 使用者明確指定名稱 → `"user"`；模糊描述 → `"ai"` |
| `note` | R15 | 有備註填內容，無備註填空字串 `""` |
| `location.googleQuery` 或 `maps` | R11 | PATCH /entries 用 `location`（JSON 字串 `{"name":"...", "googleQuery":"..."}`）；PUT /days 用 `maps`（純搜尋文字） |
| `googleRating` | R12 | 1.0-5.0，`source: "ai"` 必填，`source: "user"` 盡量填。查詢策略見 `references/poi-spec.md` |

### 1b. Entry location 座標（鐵律）

> ⚠️ **每個實體地點 entry 必須有 lat/lng 座標。** 缺座標 = 地圖無法顯示 + travel 無法計算。

**查詢方式**：用 Google Maps 搜尋 `maps` 欄位的文字，從結果取得 lat/lng。WebSearch 查「{地點名} 座標」或「{地點名} Google Maps」。

**PATCH 格式**：
```json
PATCH /entries/:eid
{"location": "[{\"name\":\"地點名\",\"lat\":26.xx,\"lng\":127.xx,\"geocode_status\":\"ok\"}]"}
```

**時機**：
- tp-create：PUT /days 建立 entry 後，同 Phase 內立即 PATCH 補座標（不得延遲到其他 Phase）
- tp-edit：新增或替換 entry 時，一併 PATCH location
- tp-patch：`--target entry --field location` 批次補齊

**排除**：純交通 entry（「出發」「搭巴士」「起飛」）且無固定地點者可省略。有明確地點的交通 entry（如「那霸機場」「道之驛許田」）仍須填座標。

POI 各 type 必填/建議欄位見 `references/poi-spec.md`。

### 2. 韓國行程 naverQuery（R14）

`meta.countries` 含 `"KR"` 時，新增或修改 POI 須為 location 新增 `naverQuery`。優先精確 place URL `https://map.naver.com/v5/entry/place/{placeId}`，查不到時 fallback 為 `https://map.naver.com/v5/search/{韓文關鍵字}`。

### 3. API 操作選擇

| 操作 | 端點 | 注意 |
|------|------|------|
| 新增 entry | `POST /api/trips/{tripId}/days/{dayNum}/entries` | 必填 `name`（扁平欄位，即 master POI 名稱）；選填 `poi_type`（hotel/restaurant/shopping/parking/attraction/transport/activity/other，預設 attraction）、`start_time`/`end_time`（HH:MM，或 legacy `time`）、`description`、`note`、`lat`/`lng`、`rating`、`sort_order`（省略 append 到最後）。**沒有 `title`、沒有巢狀 `poi: {...}`**。新 POI 無 `place_id` → enrich 會 400，須先 `PATCH /api/pois/{id}`（body `{ place_id, tripId }`）寫 `place_id` 再 enrich。回 201。**之後須 recompute（見 §4）** |
| 修改單一 entry | `PATCH /api/trips/{tripId}/entries/{eid}` | 只收 `start_time` / `end_time`（或 legacy `time`）/ `description` / `sort_order` / `day_id` / `source`，其餘欄位一律 400「無有效欄位可更新」。改名稱/地點 = 換 master POI（`PUT .../poi-id`）；改 POI 客觀欄位走 `PATCH /api/pois/{id}`；per-POI note 走 `PATCH .../entries/{eid}/pois/{poiId}`。**禁止寫 `travel_type` / `travel_desc` / `travel_min`** — segments 由 recompute-travel 自動計算 |
| 刪除單一 entry | `DELETE /api/trips/{tripId}/entries/{eid}` | **tp-request 禁止此操作**。刪除後須 recompute（見 §4） |
| 覆寫整天 | `PUT /api/trips/{tripId}/days/{N}` | 必須含 date + dayOfWeek + label，缺一回 400。entry 內不要手填 `travel`；segments 由之後 recompute 產生。**tp-request 禁止此操作** |
| 新增 alternate POI | `POST /api/trips/{tripId}/entries/{eid}/alternates` 或 `/trip-pois`（legacy alias）| body 帶 `{ poiId }`（既有 POI）或 `{ name, lat, lng, type?, ... }`（find-or-create）；寫 `trip_entry_pois` as alternate (sort_order = max+1)。**`context` 欄位 v2.29.0 已不存在** |
| 變更 master POI | `PATCH /api/trips/{tripId}/entries/{eid}/master` body `{ poiId, entryPoisVersion? }` | swap master ↔ alternate；master 變動 segments 自動失效，須 recompute（見 §4）|
| Search-driven master swap | `PUT /api/trips/{tripId}/entries/{eid}/poi-id` body `{ name, lat, lng, ... }` 或 `{ poiId }` | find-or-create POI 後設為 master |
| 刪除 entry alternate POI | `DELETE /api/trips/{tripId}/entries/{eid}/alternates/{poiId}?entryPoisVersion=N` | 不能刪 master（刪 entry 整筆走 `DELETE /entries/:eid`）|
| 重排 alternates | `PATCH /api/trips/{tripId}/entries/{eid}/alternates/reorder` body `{ order: [poiId,...], entryPoisVersion? }` | 純改 sort_order > 1 順序 |
| 飯店設定 | `PUT /api/trips/{tripId}/days/{num}` body `hotel: {...}` | findOrCreatePoi 後寫 `trip_days.hotel_poi_id` |
| 修改 pois master 客觀欄位 | `PATCH /api/pois/{poiId}` 或 `POST /api/pois/{poiId}/enrich` | hours / price / rating / address / phone 等客觀屬性；enrich 自動補 Google Place Details |
| 重算 travel | `POST /api/trips/{tripId}/recompute-travel?day=N\|all` | 結構動完後**呼叫此端點**取代手動計算。1km gate + Google Routes + 寫 `trip_segments`。即使 `day=N`，也會 trip-wide prune 非現行相鄰對的幽靈段；Routes compute 仍只跑 scoped day |
| 手動覆寫 segment | `PATCH /api/trips/{tripId}/segments/{sid}` | 罕用（通常 user 從 UI TravelPill dialog 觸發）。body: `{mode: 'driving' \| 'walking' \| 'transit', min?: 0-1440}`（transit 必填 min）。`mode='transit'` 表示手填分鐘，後續 recompute 不覆寫 |
| 更新 doc | `PUT /api/trips/{tripId}/docs/{type}` | doc 結構見 `references/doc-spec.md` |

### 4. Doc 連動 + travel 重算

- **Doc 連動（鐵律）**：每次修改後檢視 5 種 doc（checklist/backup/suggestions/flights/emergency），更新不一致內容。規則見 `references/doc-spec.md`。
- **travel 重算（鐵律）** — v2.24.0 起 backend 跑 1km gate + Google Routes 自動算。以下情況須呼叫 `POST /api/trips/{tripId}/recompute-travel?day=N`（單天）或 `?day=all`（整 trip）：
  1. **插入 / 移除 / 移動 entry** — 前後 entry 的 from→to 對變了
  2. **替換 entry 地點 / 改 location 座標** — 景點換了位置，距離變
  3. **餐廳首選變動** — meal entry sort_order=0 餐廳新增、替換或刪除時（recompute 用 entry.location，meal 在 PUT/PATCH 時應已對齊首選餐廳座標）
  4. **新建 day**（tp-create）— 整 trip PUT 完成後，呼叫 `?day=all` 一次

  **行為**：
  - `≤1km` Haversine → `walking` mode + 1 Google Routes WALK call
  - `>1km` → `driving` mode + 1 Google Routes DRIVE call
  - 永遠 1 API call/pair（不打 transit — Japan 無資料；user 需手動透過 segments PATCH 設 transit）
  - `mode='transit'` 既有 segment **不覆寫**（user 手填分鐘保留）
  - 寫 `trip_segments`；`trip_entries.travel_*` legacy 已移除，不 dual-write
  - 每次 recompute 都 trip-wide prune 非現行相鄰對的 stale/orphan segments（`?day=N` 也會清其他天的幽靈段），但 Routes compute 只跑 scoped day

  **subrequest budget**：CF Pages Free 50/invocation。整 trip recompute 上限約 47 pair（HuiYun 沖繩 7 天）。day-scoped recompute 仍只算當日 Routes；trip-wide prune 只多用既有 1 次 all-entries 查詢。

  **不再手動計算**：v2.23 前 skill 用 Haversine + ~30km/h 在 client 算後 PATCH `travel_type/desc/min` — v2.24.0 後**禁止**。

### 5. Google Maps 驗證與歇業偵測（鐵律）

**Google Maps 是 POI 的 source of truth。** 所有 tp-* skills（含 tp-create）新增或更新 POI 時，必須先通過 Google Maps 驗證。驗證流程見 `tp-search-strategies` SKILL.md「前置步驟：Google Maps 驗證」。

若 Google Maps 查不到，或符合以下任一條件，判定為「無效 / 歇業 / 不存在」：

1. **Google Maps 查無此 POI** — WebSearch「{名稱} {地區} Google Maps」無法找到對應的 Google Maps 頁面
2. **明確標示閉店** — 搜尋結果出現「閉店」「closed」「permanently closed」等關鍵字
3. **分店不存在** — 搜尋結果顯示該品牌在目的地無此分店（如「一蘭沖繩只有國際通店」→ ライカム店不存在）

**處理流程：**

- **tp-create（新增行程）**：不新增該 POI，改用 Google Maps 上可查到的替代店家
- **tp-edit / tp-request（修改行程）**：不新增該 POI，回報無效原因，建議替代
- **tp-request（旅伴觸發）**：
  1. 用 `DELETE /api/trips/{tripId}/entries/{eid}/alternates/{poiId}` 刪除 entry-level 關聯（master 不能直接刪；若 POI 為 master，需先 swap 到 alternate 再刪，或整 entry `DELETE /entries/:eid`）
  2. **不可刪 pois master**（旅伴無此權限）
  3. 在回覆中告知旅伴該 POI 已移除及原因
- **tp-patch / tp-rebuild / admin 指示（歇業偵測或 admin 要求）**：
  1. 找出所有引用：`SELECT entry_id, sort_order FROM trip_entry_pois WHERE poi_id={poiId}` + `SELECT id FROM trip_days WHERE hotel_poi_id={poiId}`
  2. 對 entry references 用 `DELETE /api/trips/{tripId}/entries/{eid}/alternates/{poiId}`；對 master references 先 `PATCH /master` swap 到另一個 alternate（如無則整 entry 刪）；對 hotel references 用 `PUT /days/{num}` 換 `hotel`
  3. 完成後 `DELETE /api/pois/{poi_id}` 刪除 pois master（ON DELETE RESTRICT — 還有引用會 fail；admin only）
  4. 在結果報告中列出已移除的 POI 及判定原因

### 6. 驗證

修改後執行 tp-check 精簡 report：`tp-check: 🟢 N  🟡 N  🔴 N`
