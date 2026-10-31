#!/bin/zsh
# log-rotate.sh — scripts/logs/ retention sweep
#
# Why: per-date files (api-server/YYYY-MM-DD.log, daily-check/, tp-request/)
# 與 legacy single-file logs (api-server-stdout.log, request-job-stderr.log)
# 都無 retention，長期成長。Mac OS 內建 newsyslog 對 per-date filename pattern
# 不適用，這支 script 走 find -mtime + truncate 模式。
#
# 排程：scripts/tripline-api-server.ts `scheduleDailyScript(3, 30, ...)` 每天
# 03:30 跑。PR4 exit code wrapper 自動接 alert（exit 0 first time triggers
# recovery alert, exit 非 0 trigger failed alert）。
#
# 規則（編輯這檔請同步更新 scripts/funnel-guard/README.md 一致 retention 描述）：
#   1. 目錄下 per-date files (.log/.err) 超過 LOG_RETENTION_DAYS 天 → delete
#   2. 單檔 log（無日期）超過 LOG_MAX_BYTES → truncate 保留 tail 50%
#   3. funnel-guard / api-server-stderr.log 走 1MB cap（高頻 + 小 healthy line）
#
# 不刪：scripts/logs/poi-enrich/（已退役但留歷史備查），手動清理

set -eo pipefail

# 由腳本自己的位置推導（scripts/ 的上一層），不寫死絕對路徑；zsh 的 ${0:A:h:h} = 絕對化後取兩次 dirname。
REPO_ROOT="${0:A:h:h}"
LOG_DIR="$REPO_ROOT/scripts/logs"
LOG_RETENTION_DAYS=30
LOG_MAX_BYTES=10485760    # 10 MB for general single-file logs
LOG_FUNNEL_CAP=1048576    # 1 MB for funnel-guard / api-server-stderr (高頻)
LOG_PREFIX="[log-rotate]"

cd "$REPO_ROOT"

log() {
  echo "$LOG_PREFIX $(date '+%Y-%m-%d %H:%M:%S') $*"
}

if [ ! -d "$LOG_DIR" ]; then
  log "log dir $LOG_DIR 不存在，跳過"
  exit 0
fi

deleted_count=0
truncated_count=0

# Rule 1: per-date files (find by mtime) — 對 api-server/ daily-check/ tp-request/ funnel-guard/
log "rule 1: delete files mtime > $LOG_RETENTION_DAYS days under $LOG_DIR"
while IFS= read -r f; do
  log "  delete: $f"
  rm "$f"
  deleted_count=$((deleted_count + 1))
done < <(find "$LOG_DIR" -type f \( -name '*.log' -o -name '*.err' \) -mtime "+$LOG_RETENTION_DAYS" 2>/dev/null)

# Rule 2: oversized single-file logs — keep tail 50%
truncate_if_large() {
  local file="$1" cap="$2"
  [ -f "$file" ] || return 0
  local size
  size=$(stat -f%z "$file" 2>/dev/null || echo 0)
  if [ "$size" -gt "$cap" ]; then
    local keep=$((cap / 2))
    log "  truncate $file: ${size} bytes → tail ${keep} bytes"
    tail -c "$keep" "$file" > "${file}.trim" && mv "${file}.trim" "$file"
    truncated_count=$((truncated_count + 1))
  fi
}

log "rule 2: truncate oversized single-file logs"
truncate_if_large "$LOG_DIR/api-server-stdout.log" "$LOG_MAX_BYTES"
truncate_if_large "$LOG_DIR/request-job-stderr.log" "$LOG_MAX_BYTES"

log "rule 3: tighter cap for high-freq logs"
truncate_if_large "$LOG_DIR/api-server-stderr.log" "$LOG_FUNNEL_CAP"
truncate_if_large "$LOG_DIR/funnel-guard/stdout.log" "$LOG_FUNNEL_CAP"
truncate_if_large "$LOG_DIR/funnel-guard/stderr.log" "$LOG_FUNNEL_CAP"

log "done — deleted=$deleted_count truncated=$truncated_count"
