---
name: tp-quality-rules
description: R0-R18 品質規則定義庫 — 被 tp-check、tp-create、tp-edit、tp-rebuild 引用，不直接 invoke。
user-invocable: false
---

# 行程品質規則

產生或修改行程資料時（透過 D1 API），必須遵守以下所有品質規則。

## Phase 2 POI Unification（v2.1.2.0+）

Timeline entry 除了既有欄位，新增兩個與 POI master 有關的 request body 欄位：

- `poi_type`：選填。預設 `attraction`。機場/車站/港口 → `transport`；浮潛/玉泉洞/鳳梨園等預訂體驗 → `activity`；餐廳/購物/住宿走原本 nested 結構（restaurants/shopping/hotel）不變動。
- `poi_id`：PATCH 專用。允許 admin 把 entry 改掛到既有 POI master（例如重新指向某個 attraction POI）。

**R11 / R12 / R17 的資料來源 Phase 2 後為 `pois` master** — GET /days/:num 回傳 `entry.poi`（JOIN pois）欄位，優先於 entry 本身的 maps/google_rating/location。Phase 3 後 entry 這幾個欄位將 DROP，但 R-rule 檢查邏輯（實體 POI 需 maps 或 lat+lng、需 google_rating）不變。v2.30.15 (migration 0066)：mapcode 已從 pois 整個 DROP — 不再寫入或檢查。

建立 entry 時仍請在 body 附上 maps / lat / lng / google_rating — 會透過 find-or-create 流到 POI master。

### R0 JSON 結構與值約束

#### 值約束
- 行程 JSON 中**禁止使用 `null`**（唯一例外：`hotel.breakfast.included` 允許 `null` 表示「資料未提供」）。找不到的字串欄位用空字串 `""`，找不到的數字欄位省略該欄位，找不到的物件/陣列欄位省略該欄位。`typeof null === "object"` 會導致 schema 測試失敗。
- 每日 `label` **不超過 8 字**。超過時用更簡潔的寫法，例如「甘川洞・松島」而非「甘川洞・松島・南浦」。

#### URL 與格式安全性
- 所有 URL 欄位（googleQuery、appleQuery、reservationUrl）的值必須以 `http://`、`https://` 或 `tel:` 開頭，否則視為不安全。
- `googleQuery` 必須為 Google Maps URL，格式為 `https://www.google.com/maps/search/<percent-encoded-query>`。
- `appleQuery` 必須為 Apple Maps URL，格式為 `https://maps.apple.com/?q=<percent-encoded-query>`。
- `naverQuery` 必須為 Naver Maps URL（以 `https://map.naver.com/` 開頭），優先使用精確 place URL `https://map.naver.com/v5/entry/place/{placeId}`，查不到時 fallback 為 `https://map.naver.com/v5/search/{韓文關鍵字}`。
- ~~mapcode~~：v2.30.15 (migration 0066) 已從 pois DROP — Google/Apple Map link 涵蓋導航需求，自駕 trip 不再要求 mapcode。

#### 根層級必填欄位
- 必填：`meta`（含 `title` 非空字串、`selfDrive` boolean、`countries` 非空陣列，值為 ISO 3166-1 alpha-2 國碼如 `["JP"]`）、`days`（非空陣列）、`autoScrollDates`（非空陣列）、`footer`（含 `title`、`dates`）、`suggestions`、`checklist`。
- 選填：`flights`、`emergency`（存在時驗證結構）。
- `meta` 不得包含已移除欄位（`themeColor`）。

#### 每日結構
- 每日必填：`id`、`date`（非空字串）、`label`、`content.timeline`（陣列）。
- `days[i].id` 必須等於 `i + 1`（從 1 開始的連續整數）。
- `autoScrollDates[]` 須為 ISO 格式 `YYYY-MM-DD`。

#### Timeline event 結構
- 每個 event 必填：`time`（非空字串）、`title`（非空字串）。
- 選填欄位存在時須為正確型別：`description`（string）、`locations`（array）、`infoBoxes`（array）。
- `travel` 物件須含 `desc`（string）和 `type`（string）。選填 `min`（number，分鐘）。

