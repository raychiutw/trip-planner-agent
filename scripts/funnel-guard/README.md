# funnel-guard

Tailscale funnel `:443` drift 自動偵測 + 復原 + Telegram alert（launchd job，每 120s）。

## 為何

macOS update / GUI app / 第三方 brew 反覆把 funnel `:443` 改成 `serve` (tailnet only) → CF Worker public `fetch(TRIPLINE_API_URL + '/trigger')` 全 530。已第 3 次（v2.33.111 紀錄）。

走「auto-heal + alert」比試圖封鎖 Tailscale CLI 實際 — `tailscaled` 的 localapi socket 設計上開放給任何 local process。

## 行為

每 120 秒（launchd `StartInterval`）跑三層健康檢查，全過才算 healthy：

1. **L1 local** — `tailscale serve status --json`：
   - `AllowFunnel[*:443] == true`（區別 funnel vs serve）
   - `Web[*:443].Handlers["/"].Proxy == "http://127.0.0.1:8080"`
2. **L2 DNS** — authoritative NS（dnsimple）有 funnel hostname 的 A record（= 控制平面已對外發布）
3. **L3 reach** — 對 authoritative 回傳的**每個** edge IP 做 direct HTTPS reach，任一通即算對外可達（TLS + 任何 HTTP response 都算通）

任一層不過 → `tailscale serve reset` + `tailscale funnel --bg --https=443 http://127.0.0.1:8080`，重設後再驗：
- 成功 → Telegram 通知「已自動 reset」
- 失敗 → Telegram 通知「heal 後仍 unhealthy，請手動檢查」

> **L3 探測所有 edge 而非只探第一個**（2026-09-01 incident）：Tailscale 對 funnel hostname 發布多個 ingress edge（如 `103.84.155.153` / `.217`），真實 client（CF Worker / 瀏覽器 / curl）拿到整份 A record 清單，第一個不通會自動 fallback。舊版 `funnel_resolve_authoritative` 用 `head -1` 恆定只探第一個 —— 整份 log 528 次 L3 fail 全部是同一個 IP，另一個 edge 從未被探測過。該 edge 一抖動就判整個 funnel 壞 → `serve reset`（對 edge 側問題無效，且 reset 瞬間 funnel 真的 off，反而加重）→ 單日 159 次誤報、38 次 heal（36 次無效）、20 則 Telegram。現在逐一探測每個 edge，任一通即 healthy，全部不通才 heal。**IPv6 刻意不探** —— 本機無 IPv6 出口（AAAA edge `curl exit=7`），探不到不代表服務壞，納入只會製造新的誤報來源。
>
> 部分 edge 不通但服務仍可達時，log 會出現 `L3 部分 edge 不可達但服務仍可達，不 heal (...)`，用來追蹤單一 edge 的長期劣化。

> **探測上限與時間預算**：單輪最多探測 `MAX_EDGE_PROBES`（預設 4，可用環境變數覆寫）個 edge —— authoritative 回覆是外部輸入，沒有上限等於讓對方決定這支腳本要跑多久（DNS 回覆數量不受單封包大小限制）。時間預算（N = 實際探測的 edge 數）：healthy 時第一個通的 edge 早退，≈10s，成本與單 edge 版本相同；**全 edge 皆不通**（真故障，會走 heal）≈ `40N + 38` 秒（3 次 retry × N×10s + 2 次 retry 間隔 15s + heal ~3s + sleep 5s + heal 後重驗 N×10s）——N=2 時 ~118s，已貼齊 launchd 120s 的排程間隔；N=3 時 ~158s，會超出。後果不是漏跑（launchd 同 label 不會併發啟動，超時只是把下一輪往後推），而是**警報也跟著延遲** —— heal 失敗的 Telegram 通知要等 heal 與 heal 後重驗都跑完才送出。這個公式是下界不是精確上限：它把 DNS resolve 當成免費，實際上同一輪 `funnel_resolve_authoritative` 會被呼叫 6 次，DNS 本身不穩時可能再多花十幾秒——而 DNS 不穩正是這支腳本要處理的場景。

