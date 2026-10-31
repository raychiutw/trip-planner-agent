#!/bin/zsh
# test-guard.sh — funnel-guard 健康判定邏輯的本機 self-check。
#
# 非 CI：依賴 dig + 網路 + 當前 funnel 狀態（guard.sh 本身是 mac mini 本機 launchd
# ops script，同樣不在 CI 範圍）。手動跑：
#   zsh scripts/funnel-guard/test-guard.sh
#
# 覆蓋 2026-07-05 incident 修正的核心不變量：
#   - 健康判定走 authoritative NS（不碰 recursive resolver，免 negative-cache 誤導）
#   - 真 drift（authoritative 也無 record）仍偵測得到 → 不因修正而漏 heal
set -uo pipefail
# guard.sh 被 source 時會執行它自己的 `cd "$REPO_ROOT"`，把 cwd 劫持到那個路徑。
# 固定住我們要測的那份 checkout，每次 source 後都 cd 回來，否則在 worktree／CI／
# 測試 copy 裡會變成驗證別份 guard.sh（2026-09-05 red team 用「把舊 bug 放回 copy，
# copy 自己的測試卻 PASS」實測出來）。
TEST_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$TEST_ROOT"
# 明確指定，不靠 guard.sh 自己推導 —— 讓「被測的是這份 checkout」成為顯式意圖
export REPO_ROOT="$TEST_ROOT"

fail=0
ok()   { echo "  ✅ $1"; }
bad()  { echo "  ❌ $1"; fail=1; }
skip() { echo "  ⏭️  $1"; }

echo "[1] syntax"
zsh -n scripts/funnel-guard/guard.sh && ok "guard.sh parses" || bad "syntax error"

echo "[2] load lib (GUARD_SOURCE_ONLY=1 → 不跑 main，無 heal/telegram 副作用)"
GUARD_SOURCE_ONLY=1 source scripts/funnel-guard/guard.sh 2>/dev/null
cd "$TEST_ROOT"
set +e
typeset -f funnel_resolve_authoritative >/dev/null && ok "funnel_resolve_authoritative loaded" || bad "fn missing"
[ ${#FALLBACK_NS[@]} -ge 1 ] && ok "FALLBACK_NS non-empty (${#FALLBACK_NS[@]})" || bad "FALLBACK_NS empty"

echo "[3] authoritative resolve — real funnel host (precondition for [4])"
host=$(funnel_hostname)
if [ -z "$host" ]; then
  skip "funnel off (no hostname) — 跳過 resolve / drift 驗證"
else
  real_ip=$(funnel_resolve_authoritative "$host")
  if [ -n "$real_ip" ]; then
    ok "real host $host -> $real_ip"
    echo "[4] real-drift detection — nonexistent host must NOT resolve"
    fake="nonexistent-$$-xyz.${host#*.}"
    if funnel_resolve_authoritative "$fake" >/dev/null; then
      bad "false-positive: $fake resolved → 會漏掉真 drift"
    else
      ok "$fake 無 record → 真 drift 仍偵測得到"
    fi
  else
    skip "real host 無法 resolve (funnel off / 無網路) — 跳過 drift 驗證"
  fi
fi

echo "[5] L3 transport-fail (curl http_code=000) must NOT count as healthy"
# 用固定 mock hostname：這條只需要「本機 :443 沒有 listener」，不需要真的有 funnel，
# 所以不再包在 host 條件裡而在無 funnel 的機器上被跳過（同 [6] 的 skip 假綠問題）。
if true; then
  host="mock-host.ts.net"
  # mock resolve → 127.0.0.1:443（本機無 https listen → curl connection refused →
  # http_code=000）。regex 若含 000 會把 dead ingress 誤判 healthy。
  funnel_resolve_authoritative() { printf '127.0.0.1'; }
  if is_funnel_reach_ok "$host"; then
    bad "127.0.0.1:443 判 reachable — 000/refused 被當 healthy (false-healthy)"
  else
    ok "unreachable ingress (000) → unhealthy（正確排除 transport fail）"
  fi
else
  skip "no funnel hostname — 跳過 L3 000 驗證"
fi

echo "[6] 多 edge fallback（全 mock probe seam — 任何環境都真的跑得到）"
# 2026-09-04 codex adversarial：舊版整段包在「有真 funnel hostname」的條件裡，沒有
# funnel 的機器（CI／sandbox）會 skip 卻照樣回報 PASS —— skip 也是一種假綠。改成覆寫
# probe_edge_http_code seam，不依賴真 funnel、不依賴網路。
_mock_host="mock-host.ts.net"
probe_edge_http_code() {
  case "$1" in
    10.0.0.1) printf '404'; return 0 ;;   # 可達
    *)        printf '000'; return 28 ;;  # timeout
  esac
}

