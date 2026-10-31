#!/bin/zsh
# send-telegram.sh — Telegram 訊息共用 wrapper
#
# Usage: bash scripts/lib/send-telegram.sh "<message>"
#
# Env: TELEGRAM_BOT_HOME_TOKEN or TELEGRAM_BOT_TOKEN（任一）+ TELEGRAM_CHAT_ID（必填，不內建預設值）。
# 由 .env.local 載入；Cowork scheduled task 跑時繼承 user shell env，所以 ~/.zshrc /
# ~/.zprofile 內 export 過的也讀得到。
#
# 抽自 daily-check-scheduler.sh / poi-enrich-scheduler.sh / tp-request-scheduler.sh
# 三支 scheduler 重複定義（v2.30.x Cowork migration 後 schedulers.sh 刪除，
# skill 用 Bash tool 呼此 helper）。

set -eo pipefail

MSG="$1"
if [ -z "$MSG" ]; then
  echo "Usage: send-telegram.sh <message>" >&2
  exit 1
fi

TOKEN="${TELEGRAM_BOT_HOME_TOKEN:-$TELEGRAM_BOT_TOKEN}"
CHAT_ID="${TELEGRAM_CHAT_ID:-}"

if [ -z "$TOKEN" ]; then
  echo "TELEGRAM_BOT_TOKEN (or TELEGRAM_BOT_HOME_TOKEN) 未設定" >&2
  exit 1
fi
if [ -z "$CHAT_ID" ]; then
  echo "TELEGRAM_CHAT_ID 未設定" >&2
  exit 1
fi

# v2.33.49 round 8a security: validate TOKEN format — 之前 unquoted ${TOKEN}
# interpolate 進 curl URL 沒驗 → 若 .env.local 被攻擊者寫，可注入 query string
# redirect 走別的 endpoint。Telegram bot token format: <bot_id>:<base58 secret>
if [[ ! "$TOKEN" =~ ^[0-9]+:[A-Za-z0-9_-]+$ ]]; then
  echo "TELEGRAM_BOT_TOKEN 格式不合法（必須是 <bot_id>:<secret>）" >&2
  exit 1
fi
if [[ ! "$CHAT_ID" =~ ^-?[0-9]+$ ]]; then
  echo "TELEGRAM_CHAT_ID 必須是純數字" >&2
  exit 1
fi

BODY=$(node -e "console.log(JSON.stringify({chat_id:'${CHAT_ID}',text:process.argv[1]}))" "$MSG")

curl -sf -X POST "https://api.telegram.org/bot${TOKEN}/sendMessage" \
  -H "Content-Type: application/json" \
  -d "$BODY" > /dev/null

echo "Telegram 已發送 ($(date '+%Y-%m-%d %H:%M:%S'))"