> **L2/L3 查 authoritative 而非 recursive resolver**（2026-07-05 incident）：大型 recursive（1.1.1.1/8.8.8.8）對 `*.ts.net` funnel hostname 反覆 NXDOMAIN — Tailscale 週期 re-publish record 造成極短消失 window → resolver negative-cache 300s。這不代表 funnel drift，卻會誤判 → 誤 heal（`serve reset` 瞬間 funnel 真的 off，再製造 negative-cache）→ self-perpetuating flapping。authoritative NS 是控制平面實際發布的真相，不受 recursive cache 污染。詳見 `guard.sh` 頂部 note。

## 安裝

```bash
zsh scripts/funnel-guard/install.sh
```

Idempotent — 重跑會先 bootout 再 bootstrap。

前置：
- tailscale CLI 已裝（brew 版 `/opt/homebrew/bin/tailscale`、或 macOS App 版 `/usr/local/bin/tailscale`／`Tailscale.app` 內執行檔，guard 依序尋找）
- `jq` 已裝（macOS 通常內建 `/usr/bin/jq`；缺則 `brew install jq`）
- `.env.local` 含 `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`（對齊 `scripts/lib/send-telegram.sh`）

## 驗證

```bash
# 確認 job 已 load
launchctl print gui/$(id -u)/com.tripline.funnel-guard | head -20

# 即時看 log
tail -f scripts/logs/funnel-guard/stdout.log

# 手動觸發一次跑（不等 120s）
launchctl kickstart -k gui/$(id -u)/com.tripline.funnel-guard

# 邏輯 self-check（syntax + authoritative resolve + 真 drift 偵測，本機跑非 CI）
zsh scripts/funnel-guard/test-guard.sh
```

## 測試 drift 復原

```bash
# 故意製造 drift：關掉 funnel + 改用 serve（tailnet only，外網打不到）
tailscale funnel --https=443 off
tailscale serve --bg http://127.0.0.1:8080

# 驗證 drift 狀態 — AllowFunnel 應為空
tailscale serve status --json | jq '.AllowFunnel'

# 等 120s 內 guard 應 detect + heal + Telegram alert（或手動 kickstart）
launchctl kickstart -k gui/$(id -u)/com.tripline.funnel-guard
sleep 6
tailscale serve status --json | jq '.AllowFunnel'
# 預期：{ "<machine>.<tailnet>.ts.net:443": true }
```

## 緊急停用（incident response）

安全事件時若需要把 `:443` 拉下線（`tailscale funnel --https=443 off` 或改 serve-only），先建 kill-switch 防止 guard 把它推回來：

```bash
touch /Users/ray/Projects/trip-planner/scripts/funnel-guard/.disabled
# 之後 guard 每次 tick 都 skip
```

恢復：

```bash
rm /Users/ray/Projects/trip-planner/scripts/funnel-guard/.disabled
```

> `.disabled` 在 `.gitignore`，不會被誤 commit。

## Tailscale 需要人工處理（NeedsLogin / NeedsMachineAuth）

`BackendState` 為 `NeedsLogin`（`tailscale status` 回 `Logged out.`）或 `NeedsMachineAuth`（裝置待 admin 核准）時，heal 一定失敗，**guard 不會 heal**，改發獨立的 Telegram 告警（之後每小時一次提醒）：`NeedsLogin` 發 `needs_login`，照下方 `tailscale up` 處理；`NeedsMachineAuth` 發 `needs_machine_auth`，`tailscale up` 對它無效，要到 admin console 的 Machines 頁核准這台機器。兩者皆**退出碼 0**（告警已送出，plist 的 `StartInterval` 120 秒照常再輪詢）。不能用非 0：plist 是 `KeepAlive SuccessfulExit=false` + `ThrottleInterval=10`，非 0 結束會每 10 秒被重啟。2026-10-09 的事故是把它當一般 drift，每 10 秒空轉 heal 13 小時、共 4608 次。