funnel_resolve_authoritative() { printf '10.0.0.9\n10.0.0.1'; }
if is_funnel_reach_ok "$_mock_host"; then
  ok "一壞一好（壞的在前）→ healthy，不誤觸發 heal"
  if [ -n "${REACH_DEGRADED:-}" ]; then
    ok "降級已記錄 ($REACH_DEGRADED)"
  else
    bad "REACH_DEGRADED 未記錄 — 單一 edge 長期劣化會看不見"
  fi
else
  bad "單一 edge 不通即判整個 funnel 壞（head -1 / break 回歸？）"
fi

# 好的排前面 → 命中即早退，後面的壞 edge 不會被探到，REACH_DEGRADED 必為空。
# 這是刻意取捨：heal 只需要知道「有沒有任一條通」，探完全部會讓最壞時間翻倍。代價是
# 降級診斷只涵蓋「排在可用 edge 之前」的壞 edge。鎖住這個語意，避免日後有人把
# REACH_DEGRADED 當成完整的 edge 健康度。
funnel_resolve_authoritative() { printf '10.0.0.1\n10.0.0.9'; }
if is_funnel_reach_ok "$_mock_host"; then
  if [ -z "${REACH_DEGRADED:-}" ]; then
    ok "好的在前 → 早退且 REACH_DEGRADED 空（已知取捨，非完整 edge 健康度）"
  else
    bad "好的在前卻記了降級 — 早退語意變了，時間預算的假設也跟著失效"
  fi
else
  bad "第一個 edge 就通卻判 unhealthy"
fi

funnel_resolve_authoritative() { printf '10.0.0.8\n10.0.0.9'; }
if is_funnel_reach_ok "$_mock_host"; then
  bad "全 edge 不通卻判 healthy — 恆真，真故障漏偵測"
else
  ok "全 edge 不通 → unhealthy（真故障仍偵測得到）"
fi

funnel_resolve_authoritative() { printf '10.0.0.9\n10.0.0.9\n10.0.0.9'; }
is_funnel_reach_ok "$_mock_host" >/dev/null
dup_probes=$(printf '%s' "${REACH_DETAIL:-}" | grep -o 'ip=' | wc -l | tr -d ' ')
if [ "$dup_probes" -eq 1 ]; then
  ok "重複 A record 去重（3 個相同 IP 只探 1 次）"
else
  bad "重複 A record 探了 $dup_probes 次 — 沒去重"
fi

# 探測上限真的生效：給 6 個 unique edge，只有「超過上限之後」那個可達。
# 上限有效 → 那個永遠探不到 → unhealthy。把 -gt 寫成 -lt（截斷不再發生）就會變綠而漏抓，
# 所以這條斷言必須是「unhealthy」而不是「有截斷字串」。
probe_edge_http_code() {
  case "$1" in
    10.0.0.5) printf '404'; return 0 ;;   # 第 5 個可達，恰好是 cap(4) 之外的第一個
    *)        printf '000'; return 28 ;;
  esac
}
funnel_resolve_authoritative() { printf '10.0.0.1\n10.0.0.2\n10.0.0.3\n10.0.0.4\n10.0.0.5\n10.0.0.6'; }
if is_funnel_reach_ok "$_mock_host"; then
  bad "探到了 cap 之外的第 5 個 edge — 截斷沒生效，或多探了一個"
else
  ok "探測上限生效（6 個 edge 只探前 $MAX_EDGE_PROBES 個，第 5 個可達卻探不到）"
fi
# MAX_EDGE_PROBES 是環境變數 = 外部輸入，惡意值會靜默把上限打開：zsh 的 array slice
# 對負數是「從尾端數」，非數字則讓 [ -gt ] 報錯後整段截斷被跳過。用 subshell 重新 source
# 才驗得到（值在 source 當下就定案）。
for _bad in -1 abc 0 999999999999 '' 3.5; do
  _got=$(MAX_EDGE_PROBES="$_bad" TEST_ROOT="$TEST_ROOT" zsh -c 'cd "$TEST_ROOT" && GUARD_SOURCE_ONLY=1 source scripts/funnel-guard/guard.sh 2>/dev/null; echo "$MAX_EDGE_PROBES"')
  if [ "$_got" = "4" ]; then
    ok "MAX_EDGE_PROBES=$_bad 被擋下並落回 4"
  else
    bad "MAX_EDGE_PROBES=$_bad 被接受成 '$_got' — 上限會被靜默打開"
  fi
