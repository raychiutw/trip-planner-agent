---
name: tp-rebuild
description: 全面重整行程品質時使用 — 逐項檢查 R0-R18 並修正違規，不改時間軸順序（重整、修復品質、修紅燈、rebuild）。局部修改用 /tp-edit。
user-invocable: true
---

全面重整單一行程資料，依 R0-R18 品質規則逐項檢查並透過 API 修正。

⚡ 核心原則：不問問題，直接給最佳解法。遇到模糊需求時自行判斷最合理的方案執行，不使用 AskUserQuestion。

## API 設定

API 設定、呼叫格式、Windows encoding 注意事項見 tp-shared/references.md

## 輸入方式

- 指定 tripId：`/tp-rebuild okinawa-trip-2026-Ray`（單一行程）
- `--all`：`/tp-rebuild --all` 批次重整所有行程
- 未指定：呼叫 `GET /api/trips` 列出所有行程供選擇

## 步驟

1. 讀取行程所有資料：
   ```bash
   # 讀取 meta
   curl -s "https://trip-planner-dby.pages.dev/api/trips/{tripId}"
   # 讀取所有天概要
   curl -s "https://trip-planner-dby.pages.dev/api/trips/{tripId}/days"
   # 依序讀取每天完整資料
   curl -s "https://trip-planner-dby.pages.dev/api/trips/{tripId}/days/{N}"
   ```
2. **tp-check（before-fix）**：執行完整模式 report，顯示修正前的品質狀態
3. 逐項檢查 R0-R18 品質規則，修正不合格的資料。搜尋 POI 資料時若符合「歇業/不存在」條件（見 tp-shared/references.md §5），依新流程清理（`DELETE /entries/:eid/alternates/:poiId` 或 swap master，必要時 admin `DELETE /api/pois/:id`）

   **days meta 缺漏修復**（必先於其他修復執行）：
   - 檢查每天的 `date`、`day_of_week`（GET 回傳 snake_case）、`label` 是否為 null 或空字串
   - 若 `date` 缺漏：根據 trip `startDate` + `day_num` 推算（startDate + day_num - 1 天）
   - 若 `day_of_week` 缺漏：從推算出的 date 計算中文星期（一/二/三/四/五/六/日）
   - 若 `label` 缺漏：根據當天 timeline 內容摘要，≤ 8 字
   - 修復後透過 PUT `/api/trips/{tripId}/days/{N}` 整天覆寫寫回（含 date、dayOfWeek、label 三個必填欄位）
4. 依修改類型選擇對應 API 寫回：
   - **修改單一 entry**：PATCH `/api/trips/{tripId}/entries/{eid}`
   - **覆寫整天**（結構性問題）：PUT `/api/trips/{tripId}/days/{N}`
   - **修改 POI master 客觀欄位（hours/price/rating/address/phone）**：`PATCH /api/pois/{poiId}` 或 `POST /api/pois/{poiId}/enrich`（首選）。**v2.29.0 後 `PATCH /trip-pois/:tpid` endpoint 已不存在 — `trip_pois` 整表 DROPPED**
   - **修改 entry × POI 結構（master swap、加 alternate、刪 alternate、重排）**：見 tp-shared/references/modify-steps.md §3 — `PATCH /entries/:eid/master` / `POST /entries/:eid/alternates` / `DELETE alternates/:poiId` / `PATCH alternates/reorder`
   - **更新 doc**（checklist/backup/suggestions）：PUT `/api/trips/{tripId}/docs/{type}`（doc 結構規格見 tp-shared/references.md「Doc 結構規格」）

   所有寫入操作須帶認證 headers（呼叫格式見 tp-shared/references.md）。
5. **location 座標檢查（鐵律）**：檢查所有實體地點 entry 是否有 lat/lng 座標。缺座標的 entry 用 Google Maps 查詢 `maps` 欄位文字取得 lat/lng，PATCH 回填。規則見 tp-shared/references.md §1b
5b. **R19 每日首 entry 檢查（鐵律，見 tp-quality-rules）**：驗證每天 `timeline[0]` 是否合 R19。
    - Day 1 首 entry 應為抵達點（含「抵達」關鍵字 + 指向交通節點 POI），不合則插入
    - Day N（N ≥ 2）首 entry 應指向 Day N-1 `day.hotel` 同 POI，`title` 含 check-out 語意；不合則**在 timeline 頂端插入** leading entry（time 優先用 Day N-1 `hotel.checkout`，無則 `"07:00"`），不複製 `hotel.infoBoxes`；若 Day N-1 `hotel.breakfast.included === true`，description inject `"🍳 早餐：{breakfast.note || '飯店自助'}"`
    - 若 Day N 目前的 `timeline[0]` 已是早餐或景點，保留原 entry（往後順延），新插入的 check-out entry 放 index 0
    - 插入後立即在最後 step 6 一併 recompute
6. **travel 重算（鐵律，v2.24.0+）**：所有結構修正完成後，呼叫 `POST /api/trips/{tripId}/recompute-travel?day=all` 一次。Backend 跑 1km gate Haversine（≤1km walking、>1km driving）+ Google Routes API + 寫 `trip_segments`；`mode='transit'` 既有 segment 不覆寫；同時 trip-wide prune 不再相鄰的幽靈段。**不再手動 PATCH `travel_type/desc/min`** — segments 為 SoT。規則見 tp-shared/references.md §4
7. **Doc 連動（鐵律）**：檢視所有 5 種 doc（checklist/backup/suggestions/flights/emergency），更新與修正內容不一致的部分（規則見 tp-shared/references.md「Doc 連動規則」）
8. **tp-check（after-fix）**：執行完整模式 report，確認修正結果
9. 不自動 commit（資料已直接寫入 D1 database）

## 重整範圍

檢查現有行程的每個欄位是否符合 R0-R18，修正不符規則的部分。
**不改 timeline 順序、不新增/移除景點**，只確保現有內容符合品質規則。

## 批次模式（--all）

使用 `--all` 時，取得所有行程清單後逐一執行上述重整步驟：

```
處理中：1/7 okinawa-trip-2026-Ray
✓ 完成 1/7：okinawa-trip-2026-Ray
tp-check: 🟢 10  🟡 2  🔴 0

處理中：2/7 okinawa-trip-2026-HuiYun
...

全部完成！7/7 行程已重整。
```

## 注意事項

- 所有資料讀寫均透過 API，不操作本地 MD 檔案
- 不執行 git commit / push（資料已直接寫入 D1 database）
- 不執行 npm run build（無 dist 產物需產生）