#### Hotel 結構
- 必填：`name`（非空字串）、`breakfast`（物件，含 `included`）。
- 選填欄位存在時須為正確型別：`checkout`（string）、`details`（array）、`infoBoxes`（array）。
- `hotel.subs` 已移除，停車場資料 SHALL 位於 `hotel.infoBoxes[type=parking]`。
- 行程最後一天（`days` 陣列最後一個元素）不得包含 `hotel` 物件（返家日無需住宿）。

#### Flights 結構（若存在）
- 須含 `title`（非空字串）和 `content.segments`（陣列）。
- 每個 segment 須含 `label`（非空字串）、`route`（非空字串），以及 `time`（字串）或 `depart` + `arrive`（皆為字串）。
- `content.airline` 為必填物件，含 `name`（非空字串）和 `note`（字串）。

#### Suggestions 結構
- `suggestions.content.cards[].priority` 值只能為 `high`、`medium` 或 `low`。

---

### R1 料理偏好（2026-05-02 改寫，migration 0045 後）
**舊版**（已廢）：trips 表有 `food_prefs` 欄位儲存固定 3 偏好；首次推薦前詢問 user，
之後第 1 家對應偏好 1、第 2 家對應偏好 2、第 3 家對應偏好 3。

**新版**：`trips.food_prefs` 已 DROP。每次推餐廳時 LLM 從以下情境推斷使用者口味
偏好，**不持久化、不固定 3 家對應 3 偏好**：

1. 同行程已產生餐廳的 `category` 多樣性（避免連推 3 家拉麵）
2. 該日 timeline 上下文（早餐後、運動後、機場前等）
3. user 在 chat 訊息中曾提及的偏好（「想吃海鮮」「不想連吃日本料理」）
4. 行程目的地的代表料理（沖繩→沖縄そば/ステーキ/タコス、京都→懐石/湯豆腐）

如 user 明確要求某類料理或避免某類料理，依其要求；否則由 LLM 自由發揮，目標 3 家
有變化。R3 原本「category 須與 meta.foodPreferences 順序對應」一句也作廢 — category
依場合與多樣性決定即可。

### R2 餐次完整性（航程感知）
每日 timeline 須包含午餐和晚餐。**早餐不強制產生 timeline entry**；若使用者在當晚飯店吃早餐，資訊由 Day N-1 的 `hotel.breakfast` 承載（見 R8），Day N 首 entry 已由 R19 指向前日飯店 check-out，不重複產生早餐 entry。若早餐在飯店外（如前往機場前用早餐），可為正式餐次 entry。

缺少午/晚餐時插入「餐廳未定」entry 並附 3 家推薦。一日遊團體行程（KKday/Klook 等）SHALL 插入午餐 timeline entry（title 為「午餐（團體行程已含）」），不附 restaurants infoBox 推薦。晚餐依到達地點推薦。航程到達日與出發日依航班時間判斷：到達日以到達時間為準（< 11:30 需午餐+晚餐、11:30~17:00 需晚餐、≥ 17:00 晚餐可選）；出發日以出發時間為準（< 11:30 不需午晚餐、11:30~17:00 需午餐、≥ 17:00 需午餐+晚餐）。無 flights 資料時每日皆須午晚餐。

**豁免：** hotel name 為「家」的在地行程，跳過該日所有餐次檢查。

### R3 餐廳推薦品質
每個 restaurants infoBox 含 1～3 家餐廳（目標補到 3 家）。每家必填 hours（營業時間）、reservation（訂位資訊）。營業時間須與用餐時間吻合（餐廳開始營業時間 ≤ event 時間 + 1 小時，不推薦 17:00 開的店當午餐）。餐廳 category 由 LLM 依當下場合與多樣性決定（**2026-05-02 改寫**：原本「須與 `meta.foodPreferences` 順序對應」已廢，見 R1 改寫）。同一行程內不得重複推薦相同品牌/連鎖店的不同分店（如「琉球の牛 那覇店」與「琉球の牛 恩納店」視為重複）；使用者明確指定的餐廳（`source: "user"`）優先保留，AI 推薦的重複店家須替換為其他選項。

### R4 景點品質
infoBoxes 確認含營業時間，且與到訪時間吻合。