done

# source 之後直接改全域值，使用點的 clamp 也要擋得住（codex #3）
MAX_EDGE_PROBES=-1
probe_edge_http_code() {
  case "$1" in
    10.0.0.5) printf '404'; return 0 ;;
    *)        printf '000'; return 28 ;;
  esac
}
funnel_resolve_authoritative() { printf '10.0.0.1\n10.0.0.2\n10.0.0.3\n10.0.0.4\n10.0.0.5\n10.0.0.6'; }
if is_funnel_reach_ok "$_mock_host"; then
  bad "source 後把 MAX_EDGE_PROBES 改成 -1 就探到了第 5 個 — 使用點沒有 clamp"
else
  ok "source 後改全域 MAX_EDGE_PROBES=-1 仍被 clamp 回 4（使用點驗證生效）"
fi
MAX_EDGE_PROBES=4

# 還原 [6] 其餘案例用的探測 mock
probe_edge_http_code() {
  case "$1" in
    10.0.0.1) printf '404'; return 0 ;;
    *)        printf '000'; return 28 ;;
  esac
}

funnel_resolve_authoritative() { printf '10.0.0.9\n10.0.0.1'; }
is_funnel_reach_ok "$_mock_host" >/dev/null
funnel_resolve_authoritative() { return 1; }
is_funnel_reach_ok "$_mock_host" >/dev/null
if [ -n "${REACH_DEGRADED:-}" ]; then
  bad "REACH_DEGRADED 殘留上一輪的值 ($REACH_DEGRADED) — early return 沒清"
else
  ok "REACH_DEGRADED 每次呼叫先清（early return 路徑也清）"
fi

echo "[7] resolve 真的回傳多行（擋掉所有『只取第一筆』的變體寫法）"
# [6] 結尾把 funnel_resolve_authoritative mock 成 return 1，這裡要拿回真的實作。
# source 會再跑一次 guard.sh 的 cd 與 `set -eo pipefail` —— 兩個都要收拾，否則
# 後面幾節會改測別份 checkout，且 errexit 會讓任何非 0 回傳直接中斷整份腳本。
GUARD_SOURCE_ONLY=1 source scripts/funnel-guard/guard.sh 2>/dev/null
cd "$TEST_ROOT"
set +e
# coverage 稽核指出：unit test 只禁止字面的 `head -1`，換成 head -n1／tail -1／
# sed -n 1p 都能繞過 source-grep 而重現 2026-09-01 incident。這裡覆寫 dig 直接數行數，
# 任何截斷寫法都會讓行數掉到 1 而變紅。
dig() {
  case "$*" in
    *"NS ts.net"*)          printf 'ns1.dnsimple.com.\n' ;;
    *"A mock-multi.ts.net"*) printf '10.0.0.1\n10.0.0.2\n10.0.0.3\n' ;;
    *)                       printf '' ;;
  esac
}
_resolved=$(funnel_resolve_authoritative "mock-multi.ts.net")
_lines=$(printf '%s\n' "$_resolved" | grep -c '^10\.0\.0\.')
if [ "$_lines" -eq 3 ]; then
  ok "resolve 回傳全部 3 筆 A record（沒有被任何形式截斷）"
else
  bad "resolve 只回傳 $_lines 筆 — 有截斷（head -1／head -n1／tail -1／sed 1p 之類）"
fi
unset -f dig

