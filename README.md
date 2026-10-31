# trip-planner-agent

Tripline 的 **agent** 專案：跑在擁有者本機（Mac mini）的服務，從原本的 `trip-planner` 專案獨立出來。
拆分計畫見 [trip-planner#1462](https://github.com/raychiutw/trip-planner/issues/1462)（ADR-0011）。

## 內容

- `scripts/tripline-api-server.ts` — 本機 api-server（tmux 驅動 contained `claude -p`、內建多 schedule cron、`/health`）。
- `scripts/lib/`、`scripts/_lib/` — 請求 worker、contained spawn、寄信、Telegram、D1 client 等共用模組。
- `scripts/tp-request-mcp-server.js`、`scripts/tp-request-contained/` — tp-request 的 MCP server 與隔離設定。
- `scripts/daily-check.js`、`scripts/daily-report.js` — 每日健檢與報告。
- `scripts/funnel-guard/`、`scripts/mac-mini-cron-patch/`、`scripts/*.plist` — Funnel 守護與 launchd 設定。
- `.claude/skills/tp-*` — contained claude 改行程時使用的 data skills。
- `tests/unit/` — 只驗 agent 自己的行為；斷言 web／api 檔案的跨專案測試仍留在 `trip-planner`。

## 開發

```bash
npm ci
npm test
```

## 狀態

骨架階段：程式碼與測試已獨立，**尚未切換 production**。launchd 仍指向原專案目錄；
`daily-report`、`telegram-smoke` 兩個 workflow 的 job 以 repo variable `AGENT_WORKFLOWS_ENABLED=true` 才會執行，
設定好本 repo 的 secrets 之前保持停用。

## 設定

所有 secret 從 `.env.local` 載入（不進 repo）。`TELEGRAM_CHAT_ID`、`ADMIN_EMAIL_OVERRIDE`（provision 腳本用）等
個人識別資訊一律由環境提供，程式碼不內建預設值。
