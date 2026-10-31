---
name: tp-edit
description: 局部修改既有行程時使用 — 換餐廳、加景點、改飯店、刪行程、更新單一欄位（換成、改成、加一個、刪掉）。跨行程批量補欄位用 /tp-patch，全面重整用 /tp-rebuild。
user-invocable: true
---

接受自然語言描述，局部修改指定行程資料（D1 API）。修改後執行 tp-check 精簡 report。

⚡ 核心原則：不問問題，直接給最佳解法。遇到模糊需求時自行判斷最合理的方案執行，不使用 AskUserQuestion。

## API 設定

API 設定、呼叫格式、Windows encoding 注意事項見 tp-shared/references.md

## 輸入方式

- 指定 tripId + 描述：`/tp-edit okinawa-trip-2026-Ray Day 3 午餐換成拉麵`
- 未指定 tripId：呼叫 `GET /api/trips` 列出所有行程供選擇

## 步驟

1. 讀取行程資料：
   ```bash
   # 讀取 meta（取得基本資訊、countries 等）
   curl -s "https://trip-planner-dby.pages.dev/api/trips/{tripId}"
   # 讀取受影響的天
   curl -s "https://trip-planner-dby.pages.dev/api/trips/{tripId}/days/{dayNum}"
   ```
2. 依自然語言描述**局部修改**對應資料（只改描述涉及的部分）
3. **Google Maps 驗證（鐵律）**：新增或替換 POI 前必須先確認 Google Maps 上存在，查不到 = 無效，不得新增（見 tp-search-strategies）。若發現既有 POI 無效，依 tp-shared/references.md §5 執行清理（刪 alternates / swap master / 換 hotel；必要時 admin DELETE pois master）。
3b. 新增或替換 POI 的必填欄位（source、note、googleQuery、googleRating）+ 韓國 naverQuery — **詳見 tp-shared/references.md「行程修改共用步驟」**
4. 修改的部分須符合 R0-R18 品質規則
5. 依修改類型選擇 API（POST entry / PATCH entry / PUT 整天 / POST alternates / PATCH master / PUT doc）— **端點見 tp-shared/references.md「行程修改共用步驟」§3**
   > ⚠️ **目標 entry 不存在時**（如該天沒有早餐 entry 但需要加入早餐）：先用 `POST /api/trips/{tripId}/days/{dayNum}/entries` 建立 entry（必填 `title`），取得 `eid` 後再掛 POI。
6. **location 座標更新（鐵律）**：新增或替換景點時，必須用 `PATCH /entries/:eid` 補寫 `location` JSON（含 lat/lng）。用 Google Maps 查詢取得座標。格式：`[{"name":"地點名","lat":24.xx,"lng":121.xx,"googleQuery":"...","appleQuery":"...","geocode_status":"ok"}]`。缺座標 = 地圖無法顯示 + travel 無法計算。
7. **Doc 連動 + travel 重算（鐵律）** — 規則見 tp-shared/references.md §4。v2.24.0 起改呼叫 backend：
   - 插入/移除/替換 entry **或** 改 location 座標 **或** meal entry sort_order=0 餐廳變動 → `POST /api/trips/{tripId}/recompute-travel?day={N}`（受影響的天）
   - 跨天移動 → 兩天都 recompute（或直接 `?day=all`）
   - **不再手動算 Haversine**，不寫 `travel_type/desc/min` flat fields — backend 跑 1km gate + Google Routes 自動寫 trip_segments
   - **R19 維持（見 tp-quality-rules）**：若修改動到 `timeline[0]`（插入、移除、移動），必須保持 R19 語意 — Day 1 首 entry 為抵達點、Day N≥2 首 entry 為前日 `day.hotel` 的同 POI check-out；禁止把非 R19 entry 推到 index 0。使用者若要求「把早餐移到 Day 2 最前面」，先保留前日飯店 check-out 為 index 0，早餐放 index 1
8. 執行 tp-check 精簡模式，輸出：`tp-check: 🟢 N  🟡 N  🔴 N`
9. 不自動 commit（資料已直接寫入 D1 database，無需 git 操作）

## 局部修改 vs 全面重整

本 skill 只處理描述涉及的修改範圍，例如：
- 「Day 3 午餐換成拉麵」→ 只改 Day 3 午餐 entry
- 「加一個景點到 Day 2」→ 只在 Day 2 timeline 插入
- 「刪除 Day 4 的購物行程」→ 只移除該 entry

**不全面重跑 R0-R18**。如需全面重整，使用 `/tp-rebuild`。

## 注意事項

- 所有資料讀寫均透過 API，不操作本地 MD 檔案
- 不執行 git commit / push（資料已直接寫入 D1 database）
- 不執行 npm run build（無 dist 產物需產生）

## Markdown 支援欄位

Markdown 支援欄位見 tp-shared/references.md