echo "[8] is_funnel_healthy 端到端接線：REACH_DEGRADED 要真的觸發 log"
# testing specialist 用 mutation 證明的缺口：把 213 行守衛變數打錯字（log 字串不動），
# source-grep 8 條斷言全綠、test-guard.sh 也全 PASS —— 因為 [6] 只直測
# is_funnel_reach_ok，[9] 又把它整個 mock 掉，沒有任何案例讓真的 is_funnel_reach_ok
# 流經 is_funnel_healthy。這裡保留真的 is_funnel_reach_ok，只 mock 它下游的探測。
is_funnel_local_healthy() { return 0; }
funnel_hostname() { printf 'mock-host.ts.net'; }
is_funnel_dns_published() { return 0; }
probe_edge_http_code() {
  case "$1" in
    10.0.0.1) printf '404'; return 0 ;;
    *)        printf '000'; return 28 ;;
  esac
}
funnel_resolve_authoritative() { printf '10.0.0.9\n10.0.0.1'; }
_out=$(is_funnel_healthy 2>&1)
if printf '%s' "$_out" | grep -q '部分 edge 不可達但服務仍可達'; then
  ok "is_funnel_healthy 真的印出降級 log（寫入→消費的接線完整）"
else
  bad "is_funnel_healthy 沒印出降級 log — REACH_DEGRADED 接線斷了（直測 is_funnel_reach_ok 看不到這種回歸）"
fi
# 反向：沒有降級時不可誤印（擋 -n 改成 -z、或把 log 移出成功分支而每次都噴）
funnel_resolve_authoritative() { printf '10.0.0.1'; }
_out2=$(is_funnel_healthy 2>&1)
if printf '%s' "$_out2" | grep -q '部分 edge 不可達但服務仍可達'; then
  bad "沒有降級卻印了降級 log — 條件寫反或 log 放錯分支"
else
  ok "無降級時不印降級 log（條件方向正確）"
fi

echo "[9] L3 blip 容忍（2026-07-07 型態 D）— fail→pass 判 healthy；持續 fail 仍 unhealthy"
# 全 mock：只驗 is_funnel_healthy 的 L3 retry 分支，不碰網路/真 funnel
L3_RETRY_INTERVAL=0
is_funnel_local_healthy() { return 0; }
funnel_hostname() { printf 'mock-host.ts.net'; }
is_funnel_dns_published() { return 0; }
_reach_calls=0
is_funnel_reach_ok() { _reach_calls=$((_reach_calls+1)); [ "$_reach_calls" -ge 2 ]; }
if is_funnel_healthy >/dev/null 2>&1; then
  ok "blip（首次 fail、重試 pass）→ healthy，不觸發 heal"
else
  bad "blip 被判 unhealthy — 短暫 edge 瞬斷仍會白 heal + 發噪音"
fi
_reach_calls=0
is_funnel_reach_ok() { _reach_calls=$((_reach_calls+1)); return 1; }
if is_funnel_healthy >/dev/null 2>&1; then
  bad "持續 fail 判 healthy — 型態 B（TLS stall）會漏 heal"
else
  if [ "$_reach_calls" -eq 3 ]; then
    ok "持續 fail → unhealthy 且恰好 3 次 probe（型態 B heal 照舊、retry 預算正確）"
  else
    bad "持續 fail probe 次數 $_reach_calls ≠ 3 — retry 預算跑偏"
  fi
fi
_reach_calls=0
if is_funnel_healthy 1 >/dev/null 2>&1; then
  bad "單次模式（heal 後重驗）判 healthy — mock 應 fail"
else
  if [ "$_reach_calls" -eq 1 ]; then
    ok "is_funnel_healthy 1 恰好 1 次 probe（heal 後重驗不 double retry 窗）"
  else
    bad "單次模式 probe 次數 $_reach_calls ≠ 1"
  fi
fi

echo "[10] Tailscale 登出（2026-10-09 incident：NeedsLogin 時空轉 13 小時 4608 次 heal）"
# 假 tailscale：記錄每次呼叫；status --json 的 BackendState 由 FAKE_STATE 決定。
# 在 subshell 跑真的 main()（它會 exit），斷言「呼叫了什麼、發了什麼告警、退出碼」——
# 只驗外部行為，不綁 needs_login 內部怎麼拆函式。
_fake=$(mktemp -d)
cat > "$_fake/tailscale" <<'FAKE'
#!/bin/zsh
echo "$*" >> "$FAKE_CALLS"
[ -n "$FAKE_HANG" ] && exec sleep 30
case "$1 $2" in
  "status --json") [ -n "$FAKE_STATUS_FAIL" ] && exit 1; printf '{"BackendState":"%s"}' "$FAKE_STATE"; [ -n "$FAKE_STATUS_EXIT" ] && exit "$FAKE_STATUS_EXIT" ;;
  "debug prefs")
    case "${FAKE_PREFS_MODE:-full}" in
      full)      printf '{"Hostname":"test-host","RouteAll":true}' ;;
      emptyjson) printf '{}' ;;
      weirdhost) printf '{"Hostname":"a`b;c","RouteAll":true}' ;;
      fail)      exit 1 ;;
    esac ;;