處理：照告警裡的指令在這台機器執行（保留既有的 `--accept-routes` 與 `--hostname`，漏掉旗標會被拒絕或改掉原設定），並在瀏覽器完成授權：

```bash
tailscale up --accept-routes --hostname=<告警內的 hostname>
```

授權後不需要手動重啟 guard 或補 funnel 指令：下一輪偵測到 funnel 設定遺失，會走原本的 heal，並送出 healed／healthy 告警。

預防：到 Tailscale admin console 的 Machines 頁，看這台機器是否顯示 "Key expired"；是的話對它關閉 key expiry，否則會再發生。

## Alert 頻率設計

state-transition + 1hr throttle：

| 情境 | 是否發 alert |
|---|---|
| healthy → healthy（連續正常） | 否 |
| healthy → drift → heal 成功 | 是（recovery 訊號重要） |
| drift → heal 失敗 → drift（連續壞） | 第一次發；同 state 持續 1hr 才再發 |
| unhealthy → healthy（從壞變好） | 是（永遠發 recovery） |
| state change（healed → heal_failed 等） | 是 |

state cache 在 `/tmp/funnel-guard.state`（reboot 後重置 → 第一次 healthy 也不發，避免開機 noise）。

## 解除安裝

```bash
launchctl bootout gui/$(id -u)/com.tripline.funnel-guard
rm ~/Library/LaunchAgents/com.tripline.funnel-guard.plist
```

## 偵錯

| 症狀 | 檢查 |
|---|---|
| Telegram 沒收到 | `.env.local` 內 `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` 是否設了，`bash scripts/lib/send-telegram.sh "test"` 手動測試 |
| log 完全沒寫 | `scripts/logs/funnel-guard/` 目錄是否存在、權限是否 user 可寫 |
| `is_funnel_healthy` false（L1）| `tailscale serve status --json` hostname `:443` key 結尾是否符合 `endswith(":443")`；jq 是否在 PATH |
| `is_funnel_healthy` false（L2/L3）| `dig +short NS ts.net` 是否回 NS；`dig +short A <funnel-host> @ns1.dnsimple.com` 有無 record（無 → 真 drift，該 heal）；有 record 但仍 false → **全部** edge 都不通才會 false，逐一試 `curl -sS -o /dev/null -w '%{http_code}' --max-time 10 --resolve <host>:443:<每個 IP> https://<host>/` 找出是哪個壞（單一 edge 壞不會 false，只會出現「部分 edge 不可達」的 log）；全壞 = L3 reach 問題（DERP relay / ingress `:8080`）。**不要看 recursive resolver（1.1.1.1）—— 對 funnel hostname 天生 flaky，非判斷依據** |
| `heal_funnel` exit 非 0 | tailscaled 是否 running（`tailscale status`）；登出／待核准已改走獨立告警，不會走到 heal |
| 收到 `needs_login`／`needs_machine_auth` 告警 | 見上方「Tailscale 需要人工處理」章節 |
| 重複 alert 太多 | 看 log heal 次數 — 若 1 小時 > 10 次表示有外部 process 一直改 serve；查 `~/Library/Logs/` 找元兇 |
| log 過大 | `scripts/logs/funnel-guard/stdout.log` 不自動 rotate，~720 行/天 × ~50 bytes ≈ 13MB/年；過大可手動 `: > scripts/logs/funnel-guard/stdout.log` 截斷 |

## 設計取捨

- **Polling 120s 而非 WatchPaths**：tailscale config 內部結構不公開，version drift 風險高。120s + 8s CF timeout + 30min cron 兜底，足夠覆蓋。
- **不開 sudo NOPASSWD**：`tailscale funnel` user perm 透過 tailscaled socket 即可，不需 root。少一個攻擊面。
- **Telegram via send-telegram.sh 而非 api-server endpoint**：guard 不依賴 api-server 健康（api-server crash 時 guard 仍能 alert）。
- **每次 heal 都通知**：drift 頻率 = 外部 root cause 訊號（brew autoupdate / GUI app / macOS update）。低頻時 alert 量可接受。
