# Phase B：Code Fix 判斷標準與流程

**用 matt skill 自動修，只做到開 PR。** 不 merge、不部署；merge 需 owner 明確同意。

## 鐵律：先 grep，不要猜

**不要因為 Sentry 沒給 file path 就放棄。** 你有整個 codebase — 用 error message grep 找到 source file，再分析根因。

```
每個 issue →
  1. 用 Grep 搜尋 error message / 關鍵字 → 定位 source file
  2. 讀 source，分析根因
  3. 判定：可修 → 報告列出建議修法  |  真的不可修 → 標記原因
```

## 可自動修（預設嘗試修復）

| 類型 | 定位方式 | 修法 |
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

## Code Fix 流程

```
所有可修 issues 共用一個 branch：
  git checkout -b fix/daily-check-autofix-YYYY-MM-DD   （從最新 origin/master）
  → 逐一修復每個 issue（每個 issue 一個 commit）
    → Skill diagnosing-bugs：先建一個對這個 bug 會變紅的指令，確認真的紅
    → Skill tdd：先寫失敗測試並跑到紅燈，再寫最小修法轉綠
    → commit（描述修了什麼）
  → 全部修完後：
    → Skill code-review（fixed point = origin/master；Standards + Spec 兩軸）
    → /tp-code-verify（不可跳過）
    → npm test、tsc 全綠
    → gh pr create（內文遵循 Skill pr，附紅燈輸出）
    → 結果寫入 Telegram 報告（附 PR 連結）
```

**一天只開一個 fix branch + 一個 PR。** 若任一 issue 失敗，標記失敗原因，繼續下一個；PR 只含成功的 fix。**不 merge、不部署**，由 owner 看 PR 後決定。

## 報告內容

`fix-result.json` 每項 `status` 為 `fixed`（已進 PR）／`skipped`／`failed`，`summary` 一行摘要；Telegram 附 PR 連結。