esac
exit 0
FAKE
chmod +x "$_fake/tailscale"
_run_main() { # $1=BackendState → 印出 main 的退出碼；呼叫記錄在 $_fake/calls、告警在 $_fake/alerts
  : > "$_fake/calls"; : > "$_fake/alerts"
  (
    TAILSCALE="$_fake/tailscale"; KILL_SWITCH="$_fake/no-such-kill-switch"
    export FAKE_CALLS="$_fake/calls" FAKE_STATE="$1"
    throttled_alert() { echo "$2|$3" >> "$_fake/alerts"; }
    sleep() { :; }
    is_funnel_healthy() { return 1; }
    main >/dev/null 2>&1
  )
  echo $?
}
for _st in NeedsLogin NeedsMachineAuth; do
  _rc=$(_run_main "$_st")
  if grep -q -E '^(serve reset|funnel)' "$_fake/calls"; then
    bad "$_st 仍呼叫 serve reset / funnel（空轉 heal）"
  else
    ok "$_st 不呼叫 serve reset / funnel"
  fi
  # 兩種狀態要有各自的告警 state（切換時才會重新通知）與各自正確的處理指示
  if [ "$_st" = NeedsLogin ]; then
    grep -q '^needs_login|' "$_fake/alerts" && ok "NeedsLogin 發出獨立的 needs_login 告警" || bad "NeedsLogin 沒有 needs_login 告警"
    grep -q 'tailscale up --accept-routes --hostname=test-host' "$_fake/alerts" && ok "NeedsLogin 告警附完整 tailscale up 指令（保留既有旗標）" || bad "NeedsLogin 告警沒附可複製的 tailscale up 指令"
  else
    grep -q '^needs_machine_auth|' "$_fake/alerts" && ok "NeedsMachineAuth 發出獨立的 needs_machine_auth 告警" || bad "NeedsMachineAuth 沒有 needs_machine_auth 告警"
    if grep -q 'tailscale up --accept-routes' "$_fake/alerts"; then bad "NeedsMachineAuth 被叫去跑 tailscale up（該狀態要到 admin console 核准）"; else ok "NeedsMachineAuth 不給 tailscale up、改指向 admin console 核准"; fi
    grep -q 'admin console' "$_fake/alerts" && ok "NeedsMachineAuth 告警指向 admin console" || bad "NeedsMachineAuth 告警沒提 admin console"
  fi
  if grep -q '指令執行失敗' "$_fake/alerts"; then bad "$_st 告警仍是誤導的「指令執行失敗」"; else ok "$_st 告警不再誤導成指令失敗"; fi
  # 必須是 0：plist 是 KeepAlive SuccessfulExit=false + ThrottleInterval=10，非 0 會每 10 秒 respawn（2026-10-09 的迴圈）。
  [ "$_rc" = 0 ] && ok "$_st 退出碼為 0（非 0 會被 launchd 每 10 秒重啟）" || bad "$_st 退出碼為 $_rc — launchd 會每 10 秒 respawn"
