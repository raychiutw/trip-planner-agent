# Event Type Schema

tp-create Phase 1 骨架生成時，依據以下 schema 判斷每個物件的必填欄位。Phase 1 結尾須遍歷所有物件做骨架完整性掃描，缺漏自動補上。

## Type A: 景點/活動 Event（無 travel 屬性）

| 欄位 | 必填 | 說明 |
|------|------|------|
| time | ✅ | 時間字串，如 `"10:00"` |
| title | ✅ | 景點名稱 |
| description | ✅ | 景點說明 |
| googleRating | ✅ | Google 評分（Phase 1 可省略，Phase 2 搜尋填入） |
| locations | ✅ | 地圖位置陣列 `[{ name, googleQuery, appleQuery }]` |
| infoBoxes | 選填 | 附加資訊區塊 |

## Type B: 交通 Event（有 travel 屬性）

> ⚠️ **travel 語意：從此地「出發」去下一站**（不是「到達此地」）。詳見 tp-shared/references.md。

| 欄位 | 必填 | 說明 |
|------|------|------|
| time | ✅ | 出發時間 |
| title | ✅ | 交通描述 |
| travel | ✅ | `{ text, type, minutes }`，type 為 car/bus/train/walk/monorail |

**禁填**：googleRating、locations — 有 travel 屬性的 event 不可包含這些欄位。

## Type C: 餐廳 Event（含 restaurants infoBox）

| 欄位 | 必填 | 說明 |
|------|------|------|
| time | ✅ | 用餐時間 |
| title | ✅ | 如「午餐」「晚餐」 |
| googleRating | ✅ | 設預設值或 Phase 2 搜尋 |
| locations | ✅ | 至少一個用餐區域的位置 |
| infoBoxes | ✅ | 至少一個 `type: "restaurants"` 的 infoBox |

**每個 restaurant 子物件必填：**

| 欄位 | 必填 | 說明 |
|------|------|------|
| category | ✅ | 料理分類，對應 foodPreferences |
| name | ✅ | 餐廳名稱 |
| description | ✅ | 簡述 |
| price | ✅ | 價位描述 |
| hours | ✅ | 營業時間 |
| reservation | ✅ | 預約資訊物件 |
| googleRating | ✅ | Phase 2 搜尋填入 |
| location | ✅ | `{ name, googleQuery, appleQuery }` |

## Type D: 航班 Event（起飛/降落）

| 欄位 | 必填 | 說明 |
|------|------|------|
| time | ✅ | 起飛/降落時間 |
| title | ✅ | 如「MM922 台北出發」 |
| googleRating | ✅ | 可設 4.0（機場評分） |
| locations | ✅ | 機場位置 |

## Hotel 必填欄位

| 欄位 | 必填 | 說明 |
|------|------|------|
| name | ✅ | 飯店名稱 |
| url | ✅ | 官方或訂房網站（可為 `""`） |
| googleRating | ✅ | Phase 2 搜尋填入 |
| checkout | ✅ | 退房時間（查不到設 `""`） |
| details | ✅ | 飯店詳情陣列 |
| breakfast | ✅ | `{ included: true/false/null, note: "" }` |
| infoBoxes | ✅ | 至少一個 shopping infoBox |

**Hotel 內 shop 子物件必填：**

| 欄位 | 必填 | 說明 |
|------|------|------|
| category | ✅ | 商店分類 |
| name | ✅ | 商店名稱 |
| hours | ✅ | 營業時間 |
| mustBuy | ✅ | 必買清單（≥ 3 項） |
| googleRating | ✅ | Phase 2 搜尋填入 |
| location | ✅ | `{ name, googleQuery, appleQuery }` |

## 骨架完整性掃描（Phase 1 結尾）

Phase 1 骨架生成完成後，須遍歷所有物件檢查：

1. **每個無 travel 的 event**：必須有 locations（可為空陣列）
2. **每個有 restaurants infoBox 的 event**：每個 restaurant 必須有所有必填欄位
3. **每個 hotel**（name ≠ "家"）：必須有 checkout、breakfast、shopping infoBox（≥ 3 shops）
4. **每個 shop**：必須有 category、name、hours、mustBuy（≥ 3）

發現缺漏時自動補上預設值，不需手動撰寫 fix script。
