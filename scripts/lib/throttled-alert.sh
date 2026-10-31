#!/bin/zsh
# throttled-alert.sh — state-transition + 1hr throttle wrapper around send-telegram.sh
#
# 抽自 funnel-guard guard.sh state machine — 給所有 cron / launchd alert callers 共用，
# 避免 sustained failure loop 把 Telegram alert flood。
#
# Usage (sourceable，非 standalone)：
#
#   source "$REPO_ROOT/scripts/lib/throttled-alert.sh"
#   throttled_alert "<key>" "<state>" "<message>" [throttle_sec]
#
# 規則：
#   - new_state="healthy" + prev != healthy/unknown：always alert (recovery)
#   - new_state="healthy" + prev=healthy/unknown：silent
#   - state change：always alert
#   - same state：每 throttle_sec (default 3600) 最多 1 個
#
# State cache：/tmp/throttled-alert-<key>.state，格式 "state|epoch_ts"

# v2.33.133 fix: 移除原 sourced-vs-exec guard — zsh launchd 環境下
# FUNCTION_ARGZERO option 預設 ON，sourced file 內 $0 = throttled-alert.sh，
# 觸發誤判 → exit 2，funnel-guard 12:00 後完全停擺 (~2hr orphan)。
# 沒有實際安全 risk 需要 guard（手動誤跑就只是定義 function 沒呼叫）。

: "${THROTTLED_ALERT_STATE_DIR:=/tmp}"
: "${THROTTLED_ALERT_DEFAULT_TTL:=3600}"
# send-telegram.sh 路徑 — caller 應設 THROTTLED_ALERT_SEND_TELEGRAM 環境變數
# (放棄 zsh ${(%):-%x} magic：top-level 不可靠；explicit 較穩)
: "${THROTTLED_ALERT_SEND_TELEGRAM:=/Users/ray/Projects/trip-planner/scripts/lib/send-telegram.sh}"

_throttled_alert_state_file() {
  local key="$1"
  # 過濾 key 內非 [A-Za-z0-9_-] → 防 path traversal
  local safe
  safe=$(printf '%s' "$key" | LC_ALL=C tr -c 'A-Za-z0-9_-' '_')
  printf '%s/throttled-alert-%s.state' "$THROTTLED_ALERT_STATE_DIR" "$safe"
}

_throttled_alert_read() {
  local file="$1"
  if [ -f "$file" ]; then
    cat "$file"
  else
    echo "unknown|0"
  fi
}

_throttled_alert_should_send() {
  local prev_state="$1" new_state="$2" prev_ts="$3" now="$4" ttl="$5"
  # Recovery transition：unhealthy* → healthy always
  if [ "$new_state" = "healthy" ] && [ "$prev_state" != "healthy" ] && [ "$prev_state" != "unknown" ]; then
    return 0
  fi
  # Healthy steady-state never
  if [ "$new_state" = "healthy" ]; then
    return 1
  fi
  # State change always
  if [ "$prev_state" != "$new_state" ]; then
    return 0
  fi
  # Same state — throttle
  if [ $(( now - prev_ts )) -ge "$ttl" ]; then
    return 0
  fi
  return 1
}

# Main API
# throttled_alert <key> <state> <message> [ttl_sec]
# exit 0：alert sent or correctly suppressed；exit 非 0：send-telegram.sh 失敗
throttled_alert() {
  local key="$1" new_state="$2" msg="$3" ttl="${4:-$THROTTLED_ALERT_DEFAULT_TTL}"

  if [ -z "$key" ] || [ -z "$new_state" ] || [ -z "$msg" ]; then
    echo "throttled_alert: usage: throttled_alert <key> <state> <message> [ttl_sec]" >&2
    return 2
  fi

  local file state_line prev_state prev_ts now
  file=$(_throttled_alert_state_file "$key")
  state_line=$(_throttled_alert_read "$file")
  prev_state="${state_line%%|*}"
  prev_ts="${state_line##*|}"
  now=$(date +%s)

  # Sanitize ts (防 corrupt file → ts 非數字)
  if ! [[ "$prev_ts" =~ ^[0-9]+$ ]]; then
    prev_ts=0
  fi

  if _throttled_alert_should_send "$prev_state" "$new_state" "$prev_ts" "$now" "$ttl"; then
    if [ -x "$THROTTLED_ALERT_SEND_TELEGRAM" ]; then
      bash "$THROTTLED_ALERT_SEND_TELEGRAM" "$msg"
      local rc=$?
      if [ $rc -eq 0 ]; then
        printf '%s|%s\n' "$new_state" "$now" > "$file"
      fi
      return $rc
    else
      echo "throttled_alert: send-telegram.sh 不存在於 $THROTTLED_ALERT_SEND_TELEGRAM" >&2
      return 1
    fi
  else
    # 保留舊 ts 維持 throttle window
    printf '%s|%s\n' "$new_state" "$prev_ts" > "$file"
    return 0
  fi
}
