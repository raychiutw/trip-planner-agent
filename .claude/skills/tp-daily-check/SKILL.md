---
name: tp-daily-check
description: 每日健康檢查時使用 — 跑 daily-check.js 產出報告 → 自動修復 → 發送 Telegram 摘要（每日檢查、daily check、健康檢查）。單趟行程驗證用 /tp-check。
user-invocable: true
---

每日健康報告 — 整合 Phase 1（產報告）+ Phase 2（資料/Code fix）+ Phase 3（Telegram）。api-server 內建 cron 每日 06:10 自動觸發；手動觸發直接在 Claude Desktop / Code 輸入 `/tp-daily-check`。

## 排程

由 `scripts/tripline-api-server.ts` 內建 cron 觸發（透過 ephemeral tmux session），工作目錄是 `~/.tripline-agent/app`。不需要、也不要在 Claude Desktop 另建 scheduled task，否則會重複觸發。

## 步驟

### Phase 1: 產出報告 JSON

```bash
cd ~/.tripline-agent/app

# load .env.local 拿 CLOUDFLARE_API_TOKEN / SENTRY_AUTH_TOKEN 等 secret
eval "$(node scripts/lib/load-env.mjs .env.local)"

# log directory + rotation (與舊 scheduler 相同 pattern)
LOG_DIR="scripts/logs/daily-check"
mkdir -p "$LOG_DIR"
find "$LOG_DIR" \( -name "*.log" -o -name "*-report.json" \) -mtime +7 -delete 2>/dev/null || true

# 跑 daily-check.js 產出今日 report
LOG_FILE="$LOG_DIR/$(date +%Y-%m-%d).log"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Phase 1: daily-check.js" >> "$LOG_FILE"
node scripts/daily-check.js >> "$LOG_FILE" 2>&1

REPORT_JSON=$(ls -t "$LOG_DIR"/*-report.json 2>/dev/null | head -1)
echo "Report: $REPORT_JSON"
```

### Phase 2: 自動修復

讀 `$REPORT_JSON`，對每個 issue 做：

**Phase A：資料修復**（API 呼叫，秒級完成）
- request status 卡在 received/processing/failed → PATCH → open
- api-server error log 中 request 卡住 → PATCH → open
- daily-check error log 中上次修復失敗 → 重試一次

**Phase B：Code Fix**（matt skill：diagnosing-bugs → tdd → code-review → PR，分鐘級）— **不可跳過**
- 對報告中每個 warning/critical issue，必須執行以下 checklist：
  ```
  □ grep error message / API path → 找到 source file
  □ 讀取 source file，分析根因
  □ 判定：可修 → 開 fix branch 修  |  真的不可修 → 附上 grep 結果證明
  ```
- **「0 users」「超過 7 天」「非 code bug」不是跳過的理由** — 只要 Sentry 有 unresolved issue 就嘗試修
- **API 4xx 必須 grep 呼叫端** — 查是哪個 script/skill 發的，auth header 有沒有帶對
- 對每個可修 issue：在當前 session 內呼叫 Skill `diagnosing-bugs`（先建會變紅的指令）→ Skill `tdd`（失敗測試真的紅燈後才修）→ commit；全部修完後呼叫 Skill `code-review`（fixed point = `origin/master`）→ `/tp-code-verify` → 用 `gh pr create` 開 1 個 PR（內文遵循 Skill `pr`）。當前 session 內一氣呵成，不再 spawn 新 claude process
- **只做到開 PR，不 merge、不部署**：merge 需 owner 明確同意，CI 綠後由 owner 處理
- 修不了的必須附上「嘗試了什麼 + grep 結果 + 為什麼修不了」

把修復結果寫到 `scripts/logs/daily-check/YYYY-MM-DD-fix-result.json`：
```json
{
  "total": 3, "fixed": 2, "failed": 1,
  "pr_url": "https://github.com/.../pull/160",
  "details": [
    {"status": "fixed", "summary": "ManagePage SSE infinite loop"},
    {"status": "fixed", "summary": "InfoBox render object as child"},
    {"status": "skipped", "summary": "N+1 需架構重構"}
  ]
}
```
`details` 每項必填 `status`（fixed/skipped/failed）和 `summary`（一行摘要）。

### Phase 3: Telegram 通知

```bash
FIX_RESULT="${REPORT_JSON%-report.json}-fix-result.json"

# Build message（含 fix-result 摘要 if exists）
MSG=$(node scripts/lib/build-daily-check-msg.js "$REPORT_JSON" "$FIX_RESULT")

# Send
bash scripts/lib/send-telegram.sh "$MSG"
```

## Phase B 判斷標準

Code fix 的判斷標準、可修/不可修分類、完整修復流程詳見 `references/code-fix-rules.md`。

摘要：先 grep 定位 source → `diagnosing-bugs` 分析根因 → `tdd` 修 → `code-review` → 開 PR（不 merge、不部署）。

## Telegram 格式與修復範圍

Telegram 報告格式（有問題/全綠）和 Phase A/B 修復範圍詳見 `references/telegram-format.md`。

## 環境需求

- 由 `scripts/tripline-api-server.ts` 內建 cron 在每日 06:10 透過 ephemeral tmux session 觸發；user shell env 透過 `scripts/lib/load-env.mjs` 載入 `.env.local`
- `.env.local` 需有：`CLOUDFLARE_API_TOKEN`、`CF_ACCOUNT_ID`、`D1_DATABASE_ID`、`SENTRY_AUTH_TOKEN`、`SENTRY_ORG`、`SENTRY_PROJECT`、`TELEGRAM_BOT_HOME_TOKEN`（或 `TELEGRAM_BOT_TOKEN`）、`TELEGRAM_CHAT_ID`
- Code fix 需要 git / npm / `gh`，以及 matt skill（diagnosing-bugs、tdd、code-review、pr；皆可自主呼叫）

## Self-destruct（tmux 觸發 only — v2.31.3+）

skill **任何 termination path 之最後一步必跑**（含 Phase A 全綠提早結束、Phase B 完成、中途 fatal error abort）：

```bash
# scripts/tripline-api-server.ts 內建 cron 透過 ephemeral tmux session 觸發本 skill 時
# 會 inject TRIPLINE_TMUX_SESSION + TMUX_BIN env var。執行完砍 session 避免 orphan。
# 手動 invoke（無 env var）→ skip。
if [ -n "$TRIPLINE_TMUX_SESSION" ]; then
  "${TMUX_BIN:-tmux}" kill-session -t "$TRIPLINE_TMUX_SESSION" || \
    echo "[tp-daily-check] WARNING: kill-session failed for $TRIPLINE_TMUX_SESSION" >&2
fi
```

> ⚠️ 在所有 Sentry / Telegram / GitHub Issue 動作完成、reply 寫入後執行。中途 kill 會打斷 in-flight curl。
