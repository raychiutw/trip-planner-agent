#!/usr/bin/env bash
# telegram-smoke.sh — Telegram 通知渠道 smoke test（B-P6 task 10.4）
#
# 驗 TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID 能成功 sendMessage。
# 用 hostname + ISO timestamp 當 message body 確認 routing 正確。
#
# Usage:
#   TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... bash scripts/telegram-smoke.sh
#
# Exit codes:
#   0 — 成功 (Telegram API 200 + ok=true)
#   1 — env 未設
#   2 — Telegram API 失敗（HTTP 非 200 或 ok=false）

set -euo pipefail

TOKEN="${TELEGRAM_BOT_HOME_TOKEN:-${TELEGRAM_BOT_TOKEN:-}}"
CHAT_ID="${TELEGRAM_CHAT_ID:-}"

if [ -z "$TOKEN" ]; then
  echo "ERROR: TELEGRAM_BOT_TOKEN / TELEGRAM_BOT_HOME_TOKEN 未設定" >&2
  exit 1
fi

if [ -z "$CHAT_ID" ]; then
  echo "ERROR: TELEGRAM_CHAT_ID 未設定" >&2
  exit 1
fi

HOSTNAME_VAL="$(hostname)"
TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
MSG="🟢 Tripline Telegram smoke test
host: ${HOSTNAME_VAL}
time: ${TIMESTAMP}
source: ${GITHUB_REF_NAME:-${BRANCH:-local}}@${GITHUB_SHA:-${COMMIT_SHA:-unknown}}"

# 用 node JSON.stringify 安全 escape（避免 shell quote 問題）
BODY=$(node -e "console.log(JSON.stringify({chat_id: process.argv[1], text: process.argv[2]}))" "$CHAT_ID" "$MSG")

RESPONSE=$(curl -sS -w "\n%{http_code}" -X POST \
  "https://api.telegram.org/bot${TOKEN}/sendMessage" \
  -H 'Content-Type: application/json' \
  -d "$BODY")

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
RESPONSE_BODY=$(echo "$RESPONSE" | head -n -1)

if [ "$HTTP_CODE" != "200" ]; then
  echo "ERROR: Telegram API HTTP $HTTP_CODE" >&2
  echo "$RESPONSE_BODY" >&2
  exit 2
fi

# verify ok:true
if ! echo "$RESPONSE_BODY" | grep -q '"ok":true'; then
  echo "ERROR: Telegram API responded but ok != true" >&2
  echo "$RESPONSE_BODY" >&2
  exit 2
fi

echo "OK: Telegram smoke test passed (chat_id=${CHAT_ID})"
echo "$RESPONSE_BODY"
