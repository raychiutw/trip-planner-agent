# Doc 結構規格與 Markdown 支援欄位

## Markdown 支援欄位

前端會渲染 markdown 的欄位（可用粗體、列表、連結）：

| 欄位 | 支援 | 說明 |
|------|:---:|------|
| `entry.description` | ✅ | 景點描述 |
| `entry.note` | ✅ | master POI 備註（來源是 `trip_entry_pois.note`，不是已 DROP 的 `trip_entries.note`） |
| `restaurant.description` | ✅ | 餐廳描述 |
| `entry.title` | ❌ | 純文字 |
| `restaurant.name` | ❌ | 純文字 |
| `hotel.name` | ❌ | 純文字 |

## Doc 結構規格（鐵律）

`PUT /api/trips/{tripId}/docs/{type}` 的 Body 為 `{ title, entries: [{section, title, content}] }`。

API 回傳 `{ doc_type, title, updated_at, entries: [{id, sort_order, section, title, content}] }`。

前端統一用 `DocCard` 渲染所有 doc type。DocCard 按 `section` 分組顯示，每個 entry 渲染 `title` + `content`（content 支援 markdown）。

> ⚠️ **entries 結構必須讓 DocCard 能正確渲染**：

| 欄位 | 用途 | 範例 |
|------|------|------|
| `section` | 群組標題（同 section 的 entries 歸為一組） | `"證件"`, `"緊急電話"`, `""` |
| `title` | entry 主標題（粗體顯示） | `"護照"`, `"CI-123 去程"`, `"110 報案"` |
| `content` | 詳細內容（支援 markdown，含連結 `[text](url)`） | `"TPE → OKA\n08:30-11:00"`, `"[110](tel:110)"` |

**各 doc type 建議 entries 結構：**

| doc type | section 用法 | entry 範例 |
|----------|-------------|-----------|
| **flights** | `""` (無分組) | `{title: "去程 CI-123", content: "TPE→OKA\n08:30-11:00"}` |
| **checklist** | 分類名稱 | `{section: "證件", title: "護照", content: ""}` |
| **backup** | 備案主題 | `{section: "雨天備案", title: "室內景點A", content: "描述"}` |
| **suggestions** | 優先級 | `{section: "推薦必去", title: "景點名", content: "原因"}` |
| **emergency** | 分類 | `{section: "緊急電話", title: "110 報案", content: "[110](tel:110)"}` |

**向後相容：** PUT 仍接受舊格式 `{ content: JSON字串 }`，API 自動轉為單一 entry 存入。但新建行程應一律用新格式。

### Doc 連動規則（鐵律）

> ⚠️ **每次異動 trip 相關資料（trip_days / trip_entries / trip_entry_pois / hotel_poi_id），必須重新檢視該行程所有 doc type 並更新不一致的內容。**

這不是「若影響到就更新」的條件式判斷，而是**強制連動**：行程資料變了，doc 必須跟著校準。

| doc type | 連動觸發條件 | 典型需更新場景 |
|----------|-------------|---------------|
| **checklist** | entry/POI 新增或刪除 | 新景點需帶的物品、新餐廳訂位提醒 |
| **backup** | entry 異動 | 雨天備案需覆蓋新行程的時段和地區 |
| **suggestions** | entry/POI 異動 | 推薦清單應反映尚未排入的景點 |
| **flights** | trip meta 或首末日異動 | 航班資訊變更（較少觸發） |
| **emergency** | trip meta 異動或新增城市 | 新地區的緊急電話/大使館 |

**執行方式：**
1. 完成 trip 資料修改後，`GET /api/trips/{tripId}/docs/{type}` 讀取現有 5 種 doc
2. 比對修改內容，判斷哪些 doc 需要更新
3. 對需更新的 doc 執行 `PUT /api/trips/{tripId}/docs/{type}`
4. 若無任何 doc 需更新，跳過即可（但必須經過檢視步驟）