### R7 購物景點推薦
統一使用 `infoBox type=shopping`（不使用 souvenir type）。飯店附近超市/超商/唐吉軻德以 shopping infoBox 結構化顯示。超商（步行 5 分鐘內）含 mustBuy。獨立購物行程（來客夢/iias/Outlet/PARCO CITY）同樣附 shopping infoBox。景點附近步行 5~10 分鐘有超市或唐吉軻德時，在該景點 entry 加 shopping infoBox。每個 shop 含 category、name、hours、mustBuy（至少 3 項）。自駕行程飯店 infoBoxes 須有停車場資訊（`type: "parking"`）。

shop.category 使用標準分類（共 7 類）：超市、超商、唐吉軻德、藥妝、伴手禮、購物中心、Outlet。

**飯店 shopping 要求：** 非「家」及非「（」開頭的飯店，hotel.infoBoxes 須包含至少一個 `type: "shopping"` 的 infoBox，且該 infoBox 內 shops 陣列至少 3 家。

#### 飯店購物 infoBox checklist（兩階段）

**階段 1：驗證既有**
- 所有 shopping infoBox 的 shop.category 是否為 7 類標準分類之一
- 每個 shop 是否含 category/name/hours/mustBuy(>=3)
- 是否有 souvenir type 殘留需改為 shopping

**階段 2：生成缺漏**
- 逐日檢查：hotel 物件是否有 infoBoxes 陣列？
- 若無 infoBoxes 或無 type=shopping → 新建 shopping infoBox
- 搜尋飯店名稱 + 附近超市/超商/唐吉軻德，補到 3+ shops
- shopping infoBox 放在 hotel.infoBoxes，不放在 timeline entry

### R8 早餐欄位
每日 hotel 物件須包含 `breakfast` 欄位。使用者指定飯店含早餐時：`{ "included": true, "note": "早餐說明" }`。自行解決：`{ "included": false }`。未指定：`{ "included": null }`（顯示「資料未提供」，此為 R0 null 禁用的唯一例外）。若查得到飯店最晚退房時間，以 `hotel.checkout` 記錄（如 `"11:00"`）。使用者安排的入退房時間在 timeline events 中，hotel 不重複。

**R19 搭配**：同飯店早餐 SHALL NOT 重複產生 timeline entry — 早餐資訊由 `hotel.breakfast` 表達，Day N 首 entry（R19 check-out）已代表「人從飯店開始今天」。若在飯店外吃早餐（如前往機場前），另產生正式餐次 entry（依 R2）。

**UI surface**：Hotel card 已於 R19 移除後，Day N-1 `hotel.breakfast` 的內容 SHALL inject 進 Day N timeline[0]（check-out entry）的 `description` 欄位，以「🍳 早餐：{breakfast.note / included 敘述}」格式呈現；若 `breakfast.included = false`，description 省略早餐行、只描述退房。使用者從 timeline 第一個 entry 就能看到當日早餐資訊，不失資訊。

### R10 還車加油站
自駕行程（`meta.selfDrive` 為 `true`）產生或修改還車 timeline event 時，SHALL 附上最近的加油站資訊。以 `gasStation` infoBox 結構化呈現（含 name、address、hours、service、phone，選填 location）。優先推薦フルサービス（人工加油站），標註 `service: "フルサービス（人工）"`；若附近僅有自助加油站，標註 `service: "セルフ（自助）"`。搜尋方式：Google「{還車地點} 附近 人工加油站」。

### R11 地圖導航
實體地點類 timeline event（非 travel、非「餐廳未定」、非純描述型）SHALL 含 `location` 物件，用於地圖導航。`location` 包含 `googleQuery`（Google Maps 搜尋字串）和/或 `appleQuery`（Apple Maps 搜尋字串）。`location.name` 為必填非空字串，使用該地點的原文名稱（日文店名、韓文店名等）。

### R12 Google 評分
所有 POI（實體地點類 timeline event、餐廳、商店、加油站）SHALL 含 `googleRating` 欄位（數字，1.0-5.0）。travel event 和「餐廳未定」event 略過 R12 檢查。

### R13 POI 來源標記
所有非豁免 POI SHALL 含 `source` 欄位（值為 `"user"` 或 `"ai"`），與 `name` 同級。POI 類型包含：timeline event（非 travel）、restaurant、hotel（name 非「家」且不以「（」開頭）、shop、gasStation。

