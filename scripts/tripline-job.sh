#!/bin/zsh
# tripline-job.sh — 15 分鐘排程：卡住偵測 + 遺漏處理
set -eo pipefail

# 由腳本自己的位置推導（scripts/ 的上一層），不寫死絕對路徑。
PROJECT_DIR="${0:A:h:h}"
LOG_DIR="$PROJECT_DIR/scripts/logs/tp-request"
LOG_FILE="$LOG_DIR/tripline-job-$(date +%Y-%m-%d).log"
STALE_THRESHOLD_MIN=20  # > Claude 15 min timeout，避免 race

# launchd 不會 source shell rc, PATH 不含 /opt/homebrew/bin。
# 顯式擴 PATH 給 node / curl / python3 用（找不到 node 會讓整個 job fail）
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

mkdir -p "$LOG_DIR"
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"; }

# Log rotation: 7 天
find "$LOG_DIR" -name "tripline-job-*.log" -mtime +7 -delete 2>/dev/null || true

# Load env — 與其他腳本共用同一個 .env.local parser（scripts/lib/load-env.js 的 parseEnv，
# 由 load-env.mjs 輸出成 `export KEY=$'...'`）。取代原本的逐行 bash 迴圈：它不認得跨多行的值，
# 引號與 key 驗證也得自己再寫一份。stdout 只有 export 行（可直接 eval），診斷走 stderr → log。
if [ -f "$PROJECT_DIR/.env.local" ]; then
  _env_exports=$(node "$PROJECT_DIR/scripts/lib/load-env.mjs" "$PROJECT_DIR/.env.local" 2>>"$LOG_FILE") || {
    log "load-env.mjs 失敗，環境變數未載入（node／dotenv 可用嗎？）"
    exit 1
  }
  eval "$_env_exports"
fi

log "--- Job 啟動 ---"

# V2 OAuth client_credentials — replaces CF Access Service Token
TOKEN=$(node "$PROJECT_DIR/scripts/lib/get-tripline-token.js" 2>>"$LOG_FILE") || {
  log "Token 取得失敗,確認 TRIPLINE_API_CLIENT_ID/SECRET env"
  log "--- Job 結束（Token 失敗）---"
  exit 1
}

# 1. 卡住偵測：processing 超過 STALE_THRESHOLD_MIN 分鐘 → 標記 failed
PROCESSING=$(curl -sf \
  -H "Authorization: Bearer $TOKEN" \
  "https://trip-planner-dby.pages.dev/api/requests?status=processing" 2>&1) || {
  log "查詢 processing 失敗"
  PROCESSING="[]"
}

STALE_IDS=$(echo "$PROCESSING" | python3 -c "
import sys, json
from datetime import datetime, timedelta, timezone
threshold = timedelta(minutes=${STALE_THRESHOLD_MIN})
now = datetime.now(timezone.utc)
data = json.load(sys.stdin)
items = data if isinstance(data, list) else data.get('items', [])
for r in items:
    updated = r.get('updated_at') or r.get('created_at', '')
    if updated:
        try:
            t = datetime.fromisoformat(updated.replace('Z', '+00:00'))
            if now - t > threshold:
                print(r['id'])
        except: pass
" 2>/dev/null)

if [ -n "$STALE_IDS" ]; then
  while read -r rid; do
    log "  卡住偵測: id=$rid → failed"
    curl -sf -X PATCH \
      -H "Authorization: Bearer $TOKEN" \
      -H "Origin: https://trip-planner-dby.pages.dev" \
      -H "Content-Type: application/json" \
      -d '{"status":"failed","processed_by":"job"}' \
      "https://trip-planner-dby.pages.dev/api/requests/$rid" > /dev/null 2>&1 && \
      log "  id=$rid → failed 成功" || log "  id=$rid → failed 失敗"
  done <<< "$STALE_IDS"
else
  log "  無卡住的 processing 請求"
fi

# 2. 觸發 API server 處理遺漏的 open 請求
log "觸發 API server (source=job)"
TRIGGER_RESULT=$(curl -sf -X POST \
  -H "Authorization: Bearer $TRIPLINE_API_SECRET" \
  -H "Content-Type: application/json" \
  "http://127.0.0.1:6688/trigger?source=job" 2>&1) || {
  log "API server 觸發失敗（可能離線）: $TRIGGER_RESULT"
  log "--- Job 結束（API server 不可用）---"
  # v2.33.49 round 8a: exit 1 instead of 0 — 之前 exit 0 讓 launchd 看不到
  # outage，Telegram alert 也不 fire (daily-check 寫日報靠 launchd error log)。
  exit 1
}

log "API server 回應: $TRIGGER_RESULT"
log "--- Job 結束 ---"
