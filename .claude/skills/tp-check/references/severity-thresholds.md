# 各規則嚴重度閾值

## 紅綠燈狀態定義

| 狀態 | 符號 | 判定條件 |
|------|------|----------|
| passed | 🟢 | 規則完全符合 |
| warning | 🟡 | 有瑕疵但屬 warn 級，或部分缺失 |
| failed | 🔴 | 不符合 strict 級規則 |

## 各規則閾值

| 規則 | 🟢 passed | 🟡 warning | 🔴 failed |
|------|-----------|------------|-----------|
| R0 | 結構完全正確 | — | 任一結構違規 |
| R1 | foodPreferences 存在且餐廳順序對應 | — | 缺 foodPreferences 或順序錯誤 |
| R2 | 所有天數餐次齊全 | — | 任一天缺少應有餐次 |
| R3 | 所有 restaurants infoBox 達 3 家且資料完整 | 部分 infoBox < 3 家，或 category 錯標 | 餐廳缺 hours/reservation |
| R4 | 所有景點有營業時間且吻合 | 開放場所（公共海灘、商圈）無正式 hours | 景點到訪時間在營業時間外 |
| R7 | 所有非家飯店有 shopping(≥3) + parking | 部分 shop 缺 mustBuy 或數量不足 | 飯店完全無 shopping infoBox |
| R8 | 所有 hotel 有 breakfast 欄位 | — | 任一 hotel 缺 breakfast |
| R10 | 自駕行程還車 event 有 gasStation infoBox | — | 自駕行程缺 gasStation |
| R11 | 所有實體地點有 `maps` 或 `location.googleQuery` | 1~5 個地點兩者皆缺 | > 5 個地點兩者皆缺 |
| R12 | 所有 POI 有 `googleRating` | `source: user` 的 POI 缺 `googleRating` | `source: ai` 的 POI 缺 `googleRating` |
| R13 | 所有非豁免 POI 有 `source` | 1~3 個 POI 缺 `source` | > 3 個 POI 缺 `source` |
| R14 | 韓國行程所有 POI 有 naverQuery；非韓國行程不檢查 | — | 韓國行程 POI 缺 naverQuery |
| R15 | 所有 POI 有 `note` 欄位（含 parking infoBox） | 1~3 個缺 `note` | > 3 個缺 `note` |
| R16 | 所有 hotel POI 有 `maps` + `address` | 1+ 個 hotel 缺 `maps` 或 `address` | — |
| R17 | 所有 POI 至少有 `maps` 或 `lat`+`lng` | — | 任一 POI 兩者皆缺 |
| R18 | 所有 hotel POI 有 `phone` | 1+ 個 hotel 缺 `phone` | — |