done
# 對照：Running 但 funnel 掉了 → 仍走既有 heal（防止短路寫得過寬）
_rc=$(_run_main Running)
if grep -q '^serve reset' "$_fake/calls" && grep -q '^funnel ' "$_fake/calls"; then ok "Running + drift 仍自動 heal（既有保護沒被削弱）"; else bad "Running + drift 沒有 heal — 短路過寬"; fi
if grep -q '^needs_login|' "$_fake/alerts"; then bad "Running 被誤報成 needs_login"; else ok "Running 不發 needs_login"; fi
# tailscale_up_hint 的邊界：prefs 讀不到／沒有旗標時給裸指令，且在真實執行的 set -eo pipefail 下不能讓提示變空
# （Red Team 抓到：debug prefs 非 0 離開會讓告警變成「請執行 `` 」）。
# 注意：必須先把輸出存進變數再比對——放在 `[ "$(...)" = ... ] && ok || bad` 這種條件式裡，errexit 會被忽略，
# 測試就量不到真實執行（set -eo pipefail）下的行為（第一版測試因此 mutation 不紅）。
# 也必須像 guard.sh 一樣把提示放在**命令引數**裡呼叫：直接呼叫時 errexit 會讓函式整個死掉（輸出為空、
# 另一種失敗形狀），放在引數裡則是悄悄變空字串並繼續執行——這才是告警文字變成「請執行 `` 」的情境。
_hint_case() { # $1=FAKE_PREFS_MODE → 印出 errexit 開啟下、放在引數裡的提示
  ( TAILSCALE="$_fake/tailscale"; export FAKE_CALLS="$_fake/calls" FAKE_PREFS_MODE="$1"; set -eo pipefail; printf '%s' "$(tailscale_up_hint)" ) 2>/dev/null
}
_h_full=$(_hint_case full); _h_json=$(_hint_case emptyjson); _h_fail=$(_hint_case fail)
if [ "$_h_full" = "tailscale up --accept-routes --hostname=test-host" ]; then ok "up 提示：有 prefs 時含 --accept-routes 與 --hostname"; else bad "up 提示（full）不對：'$_h_full'"; fi
if [ "$_h_json" = "tailscale up" ]; then ok "up 提示：prefs 是 {} 時為裸指令、沒有多餘旗標"; else bad "up 提示（{}）不對：'$_h_json'"; fi
if [ "$_h_fail" = "tailscale up" ]; then ok "up 提示：debug prefs 失敗（errexit、放在引數裡）仍給裸指令、不是空的"; else bad "up 提示（prefs 失敗）變空或不對：'$_h_fail'"; fi
# status --json 失敗（不是登出）：不能被誤判成 needs_login，要走既有 heal 路徑
: > "$_fake/calls"; : > "$_fake/alerts"
( TAILSCALE="$_fake/tailscale"; KILL_SWITCH="$_fake/no-such-kill-switch"; export FAKE_CALLS="$_fake/calls" FAKE_STATE="NeedsLogin" FAKE_STATUS_FAIL=1
  throttled_alert() { echo "$2|$3" >> "$_fake/alerts"; }; sleep() { :; }; is_funnel_healthy() { return 1; }
  main >/dev/null 2>&1 )
if grep -q '^needs_login|' "$_fake/alerts"; then bad "status --json 失敗被誤判成 needs_login"; elif grep -q '^serve reset' "$_fake/calls"; then ok "status --json 失敗 → 走既有 heal 路徑（不誤報登出）"; else bad "status --json 失敗後沒有走 heal 路徑"; fi
# kill-switch 優先於一切判斷：incident response 時 touch .disabled 暫停 guard，登出時也不該發告警
: > "$_fake/kill"
_run_main_kill() { : > "$_fake/calls"; : > "$_fake/alerts"
  ( TAILSCALE="$_fake/tailscale"; KILL_SWITCH="$_fake/kill"; export FAKE_CALLS="$_fake/calls" FAKE_STATE="NeedsLogin"
    throttled_alert() { echo "$2|$3" >> "$_fake/alerts"; }; sleep() { :; }; is_funnel_healthy() { return 1; }
    main >/dev/null 2>&1 ); echo $?; }
_rc=$(_run_main_kill)
if [ "$_rc" = 0 ] && [ ! -s "$_fake/alerts" ] && ! grep -q -E '^(serve reset|funnel)' "$_fake/calls"; then
  ok "kill-switch 存在時，NeedsLogin 也不 heal、不告警、exit 0"
else
  bad "kill-switch 沒有優先於 needs_login（rc=$_rc）"
fi
# 偵測不得依賴 tailscale 的結束碼：登出時 status --json 若印出 JSON 卻以非 0 結束，仍要認出登出
# （否則整個分支是死碼、退回 13 小時空轉，而測試仍綠 — 對抗式審查抓到）
: > "$_fake/calls"; : > "$_fake/alerts"
( TAILSCALE="$_fake/tailscale"; KILL_SWITCH="$_fake/no-such-kill-switch"; export FAKE_CALLS="$_fake/calls" FAKE_STATE="NeedsLogin" FAKE_STATUS_EXIT=3
  throttled_alert() { echo "$2|$3" >> "$_fake/alerts"; }; sleep() { :; }; is_funnel_healthy() { return 1; }
  main >/dev/null 2>&1 )
