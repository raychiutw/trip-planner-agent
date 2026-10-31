---
name: tp-check
description: 驗證行程品質時使用 — 對照 R0-R18 規則檢查，輸出紅綠燈報告，唯讀不改資料（品質檢查、驗證、紅綠燈、validate）。要修復違規用 /tp-rebuild，要改資料用 /tp-edit。
user-invocable: true
---

對指定行程逐項檢查 R0-R18 品質規則，輸出紅綠燈驗證 report。只讀不改，不修改任何資料。

⚡ 核心原則：不問問題，直接驗證。

## API 設定

讀取操作為公開存取，無需認證。完整 API 設定見 `tp-shared/references.md`。

## 輸入方式

- 指定 tripId：`/tp-check okinawa-trip-2026-Ray`
- 未指定：呼叫 `GET /api/trips` 列出所有行程供選擇

## 步驟

1. 讀取行程資料：
   ```bash
   # 讀取 meta
   curl -s "https://trip-planner-dby.pages.dev/api/trips/{tripId}"
   # 讀取所有天概要（取得天數清單）
   curl -s "https://trip-planner-dby.pages.dev/api/trips/{tripId}/days"
   # 依序讀取每天完整資料
   curl -s "https://trip-planner-dby.pages.dev/api/trips/{tripId}/days/{N}"
   ```
2. 逐項檢查 R0-R18 品質規則（API 回傳 JSON，直接驗證 JSON 欄位）
3. 依檢查結果輸出 report（完整模式或精簡模式）

🚫 不修改任何資料。tp-check 是純驗證工具。

## JSON 欄位對照

API 回傳 JSON 格式，直接驗證以下欄位：

| 欄位 | 說明 |
|------|------|
| `maps` 或 `location.googleQuery` | R11 地圖導航（entry 有 `maps` 即合格，`location` JSON 為加分） |
| `googleRating` | R12 評分 |
| `meta.countries` | 陣列格式（如 `["JP"]`） |
| `meta.foodPreferences` | 陣列格式 |
| `source` | R13 來源標記（`"ai"` 或 `"user"`） |
| `note` | R15 必填備註 |
| `location.naverQuery` | R14 韓國行程 Naver Maps URL |

## Report 模式

完整模式 / 精簡模式的格式模板見 `references/report-format.md`。

- **完整模式**：standalone 或 before/after-fix，含 summary + rule table + detail
- **精簡模式**：`tp-check: 🟢 N  🟡 N  🔴 N`（嵌入其他 skill 尾部）

## R2 合格餐次 entry 判定

以下才算「該餐次已安排」：
- timeline entry 的 title 明確包含「午餐」或「晚餐」字樣（如「恩納午餐」「機場晚餐」）
- 一日遊團體行程 entry title 含「午餐（團體行程已含）」（R2 豁免，不附 restaurants infoBox）

以下**不算**合格餐次 entry：
- 其他 entry title 中附帶「含午餐」字樣（如「MEGA唐吉軻德（含午餐）」）→ 這是購物行程，不是正式餐次安排
- description 中提到食物但 title 不含餐次關鍵字
- restaurants infoBox 出現在非餐次 entry 下（如景點附帶推薦，屬加分但不計入餐次）

## 紅綠燈狀態定義

各規則的 🟢/🟡/🔴 閾值與判定條件見 `references/severity-thresholds.md`。

## 嵌入其他 skill 的方式

| Skill | 何時執行 tp-check | 模式 |
|-------|-------------------|------|
| `/tp-check` | 獨立執行 | 完整 |
| `/tp-rebuild` | 修正前 + 修正後 | 完整 x2 |
| `/tp-edit` | 修改完成後 | 精簡 |
| `/tp-request` | 每個請求處理完後 | 精簡 |
| `/tp-rebuild --all` | 每趟修正後 | 完整 |

## 常見誤判

| 誤判 | 正解 |
|------|------|
| entry 有 `maps` 但無 `location.googleQuery` → 判 R11 fail | ❌ `maps` 即合格（PUT /days/:num 只接受 `maps`） |
| `maps` 或 `googleQuery` 不是完整 URL → 判 R11 fail | ❌ 填搜尋文字即可 |
| JSON 中 `source` 欄位不存在但「整體覆蓋率尚可」→ 判 R13 🟢 | ❌ > 3 個缺失即 🔴 |
| parking infoBox 無 note → 忽略 | ❌ R15 明確包含 parking infoBox |
