---
name: tp-create
description: 建立新行程時使用 — 從零產生完整行程（建行程、新行程、規劃旅遊、plan a trip）。提供目的地、日期、旅行方式即可。修改既有行程用 /tp-edit，重整品質用 /tp-rebuild。
user-invocable: true
---

從零產生符合品質規則的完整行程，透過 D1 API 建立資料。

⚡ 核心原則：不問問題，直接給最佳解法。遇到模糊需求時自行判斷最合理的方案執行，不使用 AskUserQuestion（料理偏好除外）。

## API 呼叫方式

> ⚠️ **Windows 環境禁止使用 curl**（中文 body 會亂碼被 middleware 擋）。一律用 node https 模組打 API。

### API helper 腳本（Phase 1 第一步建立）

在 `/tmp/api-helper.js` 建立共用 helper，後續所有 API 呼叫都透過它。模板見 `references/api-helper-template.md`。

呼叫前先 `export $(grep TRIPLINE_API_TOKEN .env.local | xargs)`，再 `node -e "..."` 引用 helper。

其他 API 設定、POI 欄位規格見 tp-shared/references.md

## 輸入方式

- 指定描述：`/tp-create 沖繩五日自駕`
- 未指定：詢問行程目的地、天數、旅行方式等基本資訊

## 步驟（兩階段生成）

### Phase 0：收集行程基本資訊

建立行程前**必須確認**以下資訊（使用者未提供時詢問）：

| 欄位 | 說明 | 範例 |
|------|------|------|
| **owner** | 行程主人名稱（英文，用於 tripId 和 name） | `Ray`、`HuiYun`、`AeronAn` |
| **destination** | 目的地 | `沖繩`、`釜山`、`板橋` |
| **startDate** | 出發日（YYYY-MM-DD） | `2026-07-29` |
| **endDate** | 回程日（YYYY-MM-DD） | `2026-08-02` |

> **2026-05-02 (migration 0045)**：`self_drive` / `food_prefs` / `og_description` /
> `auto_scroll` / `footer` / `is_default` 欄位已從 `trips` 表移除（OSM PR Q1/Q3）。
> 自駕語意改用 `default_travel_mode='driving'`；料理偏好不再持久化（每次推餐廳時
> 由 LLM 從上下文判斷，見 tp-quality-rules R1 改寫）。`destinations[]` 為新加 body
> 欄位，寫入 `trip_destinations` 子表。

以下欄位**自動推導**，不需詢問：

| 欄位 | 推導規則 |
|------|----------|
| `id` (tripId) | `{destination}-trip-{year}-{owner}`（全部小寫，API 驗證 `/^[a-z0-9-]+$/`） |
| `name` | `{owner} 的{destination}之旅` |
| `title` | `{year} {destination}{天數}日行程表` |
| `countries` | 依目的地判斷 ISO 3166-1 alpha-2（日本 `JP`、韓國 `KR`、台灣 `TW`） |
| `description` | 行程完成後自動產生 SEO 摘要（含主要景點、天數、特色） |
| `data_source` | `'manual'`（POST 預設）/ `'tp-create'`（skill 標記） |
| `default_travel_mode` | `'driving'`（自駕）/ `'walking'` / `'transit'` — 影響 ORS 路徑計算 |
| `lang` | `'zh-TW'`（預設） |
| `published` | 預設 `0`（未發布），行程完成驗證通過後改 `1` |

### Phase 1：產生骨架

1. 確認 Phase 0 所有必填資訊已收集完畢
1b. 韓國行程須為所有 POI location 新增 `naverQuery`（Naver Maps URL）
2. 讀取品質規則（tp-quality-rules skill）
3. 建立行程（`POST /api/trips`，API 格式見 tp-shared/references.md）：

   Body: `{name, owner, title, description, countries, data_source:'tp-create', default_travel_mode, lang:'zh-TW', published:0, startDate, endDate, destinations:[{name, lat?, lng?, day_quota?, sub_areas?, osm_id?, osm_type?}]}`

   ⚠️ **不可送 `id`**（2026-07-21 起）。行程 ID 由後端產生（`src/lib/tripId.ts`），
   送了會回 400 `DATA_VALIDATION`。**tripId 一律取回應裡的值**，不要自己造。

   POST 會自動建立 trips + trip_days + trip_permissions 記錄。回傳 `{ ok: true, tripId, daysCreated }`。
