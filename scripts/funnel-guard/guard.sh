#!/bin/zsh
# funnel-guard — Tailscale funnel drift detect + auto-heal + Telegram alert
#
# Why: macOS update / GUI app / 第三方 brew 反覆把 funnel :443 改成 serve
# (tailnet only) → CF Worker public /trigger 全 530。Memory
# project_tailscale_funnel_caddy_architecture.md 紀錄 v2.33.111 已第 3 次。
#
# Auto-heal pattern：launchd 每 120s 跑本 script，drift 就 reset + 重設 funnel
# + Telegram 通知。
#
# Telegram env：由 trip-planner/.env.local 載入（gitignored）。對齊
# scripts/lib/send-telegram.sh 既有模式。launchd 完全 isolated env →
# 必須 source 自己的環境變數。
# 被 source（GUARD_SOURCE_ONLY=1）時不開 errexit：測試 harness 要的是 bad() 聚合
# 出 FAIL 診斷，不是在 source helper 或讀 .env.local 失敗時直接把整份腳本殺掉。
[ "${GUARD_SOURCE_ONLY:-}" = "1" ] || set -eo pipefail

# 預設從這支腳本自己的位置推導（${(%):-%x} 在直接執行與被 source 兩種情況都指向
# guard.sh 本身），不再硬編碼 —— 寫死路徑會讓 worktree／CI／測試 copy 被劫持到別份
# checkout（2026-09-05 red team 實測）。仍可用環境變數覆寫；那是本機環境變數，能設它
# 的人本來就能執行任意程式碼，不構成新的攻擊面。
REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "${(%):-%x}")/../.." && pwd)}"
# tailscale CLI 位置：brew 版與 macOS App 版（/usr/local/bin 的 wrapper、App 內執行檔）都找。
# 2026-10-22 起本機只剩 App 版，寫死 /opt/homebrew/bin 讓 L1 永遠失敗、每 5 秒空轉 heal。
# 先到先贏；全找不到時仍留第一個，維持原本的「指令不存在」錯誤訊息。
TAILSCALE="/opt/homebrew/bin/tailscale"
for _ts in /opt/homebrew/bin/tailscale /usr/local/bin/tailscale /Applications/Tailscale.app/Contents/MacOS/Tailscale; do
  [ -x "$_ts" ] && { TAILSCALE="$_ts"; break; }
done
unset _ts
EXPECTED_PROXY="http://127.0.0.1:8080"
LOG_PREFIX="[funnel-guard]"
KILL_SWITCH="$REPO_ROOT/scripts/funnel-guard/.disabled"

# v2.33.124：state-transition / throttle 改用共用 helper scripts/lib/throttled-alert.sh
# throttled-alert.sh 的預設 send-telegram 路徑是寫死的絕對路徑；這裡用 REPO_ROOT 明確指定，搬資料夾／換機器也不會送錯。
: "${THROTTLED_ALERT_SEND_TELEGRAM:=$REPO_ROOT/scripts/lib/send-telegram.sh}"
# shellcheck disable=SC1091
source "$REPO_ROOT/scripts/lib/throttled-alert.sh"

cd "$REPO_ROOT"

# Load Telegram credentials from .env.local — line-by-line scan only TELEGRAM_*
# 全檔 source 不可行：.env.local 含 multi-line JSON (GOOGLE_CLOUD_SA_KEY) 與
# 未 quote 的 < 字元 (EMAIL_FROM=Tripline <...>) → bash syntax error。
load_telegram_env() {
  local env_file="$1"
  [ -f "$env_file" ] || return 0
  local line key value
  while IFS= read -r line; do
    case "$line" in
      TELEGRAM_BOT_TOKEN=*|TELEGRAM_BOT_HOME_TOKEN=*|TELEGRAM_BOT_FETCI_TOKEN=*|TELEGRAM_CHAT_ID=*)
        key="${line%%=*}"
        value="${line#*=}"
        # Strip optional surrounding quotes
        value="${value#\"}"; value="${value%\"}"
        value="${value#\'}"; value="${value%\'}"
        export "$key=$value"
        ;;
    esac
  done < "$env_file"
}
load_telegram_env "$REPO_ROOT/.env.local"

