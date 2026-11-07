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
Funnel 流量經 Tailscale → Caddy 轉進來，對端永遠是 loopback，真實來源在 `X-Forwarded-For`。兩層防線：

1. **Caddy**（`/opt/homebrew/etc/Caddyfile`，不在 repo）：global options 要有
   `servers { trusted_proxies static 127.0.0.1/32 ::1/128 ; trusted_proxies_strict }`，
   否則 Caddy 會把 `X-Forwarded-For` 改寫成 `127.0.0.1`；`/tripline/api/*` 的 `route` 內：
   帶 `Tailscale-Funnel-Request` 且 `client_ip` 是本機 → 403；`not client_ip 127.0.0.0/8 ::1/128 <Cloudflare 網段>` → 403。
   只限 `/tripline/api/*`，不影響 `/openclaw`。`trusted_proxies` 是全域設定，轉給 openclaw 的 XFF 會從一律 `127.0.0.1` 變成真實來源。
2. **agent**（`scripts/lib/agent-http.ts` + `scripts/lib/ip-allowlist.ts`）：對端必須是 loopback；有 XFF 時第一段是真實來源，
   須在 Cloudflare 網段，其後跳點須是 loopback；帶 `Tailscale-Funnel-Request` 但來源是 loopback 或沒有 XFF → 擋（Caddy 漏設時 fail closed）。

- **上線順序（硬性前置）**：先改 Caddyfile 並 reload（對舊版 agent 無害），再 `zsh scripts/deploy.sh`；順序反過來，Cloudflare 的請求會全部被擋。
- Cloudflare 網段是靜態清單，Caddyfile 與 `ip-allowlist.ts` 兩處要一起改（來源 https://www.cloudflare.com/ips-v4 、`/ips-v6`，2026-11-07），
  Cloudflare 公告異動時手動更新。
- **已實測（2026-11-07）**：直連 Funnel edge 公網 IP，Caddy 看到 `X-Forwarded-For` = 呼叫端真實公網 IP、`Tailscale-Funnel-Request: ?1`；
  非 Cloudflare 來源在 Caddy 層回 403。
- **Cloudflare 端已實測（2026-11-07）**：prod 網頁按「忘記密碼」，Cloudflare Worker 的 `fetch()` 通過 Caddy 與 agent 兩層限制，
  agent log 出現 `mail sent: template=forgot-password`，email audit 狀態 `sent`，沒有 `ip reject`。
  agent 因此確認吃得下 Caddy 轉來的 `<Cloudflare IP>, 127.0.0.1`。
- **症狀對照**：Caddy 層擋掉的請求不會進 agent log，Cloudflare 端會收到 403；`530` 則是 Cloudflare 連不上來源
  （例如 Pages 的 `TRIPLINE_API_URL` 主機名稱解析不到），與 IP 限制無關。排查時先看 D1 `audit_log`（`table_name='email'`）的 `diff_json.error`。
  2026-10-28 起寄信與即時觸發一直 530，原因就是 Pages production 的 `TRIPLINE_API_URL` 指到解析不到的舊主機名稱，2026-11-07 已更正。
  deploy agent 之後，agent 層的拒絕會在 log 出現 `ip reject: <原因> ip=<來源>`（同一來源每分鐘一行）。
- **回復**：Caddy 層：還原 `Caddyfile.bak-20261107` 後 `caddy reload --config /opt/homebrew/etc/Caddyfile --adapter caddyfile`
  （不要用 `caddy stop`，它會停掉線上 Caddy）。agent 層：在 `~/.tripline-agent/.env.local` 加 `TRIPLINE_IP_ALLOWLIST=off` 後重新部署（啟動 log 會警告）。
- 從 tailnet 裝置打 agent 會被擋；要除錯請從本機打。

## 設定

所有 secret 從 `.env.local` 載入（不進 repo）。`TELEGRAM_CHAT_ID`、`ADMIN_EMAIL_OVERRIDE`（provision 腳本用）等
個人識別資訊一律由環境提供，程式碼不內建預設值。