4. 為每一天產生完整內容（JSON 格式），包含：
   - timeline entries（含 type、title、time、description、location、travel、hotels 等）
   - **每日首 timeline entry（R19，見 tp-quality-rules）**：
     - **Day 1**：首 entry 為抵達點（機場 / 車站 / 碼頭），詢問使用者抵達時間與地點；`title` 含「抵達」；`location` 指向交通節點 POI
     - **Day N（N ≥ 2）**：首 entry 為 Day N-1 住宿 `day.hotel` 的**同 POI** check-out entry；`time` 優先用 `hotel.checkout`（查得到時），否則預設 `"07:00"`；`title` 含「退房」或「Check-out」；**不複製** hotel 的 `infoBoxes`；若 Day N-1 `hotel.breakfast.included === true`，`description` 開頭 inject `"🍳 早餐：{breakfast.note || '飯店自助'}"`（R8 搭配）
     - **最後一天**：首 entry 同 Day N（前日飯店 check-out）；尾端仍不設 `day.hotel`（沿用 R0）
   - **每天必建午/晚餐 entry**（早餐不強制；使用者可自行刪除不需要的）：
     - 早餐（若在飯店吃，由 `day.hotel.breakfast` 表達；若在飯店外吃，才產生正式早餐 entry）
     - 午餐 `12:00`（title: `"午餐"`，附 3 家 restaurants 推薦）
     - 晚餐 `18:00`（title: `"晚餐"`，附 3 家 restaurants 推薦）
   - 三餐 entry 的 location：用 sort_order=0（首選）餐廳的 lat/lng（recompute-travel 會吃這個座標跑 1km gate）

   > ⚠️ **travel 語意見 tp-shared/references.md**：travel = 從此地「出發」到下一站。
   > **v2.24.0 起 skill 不手動算 travel** — 全 trip PUT 完成後呼叫
   > `POST /api/trips/{tripId}/recompute-travel?day=all` 一次，backend 跑 1km gate
   > + Google Routes 自動算 segments。
   - restaurants infoBox（早餐/午餐/晚餐 entry 下各 3 家推薦）
   - shopping infoBox（非家飯店 entry 下）
   - **Google Maps 驗證（鐵律）**：所有 POI 必須先確認 Google Maps 上存在。查不到 = 無效，不得新增。驗證流程見 `tp-search-strategies`。
   - 每個 POI 須包含以下必填欄位：
     - `note: ""`（有備註填內容，無備註填空字串，R15）
     - `maps`：實體地點填 Google Maps 搜尋文字（R11，PUT /days/:num 用 `maps` 欄位）
     - `googleRating`：Phase 1 先省略，Phase 2 並行查詢補充（R12）
     > ⚠️ PUT /days/:num 不接受 `location` 物件和 `source` 欄位。`source` 由 findOrCreatePoi 自動設為 `'ai'`。
      > ⚠️ **每天 PUT 完成後，立即用 `PATCH /entries/:eid` 補寫所有實體地點 entry 的 `location` 座標（鐵律，不得延遲到其他 Phase）。** 用 Google Maps 查詢 `maps` 欄位文字取得 lat/lng。格式：`[{"name":"地點名","lat":24.7563,"lng":121.7494,"googleQuery":"...","appleQuery":"...","geocode_status":"ok"}]`。缺座標 = 地圖無法顯示 + travel 無法計算。
   - POI 各 type 必填/建議欄位見 tp-shared/references.md
   - Markdown 支援欄位見 tp-shared/references.md
5. 每天 hotel 須包含 `checkout` 欄位（從 details 退房時間提取，查不到則為空字串 `""`）
6. 骨架中尚無法確認的欄位**留空**（不使用 null）：`googleRating` 省略欄位，其餘欄位用空字串
7. 依序建立每天資料：

   每天 PUT 的 request body **必須**包含以下三個欄位，缺少任一欄位 API 將回傳 400：
   - `date`（YYYY-MM-DD 格式，必填）：當天日期，例如 `"2026-07-01"`
   - `dayOfWeek`（中文星期，必填）：`"一"` / `"二"` / `"三"` / `"四"` / `"五"` / `"六"` / `"日"`
   - `label`（≤ 8 字，必填）：當日主題，例如 `"抵達那霸"` / `"美麗海水族館"`

   使用 `PUT /api/trips/{tripId}/days/{N}`（API 格式見 tp-shared/references.md）
8. 建立 docs（flights、checklist、backup、suggestions、emergency）：

   使用 `PUT /api/trips/{tripId}/docs/{type}`，Body: `{title: "...", entries: [{section, title, content}, ...]}`

   > ⚠️ **新建行程一律用新格式**（`entries` 陣列），不用舊格式（`content: JSON字串`）。完整規格見 tp-shared/references.md「Doc 結構規格」。

8b. **Travel 重算（鐵律，v2.24.0+）**：所有天 PUT 完成 + 所有 entry location 補完後，呼叫 `POST /api/trips/{tripId}/recompute-travel?day=all` 一次。Backend 跑 1km gate Haversine + Google Routes API + 寫 `trip_segments`；`mode='transit'` 既有 segment 不覆寫；同時 trip-wide prune 不再相鄰的幽靈段。不要在 PUT body 手填 `travel` 巢狀欄位，segments table 是 SoT。

### Phase 2：Google 評分充填（browse-first）

> ⚠️ **googleRating 查詢策略見 tp-shared/references.md**（browse-first，WebSearch 僅做 fallback）。

#### Step 2a：收集所有需要評分的 POI

用 `GET /api/trips/{tripId}/days/{N}` 取得每天資料，列出：
- entry（需 PATCH entry）：`{ entryId, title }`
- restaurant/shop（需 PATCH pois）：`{ poiId, name }`

排除不需評分的 entry：travel event、「午餐」「餐廳未定」、「出發」「返回」「退房」等非實體地點。

#### Step 2b：browse 批次查詢腳本

用 `/browse` 的 `$B goto` + `$B text` 批次查詢所有 POI。腳本模板與 PATCH 方式見 `references/browse-rating-script.md`。

#### Step 2d：WebSearch fallback

browse 查不到的 POI，依 tp-shared/references.md「googleRating 查詢策略」的 fallback 步驟補查。仍查不到 → 不填（R13 source=ai 缺 rating 會被 tp-check 標記）。

9. 執行 Step 2a-2d
10. 確認所有 POI 評分完整
11. 確保不引入 null 值（找不到 → `googleRating` 省略）

### Phase 3：驗證

12. 執行 `/tp-check` 完整模式驗證（透過 API 讀取資料驗證）
13. 回報建立完成摘要

## tripId 命名規則

`{destination}-trip-{year}-{owner}`，**全部小寫**（API 驗證只允許 `[a-z0-9-]`）。
例如：`okinawa-trip-2026-ray`、`yilan-trip-2026-banqiaocircle`

## 注意事項

- 所有資料均透過 API 建立，不建立本地 MD 檔案
- 不執行 git commit / push（資料已直接寫入 D1 database）
- 不執行 npm run build（無 dist 產物需產生）
