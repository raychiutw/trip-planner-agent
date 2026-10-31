# mac mini cron patch — v2.22.0 poi-favorites-rename

PR #474 merge 前最後一道 user 動作：mac mini cron 改 `/api/saved-pois*` →
`/api/poi-favorites*` + auth 從 CF-Access bypass 改 OAuth client_credentials mint。

## 一條 push 指令（在這台 Mac 跑）

```bash
# 替換 <mac-mini-host> 為 ssh hostname / IP / tailscale name
rsync -avz --delete \
  ~/Projects/trip-planner/scripts/mac-mini-cron-patch/ \
  <mac-mini-host>:~/tripline-cron-update/
```

## 在 mac mini 跑（SSH 進去後）

```bash
ssh <mac-mini-host>

# 1) 補 .env client_credentials 變數
cat ~/tripline-cron-update/env.template
# 對照後 append 缺的變數：
echo 'TRIPLINE_API_CLIENT_ID=tripline-internal-cli' >> ~/.tripline-cron/.env

# CLIENT_SECRET 從擁有者帳號的 .env.local TRIPLINE_API_CLIENT_SECRET 複製
read -rs CS && echo "TRIPLINE_API_CLIENT_SECRET=$CS" >> ~/.tripline-cron/.env && unset CS
chmod 600 ~/.tripline-cron/.env

# 2) 跑 patch
bash ~/tripline-cron-update/apply-patch.sh
# 提示 [y/N]，看完 diff 確認 → y
# 自動：backup → patch → syntax check → mint smoke → grep clean
```

## patch 內容

`apply-patch.sh` 對 `~/.tripline-cron/tp-request-scheduler.sh` 做：

1. **base URL**：`/api/saved-pois*` → `/api/poi-favorites*` (sed 全 file)
2. **auth header**：移除 `-H "CF-Access-Client-Id: ..."` / `-H "CF-Access-Client-Secret: ..."`
3. **inject mint helper**：scheduler 開頭加 `tp_mint_token()` + 自動 mint `TRIPLINE_API_TOKEN`
   export 給後續 curl 使用 → `-H "Authorization: Bearer $TRIPLINE_API_TOKEN"`

mint 邏輯每 cron run 一次（OAuth client_credentials grant），run 完 token 自然 expire。
不寫盤、不 cache（簡單但每 hr 多 1 次 token mint，量級 negligible）。

## 安全保證

- 自動 backup 到 `*.bak.YYYYMMDD-HHMMSS`，patch 失敗 / syntax error 自動 restore
- `chmod +x` 維持 executable
- `[y/N]` confirm — 不 y 不寫
- secret 不入 cron log（`set -a; source .env; set +a` 仍會把 var 進 ENV，但 mint 本身用 curl，secret 只在記憶體）

## 完成後 PR description 要加證據

跑完手動驗證 1 次：
```bash
bash ~/.tripline-cron/tp-request-scheduler.sh 2>&1 | head -20
```

把 output 貼進 PR #474 description（mask CLIENT_SECRET），證明 mint + curl 200 OK。