- `"user"`：使用者明確指定名稱的 POI
- `"ai"`：AI 自行推薦或使用者僅給模糊描述（如「找一家拉麵店」）的 POI

#### 驗證等級（依 source 區分）
- `source: "ai"` 且缺少 `googleRating` → **fail**（🔴）
- `source: "user"` 且缺少 `googleRating` → **warning**（🟡）

此規則為離線檢查（不做即時搜尋），僅檢查缺少 `googleRating` 的非豁免 POI。

### R15 必填 note 欄位
所有 POI 實體（timeline event、restaurant、shop、hotel、parking infoBox）SHALL 含 `note` 欄位（字串）。有備註時填入內容，無備註時為空字串 `""`。hotel infoBox 內的 shop 和 parking 同樣適用。

### R14 國家感知規則
- `meta.countries` 含 `"KR"` 時，所有 POI 的 location 必填 `naverQuery`（Naver Maps URL）。
- `naverQuery` 優先填精確 place URL：`https://map.naver.com/v5/entry/place/{placeId}`，查不到時 fallback 為 `https://map.naver.com/v5/search/{韓文關鍵字}`。
- 非韓國行程不需要 `naverQuery` 欄位。

### R16 飯店 POI 建議填 lat+lng + address
type 為 `hotel` 的 pois 建議有 `lat`+`lng`（導航用，frontend 透過 mapsUrl helper 衍生 Google Maps URL）和 `address`（地址）。缺少 → **warning**（🟡）。
（評分由 R12/R13 涵蓋，不重複檢查。Migration 0045 已 DROP `pois.maps` column，frontend 不再依賴此欄位。）

### R17 POI 必填導航資訊
所有 POI 必須至少有一種導航方式：`maps`（Google Maps URL 或搜尋文字）或 `lat` + `lng`。兩者都缺 → **fail**（🔴）。

### R18 飯店 POI 建議填 phone
type 為 `hotel` 的 pois 建議有 `phone`（電話）。缺少 → **warning**（🟡）。

### R19 每日首 timeline entry（前日飯店橋接）
每日 `timeline[0]` SHALL 遵循下列規則：

- **Day 1（`days[0]`）**：首 entry SHALL 為抵達點（機場 / 車站 / 碼頭），`title` 含抵達關鍵字（「抵達」「到達」「Arrive」），`location` 指向交通節點 POI。
- **Day N（N ≥ 2）**：首 entry SHALL 為 Day N-1 `day.hotel` 的**同一個 POI** 的 check-out entry。`location` 等同 Day N-1 `day.hotel`、`title` 含 check-out 語意（「退房」「Check-out」）。該 entry 不複製 Day N-1 `hotel.infoBoxes`（parking / shopping infoBox 只掛 hotel 物件）。
  - **description 內含早餐資訊（R8 搭配）**：若 Day N-1 `hotel.breakfast.included === true`，check-out entry 的 `description` 開頭 SHALL 為 `"🍳 早餐：{breakfast.note || '飯店自助'}"`；若 `included === false` 或 `null` 則省略早餐行，description 描述退房動作即可。
- **最後一天**：首 entry 同 Day N（= 前日飯店 check-out）；尾端仍 SHALL NOT 設 `day.hotel`（沿用 R0）。
- **travel**：Day N 首 entry 的 `travel` 描述「從前日飯店出發至下一站」。若首 entry 與下一站位於同地點（如飯店內早餐接 check-out），`travel` 為 `null`。
- **換宿 vs 連住**：Day N 首 entry 不管 Day N 是否換宿，皆指向 Day N-1 的 hotel POI；換宿情境 Day N 末仍保留新飯店 check-in entry + `day.hotel`。

**Canonical rule**：本節 R19；`tp-check`、`tp-create`、`tp-edit`、`tp-rebuild` 一律引用這裡，不另存副本。

**與 R0 Hotel 結構正交**：R0「最後一天不設 hotel」與 R19「最後一天首 entry 為前日飯店 check-out」同時成立 — 前者規範 `day.hotel`、後者規範 `timeline[0]`，不衝突。