if grep -q '^needs_login|' "$_fake/alerts" && ! grep -q '^serve reset' "$_fake/calls"; then ok "status --json 印出 NeedsLogin 但以非 0 結束 → 仍認得登出、不 heal"; else bad "依賴了 tailscale 的結束碼：非 0 結束時沒認出登出（分支成了死碼）"; fi
# hostname 只收 [A-Za-z0-9-]：含反引號／分號等就不放進指令
_h_weird=$(_hint_case weirdhost)
if [ "$_h_weird" = "tailscale up --accept-routes" ]; then ok "up 提示：不安全的 hostname 不放進指令"; else bad "up 提示收了不安全的 hostname：'$_h_weird'"; fi
# 告警送出失敗不能靜默：要留 log、仍 exit 0（狀態檔未更新 → 下一輪重試）
: > "$_fake/calls"
_alert_log=$(
  TAILSCALE="$_fake/tailscale"; KILL_SWITCH="$_fake/no-such-kill-switch"; export FAKE_CALLS="$_fake/calls" FAKE_STATE="NeedsLogin"
  throttled_alert() { return 1; }; sleep() { :; }; is_funnel_healthy() { return 1; }
  set -eo pipefail  # 與 production 相同：errexit 開著，少了 `|| rc=$?` 就會在此被殺
  ( main 2>&1 ); echo "RC=$?"  # main 內部會 exit，必須再包一層子 shell，否則 echo RC 跟著一起結束
)
if printf '%s' "$_alert_log" | grep -q '告警送出失敗' && printf '%s' "$_alert_log" | grep -q 'RC=0'; then ok "告警送出失敗 → 留 log 並仍 exit 0（下一輪重試）"; else bad "告警送出失敗被靜默吞掉或退出碼不是 0：$_alert_log"; fi
# tailscaled 卡住：ts_run 要在 TS_TIMEOUT 內放棄（沒有它 guard 會永遠掛住、launchd 不會補起第二個）
_t0=$SECONDS
( TAILSCALE="$_fake/tailscale"; export FAKE_CALLS="$_fake/calls" FAKE_HANG=1 TS_TIMEOUT=1; ts_run status --json >/dev/null 2>&1 ) && _hang_rc=0 || _hang_rc=$?
if [ "$_hang_rc" -ne 0 ] && [ $((SECONDS - _t0)) -lt 10 ]; then ok "tailscaled 卡住 → ts_run 在逾時內放棄（rc=$_hang_rc）"; else bad "ts_run 沒有逾時：rc=$_hang_rc、耗時 $((SECONDS - _t0))s"; fi
# 暫態：Starting 不是需要人工的狀態
_rc=$(_run_main Starting)
if grep -q '^needs_login|' "$_fake/alerts"; then bad "Starting（暫態）被誤報成 needs_login"; else ok "Starting 不誤報 needs_login"; fi
rm -rf "$_fake"

echo "[11] send-telegram.sh 路徑跟著 checkout 走（不依賴寫死的 /Users/ray/...）"
# throttled-alert.sh 的預設值是寫死的絕對路徑；guard 是唯一 source 它的人，必須自己用 REPO_ROOT 指定。
# 把 guard 與 helper 複製到別的目錄 source：路徑若仍指向原 checkout，換機器／搬資料夾就會送錯或根本送不出去。
_moved=$(mktemp -d)
mkdir -p "$_moved/scripts/funnel-guard" "$_moved/scripts/lib"
cp "$TEST_ROOT/scripts/funnel-guard/guard.sh" "$_moved/scripts/funnel-guard/"
cp "$TEST_ROOT/scripts/lib/throttled-alert.sh" "$TEST_ROOT/scripts/lib/send-telegram.sh" "$_moved/scripts/lib/" 2>/dev/null
_got=$(env -u THROTTLED_ALERT_SEND_TELEGRAM -u REPO_ROOT zsh -c 'GUARD_SOURCE_ONLY=1 source "$1" 2>/dev/null; printf %s "$THROTTLED_ALERT_SEND_TELEGRAM"' _ "$_moved/scripts/funnel-guard/guard.sh")
if [ "$_got" = "$_moved/scripts/lib/send-telegram.sh" ]; then ok "搬家後送出路徑指向新的 checkout"; else bad "送出路徑沒有跟著搬家：'$_got'（預期 $_moved/scripts/lib/send-telegram.sh）"; fi
rm -rf "$_moved"

echo
[ $fail -eq 0 ] && { echo "PASS"; exit 0; } || { echo "FAIL"; exit 1; }
