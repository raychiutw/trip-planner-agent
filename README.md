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

部署：`zsh scripts/deploy.sh` 把 `origin/main` 複製到 `~/.tripline-agent/app`，launchd（api-server、funnel-guard）只跑那份複本，
`.env.local` 與 log 由 `~/.tripline-agent/` 自己持有，不在 git 範圍內。改程式 → 合併到 main → 跑一次 deploy.sh 才會上線。

骨架階段：程式碼與測試已獨立，**尚未切換 production**。launchd 仍指向原專案目錄（跑 deploy.sh 後切到執行目錄）；
`daily-report`、`telegram-smoke` 兩個 workflow 的 job 以 repo variable `AGENT_WORKFLOWS_ENABLED=true` 才會執行，
設定好本 repo 的 secrets 之前保持停用。

## 來源 IP 限制

api-server 只綁 `127.0.0.1`，並只接受本機與 Cloudflare 公開網段的來源，其餘一律 403（簽章驗證之前就擋）。
Funnel 流量經 Tailscale → Caddy 轉進來，對端永遠是 loopback，真實來源在 `X-Forwarded-For`，所以：

- Caddyfile 的 global options **必須**有 `servers { trusted_proxies static 127.0.0.1/32 }`，否則 Caddy 會把
  `X-Forwarded-For` 改寫成 `127.0.0.1`。agent 看到帶 `Tailscale-Funnel-Request` 卻來源是 loopback 的請求會直接擋掉
  （fail closed），所以漏設的症狀是 Cloudflare 打 `/trigger`、`/internal/mail/send` 全部 403，log 出現 `funnel-not-cloudflare`。
- **上線順序**：先改 Caddyfile 並 reload（對舊版 agent 無害），再 `zsh scripts/deploy.sh`。
- Caddy 層也可再加一道 `@notAllowed not client_ip ... respond 403`（網段同 `scripts/lib/ip-allowlist.ts`）。
- Cloudflare 網段是 `ip-allowlist.ts` 裡的靜態清單（來源 https://www.cloudflare.com/ips-v4 、`/ips-v6`），
  Cloudflare 公告異動時手動更新。
- 回復：在 `~/.tripline-agent/.env.local` 加 `TRIPLINE_IP_ALLOWLIST=off` 後重新部署（啟動 log 會警告）。
- 從 tailnet 裝置打 agent 會被擋；要除錯請從本機打。拒絕紀錄在 api-server 的 log（`ip reject: <原因> ip=...`，同一來源每分鐘一行）。

## 設定

所有 secret 從 `.env.local` 載入（不進 repo）。`TELEGRAM_CHAT_ID`、`ADMIN_EMAIL_OVERRIDE`（provision 腳本用）等
個人識別資訊一律由環境提供，程式碼不內建預設值。
