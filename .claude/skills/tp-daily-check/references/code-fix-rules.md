# Phase B：Code Fix 判斷標準與流程

## 鐵律：先 investigate，不要猜

**不要因為 Sentry 沒給 file path 就放棄。** 你有整個 codebase — 用 error message grep 找到 source file，然後修。

```
每個 issue →
  1. 用 Grep 搜尋 error message / 關鍵字 → 定位 source file
  2. 用 /investigate 分析根因（如需要）
  3. 判定：可修 → fix  |  真的不可修 → 標記原因
```

## 可自動修（預設嘗試修復）

| 類型 | 定位方式 | 修法 |
|------|---------|------|
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

## Code Fix 流程

```
所有可修 issues 共用一個 branch：
  git checkout -b fix/daily-check-autofix-YYYY-MM-DD
  → 逐一修復每個 issue（每個 issue 一個 commit）
    → /investigate（根因分析）
    → 寫 code（遵守 tp-team Build 規則）
    → commit（描述修了什麼）
  → 全部修完後一次性走 review pipeline：
    → /tp-code-verify（不可跳過）
    → /review（不可跳過）
    → /cso --diff（不可跳過）
    → /ship（建 1 個 PR，包含所有 fix commits）
    → /land-and-deploy（merge + deploy）
    → 結果寫入 Telegram 報告
```

**一天只開一個 fix branch + 一個 PR。** 若任一 commit 失敗，標記失敗原因，繼續下一個 issue。最終 PR 只包含成功的 fix。
