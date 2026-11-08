# Phase B：Code 診斷判斷標準與流程

**本階段只診斷與回報，不自動修。** 不開 branch、不改 code、不開 PR、不 merge、不部署；修復由 owner 決定。

## 鐵律：先 grep，不要猜

**不要因為 Sentry 沒給 file path 就放棄。** 你有整個 codebase — 用 error message grep 找到 source file，再分析根因。

```
每個 issue →
  1. 用 Grep 搜尋 error message / 關鍵字 → 定位 source file
  2. 讀 source，分析根因
  3. 判定：可修 → 報告列出建議修法  |  真的不可修 → 標記原因
```

## 可修類型（報告中列出建議修法）

| 類型 | 定位方式 | 建議修法 |
|------|---------|---------|
| React render error | grep error message → 找到 component | 修正 render 邏輯 |
| API auth error（自家 caller） | grep 401/403 的 API path → 找到 caller | 修正 auth header |
| Dynamic import failure | grep module path → 檢查 build output | 重新 build 或修 import |
| N+1 pattern | grep Sentry issue title → 找到呼叫點 | 合併 API 呼叫 |
| Infinite loop / update depth | grep setState + useEffect → 找到 component | 修正 dependency |
| 效能問題（P50/P99 偏高） | 分析 Workers analytics → 找到慢 endpoint | 優化 handler |

## 真正不可修（才標記「需人工處理」）

只有以下情況才允許標記「需人工」，且必須附上嘗試過的步驟：

| 類型 | 範例 | 為什麼不可修 |
|------|------|------------|
| 第三方 API 完全掛掉 | Cloudflare API 502 | 我方無法修對方 |
| npm critical + breaking change | major version bump 需要改 API | 影響範圍太大 |
| 需要新 migration | DB schema 不支援 | 需要 migration plan review |

**「Sentry 缺 file path」「找不到 source」不是放棄的理由。** grep 找。

## 報告內容

每個 issue 一段：source file 與行號、根因、建議修法、為什麼不自動修（一律是「本階段不自動修」）。結果寫入 Telegram 報告與 `fix-result.json`：每項 `status` 一律填 `skipped`，`summary` 寫診斷結論與建議修法（`fixed` 恆為 0）。
