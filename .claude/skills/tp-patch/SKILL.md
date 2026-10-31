---
name: tp-patch
description: 批量補齊 POI 欄位時使用 — 跨行程填入 rating、address、phone、hours、location（補齊、批次更新、缺 phone、缺 rating）。單一行程內容修改用 /tp-edit。
user-invocable: true
---

跨行程 POI 欄位與 entry 座標批次補齊工具。掃描 pois 表缺漏欄位，WebSearch 查詢後用 PATCH 更新。也可為 trip_entries 補齊地圖與 travel 計算所需的 location 座標。

API 設定見 `tp-shared/references.md`。

## 指令格式

```
/tp-patch --target <target> --field <field> [--trips <tripId,...>] [--dry-run]
```

- `--target`（必填）：`hotel` | `restaurant` | `shopping` | `parking` | `entry` | `all`
- `--field`（必填）：`rating` | `address` | `phone` | `hours` | `location` | `all`（migration 0045 後 pois 表欄位 `google_rating` 已 rename 為 `rating`、`maps` 已 DROP。**PATCH /api/pois Body 必須用 `rating`，不接受 `google_rating` 別名** — 白名單只認 `rating`，舊欄名會被 silent drop 導致 400「無有效欄位可更新」。）
- `--trips`（選填）：逗號分隔的行程 tripId，預設為所有行程
- `--dry-run`（選填）：只輸出缺漏報告，不修改資料

未提供必填參數時顯示使用說明，不執行操作。

POI 欄位規格見 `tp-shared/references.md`（v2.29.0 後：`pois` master vs `trip_entry_pois` entry-level metadata；`trip_pois` 整表已 DROPPED）。

## 步驟

### Phase 1：掃描

1. 取得目標行程清單：
   ```bash
   curl -s "https://trip-planner-dby.pages.dev/api/trips?all=1" \
     -H "Authorization: Bearer $TRIPLINE_API_TOKEN" \
   ```
2. 對每個行程讀取所有天資料，收集所有 POI（含 poi_id）和 entry（含 entry_id）
3. 依 `--target` 篩選：POI type（hotel/restaurant/shopping/parking）或 entry
4. 依 `--field` 檢查缺漏：
   - POI 欄位：NULL 或空字串
   - location：trip_entries.location 為 NULL 或空字串（且該 entry 有 maps 或 title 可供 geocode）
5. 輸出掃描摘要：「共 N 個 {target} 需補齊 {field}」+ 明細

### Phase 2：查詢補齊（依欄位選擇最佳工具）

6. 依欄位類型選擇查詢策略：

   **rating → 查詢策略見 tp-shared/references.md「googleRating 查詢策略」**（browse-first，WebSearch 僅做 fallback；PATCH /api/pois Body 用 `{ rating: X.X }`）

   **address / phone → WebSearch 即可**
   - 搜尋 "{POI name} 住所" 或 "{POI name} 地址"
   - 這類資訊在搜尋摘要中通常有

   **location（geocoding）→ 查詢策略：**
   1. 從 entry 的 `maps` 欄位取得地點名稱（`maps` 是 Google Maps 搜尋 URL，取最後的搜尋詞）
   2. 若 entry 無 `maps`，用 `title` 作為搜尋詞
   3. WebSearch「{地點名稱} 座標 經緯度」或「{地點名稱} GPS coordinates」
   4. 從搜尋結果中提取 lat/lng 數字
   5. 若搜尋不到座標，嘗試用地址搜尋：WebSearch「{地點名稱} 地址」→ 取得地址後再搜尋「{地址} 座標」
   6. 組成 location JSON：`[{name, googleQuery, appleQuery, lat, lng, geocode_status: "ok"}]`

   **同時更新 pois.lat/lng**：若該 entry 有關聯的 POI（透過 `trip_entry_pois.poi_id`），且 POI 的 lat/lng 為 NULL，一併用 `PATCH /pois/:id` 更新座標

7. 搜尋不到 → 執行「歇業/不存在 POI 偵測與清理」（見 tp-shared/references.md §5）：符合條件依新流程刪 alternates / swap master / 換 hotel，必要時 `DELETE /api/pois/:id`（admin only），否則跳過不填預設值

### Phase 3：寫入

8. **POI 欄位**（rating/address/phone/hours/lat/lng）：
   用 `PATCH /pois/:id` 更新 master POI

9. **location 座標**：
   用 `PATCH /trips/:tripId/entries/:entryId` 更新 trip_entries.location：
   ```bash
   curl -s -X PATCH \
     -H "Authorization: Bearer $TRIPLINE_API_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"location": "[{\"name\":\"...\",\"lat\":...,\"lng\":...,\"geocode_status\":\"ok\"}]"}' \
     "https://trip-planner-dby.pages.dev/api/trips/{tripId}/entries/{entryId}"
   ```

   curl 模板見 `tp-shared/references.md`（Windows encoding：用 node writeFileSync + --data @file）。

10. **travel 重算**（location 補齊後，v2.24.0+）：
    - 呼叫 `POST /api/trips/{tripId}/recompute-travel?day=all` 一次
    - Backend 自動跑 1km gate Haversine + Google Routes，寫 `trip_segments`
    - `mode='transit'` 既有 segment 不覆寫（user 手填分鐘保留）
    - recompute 會 trip-wide prune 不再相鄰的幽靈段
    - **不再手動算或 PATCH `travel_type/desc/min`** — segments 為 SoT
    - 規則詳見 tp-shared/references.md §4「travel 重算」
11. 輸出結果報告：補齊數 / 失敗數 / 仍缺漏數 / segments 重算 pair 數（從 recompute response 取）
12. 不自動 commit（資料已直接寫入 D1 database）

## 範例

```bash
# 為所有飯店補上 rating
/tp-patch --target hotel --field rating

# 只看缺漏報告不修改
/tp-patch --target all --field all --dry-run

# 為指定行程的 POI 補齊所有欄位
/tp-patch --target all --field all --trips okinawa-trip-2026-HuiYun

# 為指定行程補齊 entry 座標（地圖與 travel 計算需要）
/tp-patch --target entry --field location --trips yilan-trip-2026-banqiaocircle

# 為所有行程補齊座標
/tp-patch --target entry --field location
```

## 注意事項

- 所有資料讀寫均透過 API，不操作本地檔案
- POI 欄位用 `PATCH /pois/:id`（admin 或帶 tripId 的有權限使用者）更新 master POI
- location 座標用 `PATCH /trips/:id/entries/:eid` 更新 trip_entries
- location 更新時若 entry 有關聯 POI，會一併更新 pois.lat/lng
- 不執行 git commit / push
