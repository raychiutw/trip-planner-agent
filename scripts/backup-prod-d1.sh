#!/usr/bin/env bash
# scripts/backup-prod-d1.sh — Prod D1 完整備份（排除 log tables）
#
# 用途：migration apply 前的安全網。除了 wrangler d1 time-travel bookmark，
# 額外存一份 SQL dump 到 ./backups/，可獨立 restore 或 audit。
#
# 排除 log tables（每天百萬 rows 沒備份價值，吃磁碟空間）：
#   - api_logs (0007/0024) — 每 request 一筆，30 天 rotate
#   - error_reports (0017) — 客戶端錯誤回報
#   - auth_audit_log (0036) — V2 OAuth audit
#   - webhook_logs (0005, 0006 移除但表可能殘留)
#
# 使用：
#   bash scripts/backup-prod-d1.sh                    # 預設輸出 ./backups/d1-prod-<timestamp>.sql
#   bash scripts/backup-prod-d1.sh /tmp/foo.sql       # 自訂路徑

set -euo pipefail

DB_NAME="trip-planner-db"
OUT="${1:-./backups/d1-prod-$(date +%Y%m%d-%H%M%S).sql}"
LOG_TABLES=(api_logs error_reports auth_audit_log webhook_logs)

# 動態抓所有 user table（排除 log tables 與 sqlite_*）。
# pipefail（set -o pipefail 已在 set -euo pipefail）會在 wrangler 或 python 失敗時 abort。
# 用 while-read loop 而非 mapfile，相容 macOS default bash 3.2（mapfile 是 bash 4+）。
TABLES_JSON=$(npx wrangler d1 execute "$DB_NAME" --remote --json --command \
  "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name;")

ALL_TABLES=()
while IFS= read -r line; do
  [ -n "$line" ] && ALL_TABLES+=("$line")
# wrangler 會在 --json stdout 前面印 warning（"Using CF_ACCOUNT_ID ... deprecated"、或帶
# 中括號的 "▲ [WARNING]" tag），直接 json.load 會 JSONDecodeError。用 regex 抓 JSON 陣列開頭
# `[` + 空白 + `{`（d1 --json 一律回 [{...}]），跳過前綴雜訊；連 `[WARNING]` 那種含 '[' 的也不會誤判。
done < <(printf '%s' "$TABLES_JSON" | python3 -c "import sys, json, re; s = sys.stdin.read(); m = re.search(r'\[\s*\{', s); d = json.loads(s[m.start():]) if m else []; [print(r['name']) for r in (d[0]['results'] if d else [])]")

if [ ${#ALL_TABLES[@]} -eq 0 ]; then
  echo "❌ 抓不到 user tables — 確認 wrangler 認證 + DB_NAME 正確"
  exit 1
fi

BACKUP_TABLES=()
for t in "${ALL_TABLES[@]}"; do
  skip=0
  for log in "${LOG_TABLES[@]}"; do
    if [[ "$t" == "$log" ]]; then skip=1; break; fi
  done
  [[ $skip -eq 0 ]] && BACKUP_TABLES+=("$t")
done

mkdir -p "$(dirname "$OUT")"

echo "=== D1 prod backup ==="
echo "DB:       $DB_NAME"
echo "Output:   $OUT"
echo "Excluded: ${LOG_TABLES[*]}"
echo "Backup:   ${BACKUP_TABLES[*]}"
echo

# 組 --table 參數
TABLE_ARGS=()
for t in "${BACKUP_TABLES[@]}"; do
  TABLE_ARGS+=(--table "$t")
done

npx wrangler d1 export "$DB_NAME" --remote --output "$OUT" "${TABLE_ARGS[@]}"

if [[ -s "$OUT" ]]; then
  SIZE=$(du -h "$OUT" | cut -f1)
  LINES=$(wc -l < "$OUT" | tr -d ' ')
  echo
  echo "✅ Backup OK"
  echo "   File:  $OUT"
  echo "   Size:  $SIZE"
  echo "   Lines: $LINES"
  echo
  echo "Restore (if needed):"
  echo "   wrangler d1 execute $DB_NAME --remote --file=$OUT"
  echo
  echo "Time-travel restore (preferred for full DB):"
  echo "   wrangler d1 time-travel restore $DB_NAME --bookmark <pre-migration-bookmark>"
else
  echo "❌ Backup FAILED — output empty or missing"
  exit 1
fi