log() {
  echo "$LOG_PREFIX $(date '+%Y-%m-%d %H:%M:%S') $*"
}

# 偵測 funnel :443 是否正確路由到 Caddy :8080。
# 三個 layer 都過才算 healthy：
#   L1 local: `tailscale serve status --json` AllowFunnel + Proxy 正確
#   L2 DNS:   authoritative NS (dnsimple) 有 funnel hostname 的 A record
#   L3 reach: 對每個 authoritative edge IP 做 direct HTTPS reach，任一通即算對外可達
#             （TLS + 任何 HTTP response 都算通）
#
# v2.33.123 原本只檢 L1，2026-05-27 incident：控制平面 funnel state on 但 public
# DNS NXDOMAIN → CF Worker 530 + forgot-password 信沒送。加 L2/L3 偵測。
#
# 2026-07-05 incident 修正：L2/L3 原本查 recursive resolver (1.1.1.1/8.8.8.8)，但大型
# recursive 對 *.ts.net funnel hostname 反覆 NXDOMAIN — Tailscale 週期性 re-publish
# record 造成極短消失 window → resolver negative-cache 300s（Cloudflare/Google 尤甚，
# Quad9 較穩）。這不代表 funnel drift，卻觸發 heal 的 `serve reset`，reset 瞬間 funnel
# 真的 off → 再製造 negative-cache → self-perpetuating flapping + Telegram noise。
# 改查 authoritative NS（= 控制平面實際發布的真相，不受 recursive cache 污染）：
#   真 drift（控制平面沒發布）→ authoritative 也 NXDOMAIN → 仍偵測到 → heal（正確）
#   假 drift（authoritative 有、只是 recursive cache）→ 判 healthy → 不 heal（正確）

# Local control-plane state
is_funnel_local_healthy() {
  local status_json
  status_json=$(ts_run serve status --json 2>/dev/null) || return 1
  [ -z "$status_json" ] && return 1

  echo "$status_json" | jq -e --arg proxy "$EXPECTED_PROXY" '
    (.AllowFunnel // {} | to_entries
      | map(select((.key | endswith(":443")) and .value == true))
      | length > 0)
    and
    ([.Web // {} | to_entries[]
      | select(.key | endswith(":443"))
      | .value.Handlers."/".Proxy] | any(. == $proxy))
  ' >/dev/null 2>&1
}

# 從 tailscale serve status 取 funnel hostname (e.g. <machine>.<tailnet>.ts.net)
funnel_hostname() {
  ts_run serve status --json 2>/dev/null \
    | jq -r '(.AllowFunnel // {} | keys[]?) | select(endswith(":443"))' \
    | sed 's/:443$//' | head -1
}

# Authoritative resolve：直接問 ts.net 的 authoritative NS (dnsimple)，繞過 recursive
# resolver 的 negative-cache 污染（2026-07-05 incident，見上方 note）。動態取 NS
# delegation 走系統 resolver — 但 NS record 穩定少變（不像 funnel A record 頻繁
# re-publish），故本 incident 的 negative-cache 不影響 NS 查詢；只有 A record 必須
# 走 authoritative。dig 取不到 NS 時 fallback 到已知 dnsimple NS。grep 過濾純 IPv4
# 行（排除 CNAME/雜訊）。echoes 所有 resolved IP（換行分隔）；失敗 echo empty + 非 0 exit。
# ponytail: any-one-NS-has-record 即算發布 — dnsimple anycast edge 偶有 serial 落後但
# 只要一個 edge 有 record 就代表控制平面已發布，不因單一 stale edge 誤判 drift。
#
# 2026-09-01 incident：回傳【所有】A record，不再 head -1。Tailscale 對 funnel
# hostname 發布多個 ingress edge（本次 .153 / .217），真實 client 會 fallback；
# 只探第一個會把單 edge 抖動誤判成整個 funnel 壞（詳見 is_funnel_reach_ok）。
FALLBACK_NS=(ns1.dnsimple.com ns2.dnsimple-edge.net ns3.dnsimple.com ns4.dnsimple-edge.org)
funnel_resolve_authoritative() {
  local host="$1" ips ns
  [ -z "$host" ] && return 1
  local -a nslist
  # grep 只留合法 NS hostname 行（結尾點）— dig 連線層失敗會把 `;; ...` 診斷印到
  # stdout（非 stderr），不過濾會污染 nslist 導致 fallback 失效。
  nslist=(${(f)"$(dig +short +time=3 +tries=1 NS ts.net 2>/dev/null | grep -E '^[A-Za-z0-9._-]+\.$')"})
  [ ${#nslist[@]} -eq 0 ] && nslist=("${FALLBACK_NS[@]}")
  for ns in "${nslist[@]}"; do
    [ -z "$ns" ] && continue
    ips=$(dig +short +time=3 +tries=1 A "$host" @"$ns" 2>/dev/null | grep -E '^([0-9]{1,3}\.){3}[0-9]{1,3}$')
    if [ -n "$ips" ]; then
      printf '%s' "$ips"
      return 0
    fi
  done
  return 1
}

# L2：authoritative NS 是否有 funnel hostname 的 A record（= 控制平面已對外發布）
is_funnel_dns_published() {
  local host="$1"
  funnel_resolve_authoritative "$host" >/dev/null
}

# L3：對 authoritative 回傳的【每個】edge IP 做 direct HTTPS reach — 收到任何真 HTTP
# response (1xx-5xx，含 4xx) 都算 reachable。curl transport fail (TCP refused / TLS /
# timeout) 時 %{http_code}=000，必須排除，否則 dead ingress 會被誤判 healthy → 不 heal
# （codex 2026-07-05 抓到的既有 bug）。--resolve 強制走該 IP，避過本機 MagicDNS 與
# recursive 污染。10s timeout 涵蓋 DERP relay cold path。
#
# 時間預算（2026-09-01 codex adversarial 修正了原本漏算的數字）：
#   healthy（第一個 edge 通就早退）    ≈ 10s —— 絕大多數情況，成本與單 edge 版本相同
#   全 edge 不通（真故障，會走 heal）  ≈ 3 retry × (N × 10s) + 2×15s + heal 3s + sleep 5s
#                                        + heal 後重驗 (N × 10s)  = 40N + 38
#     N=2 → ~118s，已貼齊 launchd 的 120s interval；N=3 → ~158s，超出。
# 後果：launchd 同 label 不會併發啟動，超時只是把下一輪往後推。**警報本身也一起被
# 推遲** —— heal_failed 的 Telegram 是在 heal 與 heal 後重驗都跑完才送出，所以 N=3
# 時第一則警報要等約 158s，不是「早就發出去了」（2026-09-04 codex 更正了這裡先前
# 的錯誤敘述）。plist 的 KeepAlive SuccessfulExit=false 會在 exit 1 後隔
# ThrottleInterval 10s respawn，真故障期間的節奏因此約 130s 一輪而非 120s。
#
# 這個公式是**下界，不是精確上限**：它把 DNS resolve 當成免費。同一條路徑上
# funnel_resolve_authoritative 其實被呼叫 6 次（L2 兩次 + L3 三個 attempt 各一次 +
# heal 後重驗一次），每次最壞是 NS 查詢逾時 3s 後再逐一試 4 個 FALLBACK_NS，可以多花
# 十幾秒。DNS 本身不穩的情境正是這支腳本要處理的場景，所以別把 40N+38 當成硬上限。
# 要根治得讓 retry 迴圈看「已耗時」而不是「次數」—— 那是獨立改動，不塞進這次止血。
# 失敗細節存 REACH_DETAIL（ip / curl exit / http_code）供 caller log — 2026-07-07
# 型態 D 事後只有「reach 失敗」四個字，診斷靠猜。
# 單輪最多探測幾個 edge。DNS 回覆是外部輸入，沒有上限等於讓對方決定這支腳本跑多久。
# 必須驗證：zsh 的 array slice 對負數是「從尾端數」，MAX_EDGE_PROBES=-1 會讓
# probe_list[1,-1] 變成整個陣列；非數字則讓 [ -gt ] 報錯後整段截斷被跳過。兩者都會
# 靜默把上限打開，正好重開這個上限要擋的那個洞（2026-09-05 red team 實測兩種都中）。
MAX_EDGE_PROBES="${MAX_EDGE_PROBES:-4}"
# 上界 16：<1-> 只驗下界，MAX_EDGE_PROBES=999999999999 會被接受而等於沒有上限
# （實務上是誤設而非攻擊面 —— 這是本機環境變數，不是 DNS 那種外部輸入 —— 但驗上界
# 只是多打幾個字）。16 遠高於 Tailscale 實際會發布的 edge 數（目前 2）。
if [[ "$MAX_EDGE_PROBES" != <1-16> ]]; then
  MAX_EDGE_PROBES=4
fi

# 單一 edge 的 HTTPS 探測，抽成獨立函式 = 測試 seam。行為測試覆寫它就能驗完整
# 多 edge 邏輯，不必真的有 funnel 或網路 —— 2026-09-04 codex adversarial 抓到：
# 原本多 edge 的斷言整段包在「有真 funnel hostname」的條件裡，在沒有 funnel 的機器
# （CI／sandbox）會靜默 skip 而 test-guard.sh 照樣回報 PASS，等於那些環境下這個
# 功能完全沒有守門。skip 也是一種假綠。
probe_edge_http_code() {
  local ip="$1" host="$2"
  curl -sS -o /dev/null -w "%{http_code}" --max-time 10 \
    --resolve "${host}:443:${ip}" "https://${host}/" 2>/dev/null
}

is_funnel_reach_ok() {
  local host="$1" ips ip http_code curl_exit
  local -a details
  # 先清再做任何 early return —— 否則 resolve 失敗那條路徑會留著上一輪的降級字串，
  # caller 讀到殘值。目前 caller 只在成功時讀 REACH_DEGRADED，但別讓正確性靠呼叫慣例。
  REACH_DEGRADED=""
  [ -z "$host" ] && return 1
  ips=$(funnel_resolve_authoritative "$host") || { REACH_DETAIL="authoritative resolve failed"; return 1; }
  # 逐一嘗試每個 edge，任一通即算對外可達 — 對齊真實 client 行為（拿到整份 A
  # record 清單，第一個不通會 fallback）。2026-09-01 incident：舊版 head -1 恆
  # 定只探 .153，該 edge 一抖動就判整個 funnel 壞 → 單日 159 次誤報 + 38 次
  # heal（36 次無效，serve reset 對 edge 側問題無用且 reset 瞬間 funnel 真 off）。
  # 去重（(u)）並截斷到 MAX_EDGE_PROBES。上限存在的理由是 DNS 回覆是外部輸入：
  # 拿掉 head -1 之後探測目標數等於對方給幾筆就探幾筆，一份被灌爆的 authoritative
  # 回覆（TCP fallback 不受單封包大小限制）可以讓單輪執行拖到數十分鐘，把這支工具
  # 存在的意義（即時 heal／告警）整個拖垮。誠實說明：這是擋惡意灌爆的上限，不是時間
  # 保證 —— 合法的 N=2 已是 ~118s，N=3 就會超過 launchd 的 120s interval。
  local -a probe_list
  probe_list=(${(u)${(f)ips}})
  # 使用點再 clamp 一次：source 之後呼叫者可以直接改全域 MAX_EDGE_PROBES，source 時的
  # 驗證擋不到那條路（codex 2026-09-05）。
  local cap="$MAX_EDGE_PROBES"
  [[ "$cap" == <1-16> ]] || cap=4
  if [ ${#probe_list[@]} -gt $cap ]; then
    log "authoritative 回了 ${#probe_list[@]} 個 edge，超過上限 $cap，只探前 $cap 個"
    probe_list=(${probe_list[1,$cap]})
  fi
  for ip in "${probe_list[@]}"; do
    http_code=$(probe_edge_http_code "$ip" "$host")
    curl_exit=$?
    if [[ "$http_code" =~ ^[1-5][0-9]{2}$ ]]; then
      REACH_DETAIL="ip=${ip} curl_exit=${curl_exit} http_code=${http_code}"
      # 前面有 edge 不通但這個通 → 服務可達（不 heal），仍記錄降級供追蹤單一 edge
      # 長期劣化（2026-09-01：.153 大量 timeout，.217 正常，舊版看不見）。
      # 範圍限制：因為命中即早退，這裡只記錄「排在可用 edge 之前」的壞 edge；排在
      # 後面的壞 edge 不會被探到。完整的全 edge 健康度需要獨立的時間預算設計（見上
      # 方時間預算 note），不在這次止血範圍。
      [ ${#details[@]} -gt 0 ] && REACH_DEGRADED="${(j:; :)details}"
      return 0
    fi
    details+=("ip=${ip} curl_exit=${curl_exit} http_code=${http_code:-none}")
  done
  # 全 edge 皆不通才 unhealthy — 逐一列出各 edge 細節，事後不用猜是哪個壞
  REACH_DETAIL="${(j:; :)details}"
  return 1
}

# L3 短暫 blip 重試間隔（秒）。2026-07-07 型態 D incident：Tailscale edge 33 秒
# 瞬斷（L1 serve state 與 L2 authoritative DNS 全程正常，只 L3 direct reach 失敗
# 後自癒），舊邏輯單次 fail 立刻 heal — 3 輪無效 serve reset（reset 瞬間 funnel
# 真 off 反而小幅加重）+ heal_failed Telegram 噪音。test-guard.sh 覆寫成 0 加速。
L3_RETRY_INTERVAL="${L3_RETRY_INTERVAL:-15}"

# $1 = L3 最大嘗試次數（預設 3）。heal 後重驗傳 1 — heal 剛做完只需驗「有沒有
# 生效」，再跑完整 retry 會把 sustained-outage 的 heal_failed 警報延到 ~125s，
# 超過 launchd 120s interval（codex review P1）。
is_funnel_healthy() {
  local max_attempts="${1:-3}"
  is_funnel_local_healthy || { log "L1 local control-plane state 不對"; return 1; }
  local host
  host=$(funnel_hostname)
  if [ -z "$host" ]; then
    log "L1 通過但無 funnel hostname (異常)"
    return 1
  fi
  if ! is_funnel_dns_published "$host"; then
    log "L2 authoritative DNS 無 record ($host — 控制平面未發布，真 drift)"
    return 1
  fi
  # L3 blip 容忍（型態 D）：L1/L2 綠時 L3 fail 先重試確認持續（間隔
  # L3_RETRY_INTERVAL，共跨 ~30s）才判 unhealthy。edge 瞬斷自癒 → 0 heal
  # 0 噪音；型態 B（持續 TLS stall）全 fail → 照樣 heal。
  local attempt
  for (( attempt=1; attempt<=max_attempts; attempt++ )); do
    if is_funnel_reach_ok "$host"; then
      [ "$attempt" -gt 1 ] && log "L3 重試第 $attempt 次通過 — 短暫 blip 自癒，不 heal"
      [ -n "${REACH_DEGRADED:-}" ] && log "L3 部分 edge 不可達但服務仍可達，不 heal ($REACH_DEGRADED)"
      return 0
    fi
    log "L3 HTTPS reach 失敗 ($host — ${REACH_DETAIL:-no detail}, attempt $attempt/$max_attempts)"
    [ "$attempt" -lt "$max_attempts" ] && sleep "$L3_RETRY_INTERVAL"
  done
  return 1
}

# 重設 funnel：先 reset 既有 serve/funnel state（避免殘留 conflict）→ 重新註冊
heal_funnel() {
  log "drift 偵測：執行 reset + funnel 重設"
  ts_run serve reset 2>&1 | sed "s/^/$LOG_PREFIX  /" || true
  ts_run funnel --bg --https=443 "$EXPECTED_PROXY" 2>&1 | sed "s/^/$LOG_PREFIX  /"
}

# 帶逾時的 tailscale 呼叫（macOS 沒有 timeout，用 perl alarm）。tailscaled 卡住時不能讓 guard 永遠掛住：
# launchd 同 label 不會併發啟動，掛住 = guard 靜默停擺，而這支呼叫在 kill-switch 與 heal 之前。
# 所有 tailscale 呼叫（偵測、heal）都走這裡；TS_TIMEOUT 可由環境覆寫（測試用）。
ts_run() { perl -e 'alarm shift; exec @ARGV' "${TS_TIMEOUT:-20}" "$TAILSCALE" "$@"; }

# Tailscale 需要人工處理：heal 必敗。NeedsLogin = 已登出（`tailscale up` 重新授權）；
# NeedsMachineAuth = 裝置要到 admin console 核准（`tailscale up` 沒有用）。
# 2026-10-09 incident：把它當一般 drift，每 10 秒空轉 heal 13 小時 4608 次，告警還說成
# 「funnel 指令失敗」。其他狀態（Starting／Stopped…）不在此列，維持原路徑，避免暫態誤報。
# 成功時把狀態放進 NEEDS_STATE。
#
# **不依賴 tailscale 的結束碼**：登出時 `status --json` 是否回非 0 隨版本而異（本機無法安全地驗證——
# 得把正在服務的機器登出）；若依賴結束碼，一旦非 0 這整個分支就是死碼、退回 13 小時空轉，測試卻仍綠
# （對抗式審查抓到）。所以容忍非 0、只解析輸出。
tailscale_needs_login() {
  local state
  state=$({ ts_run status --json 2>/dev/null || true; } | jq -r '.BackendState // empty' 2>/dev/null) || return 1
  case "$state" in
    NeedsLogin|NeedsMachineAuth) NEEDS_STATE=$state; return 0 ;;
    *) return 1 ;;
  esac
}

# 組出這台機器實際該跑的 `tailscale up`：保留既有 --accept-routes / --hostname，
# 漏掉旗標會被 tailscale 拒絕或改掉原設定。prefs 登出後仍讀得到；讀不到就給裸指令。
# hostname 只收 [A-Za-z0-9-]（它會被放進 Telegram 訊息與複製貼上的指令）。
tailscale_up_hint() {
  local prefs flags="" host
  prefs=$(ts_run debug prefs 2>/dev/null) || true  # set -e 下失敗不得讓提示變空
  [ "$(printf '%s' "$prefs" | jq -r '.RouteAll // false' 2>/dev/null)" = "true" ] && flags=" --accept-routes"
  host=$(printf '%s' "$prefs" | jq -r '.Hostname // empty' 2>/dev/null)
  case "$host" in ''|*[!A-Za-z0-9-]*) ;; *) flags="$flags --hostname=$host" ;; esac
  printf 'tailscale up%s' "$flags"
}

main() {
  # M1 kill-switch：incident response 時 `touch .disabled` 暫停 auto-heal
  if [ -f "$KILL_SWITCH" ]; then
    log "kill-switch (.disabled) present — 跳過 heal"
    exit 0
  fi

  if tailscale_needs_login; then
    local alert_state msg out rc=0
    if [ "$NEEDS_STATE" = NeedsMachineAuth ]; then
      alert_state="needs_machine_auth"
      msg="🚨 Tripline funnel-guard：這台裝置需要在 Tailscale admin console 核准（NeedsMachineAuth），自動 heal 無法處理。請到 Machines 頁核准這台裝置（這個狀態下 \`tailscale up\` 沒有用）；核准後 guard 會自行重設 funnel"
    else
      alert_state="needs_login"
      msg="🚨 Tripline funnel-guard：Tailscale 已登出（NeedsLogin），自動 heal 無法處理。請在這台機器執行 \`$(tailscale_up_hint)\` 並完成瀏覽器授權（若 tailscale 說還要列出其他旗標，照它的提示補上）；恢復後 guard 會自行重設 funnel"
    fi
    log "Tailscale 需要人工處理（$NEEDS_STATE）— 跳過 heal（heal 必敗）"
    out=$(throttled_alert "funnel-guard" "$alert_state" "$msg" 2>&1) || rc=$?
    [ -n "$out" ] && printf '%s\n' "$out" | sed "s/^/$LOG_PREFIX  /"
    # 送出失敗不能靜默：throttled_alert 只在成功時才更新狀態檔，所以下一輪（120s）會自動重試。
    [ "$rc" -ne 0 ] && log "告警送出失敗（rc=$rc）— 狀態檔未更新，下一輪會重試"
    # exit 0：plist 的 StartInterval(120s) 本來就會再輪詢。**不能 exit 1** —— plist 是
    # KeepAlive SuccessfulExit=false + ThrottleInterval=10，非 0 結束會每 10 秒被 respawn；
    # 2026-10-09 事故的 13 小時／4608 次（≈ 13×360）就是這個節奏。
    exit 0
  fi

  if is_funnel_healthy; then
    log "healthy"
    throttled_alert "funnel-guard" "healthy" \
      "🛡️ Tripline funnel-guard：funnel 已恢復 healthy" 2>&1 | sed "s/^/$LOG_PREFIX  /" || true
    exit 0
  fi

  log "drift 偵測 — 開始 heal"
  if heal_funnel; then
    # 5s 等 tailscaled converge + DERP relay reconnect
    sleep 5
    # 單次驗（不 retry）：只驗 heal 有沒有生效，避免 sustained outage 的
    # heal_failed 警報被 retry 窗拖過 launchd 120s interval
    if is_funnel_healthy 1; then
      log "heal 成功"
      throttled_alert "funnel-guard" "healed" \
        "🛡️ Tripline funnel-guard：偵測 :443 drift → 已自動 reset + 重設 funnel → http://127.0.0.1:8080" \
        2>&1 | sed "s/^/$LOG_PREFIX  /" || true
      exit 0
    else
      log "heal 後仍 unhealthy"
      throttled_alert "funnel-guard" "heal_failed" \
        "🚨 Tripline funnel-guard：偵測 :443 drift，自動 heal 後仍 unhealthy，請手動檢查 \`tailscale serve status\`" \
        2>&1 | sed "s/^/$LOG_PREFIX  /" || true
      exit 1
    fi
  else
    log "heal 指令本身失敗"
    throttled_alert "funnel-guard" "heal_failed" \
      "🚨 Tripline funnel-guard：偵測 :443 drift，\`tailscale funnel\` 指令執行失敗，請手動檢查" \
      2>&1 | sed "s/^/$LOG_PREFIX  /" || true
    exit 1
  fi
}

# GUARD_SOURCE_ONLY=1 → 只載入函式不跑 main（供 test harness / 手動驗證 source，
# 避免觸發 heal 的 serve reset 與 Telegram alert）
if [ "${GUARD_SOURCE_ONLY:-}" != "1" ]; then
  main "$@"
fi
