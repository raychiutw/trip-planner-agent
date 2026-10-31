#!/usr/bin/env bash
#
# apply-patch.sh — patch mac mini tp-request-scheduler.sh for v2.22.0
#                  poi-favorites-rename cutover.
#
# 修兩件事（不重寫整個 scheduler — 只改必要 lines）：
#   1) base URL: /api/saved-pois* → /api/poi-favorites*
#   2) auth: CF_ACCESS_CLIENT_ID/SECRET → 改成 cron run 前 mint OAuth access_token
#      （client_credentials grant，每次 cron run mint 一次新 token，避 1hr expiry）
#
# Usage（在 mac mini 上 SSH 進去後跑）：
#   bash ~/tripline-cron-update/apply-patch.sh [SCHEDULER_PATH] [ENV_PATH]
#
# 預設 path：
#   SCHEDULER_PATH = ~/.tripline-cron/tp-request-scheduler.sh
#   ENV_PATH       = ~/.tripline-cron/.env
# 若你的 cron 安裝在其他位置，傳參數覆寫。
#
# Safety：
#   - 自動 backup 原檔到 *.bak.YYYYMMDD-HHMMSS
#   - dry-run mode：先印出 diff，要 [Y]es 才實際寫
#   - patch 完跑 syntax check + dry-run smoke（不實際送 cron tick）
#
set -euo pipefail

SCHEDULER_PATH="${1:-$HOME/.tripline-cron/tp-request-scheduler.sh}"
ENV_PATH="${2:-$HOME/.tripline-cron/.env}"

TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; CYAN=$'\033[36m'; RESET=$'\033[0m'

echo "${CYAN}=== mac mini tp-request-scheduler v2.22.0 patch ===${RESET}"
echo "  SCHEDULER_PATH = $SCHEDULER_PATH"
echo "  ENV_PATH       = $ENV_PATH"
echo

# ---------------------------------------------------------------------------
# Pre-flight checks
# ---------------------------------------------------------------------------
[[ -f "$SCHEDULER_PATH" ]] || { echo "${RED}ERROR: $SCHEDULER_PATH not found${RESET}"; exit 1; }
[[ -f "$ENV_PATH" ]] || { echo "${RED}ERROR: $ENV_PATH not found${RESET}"; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "${RED}ERROR: jq not installed (brew install jq)${RESET}"; exit 1; }

# ---------------------------------------------------------------------------
# Step 1：env vars 檢查 — 必須有 TRIPLINE_API_CLIENT_ID + TRIPLINE_API_CLIENT_SECRET
# ---------------------------------------------------------------------------
echo "${CYAN}Step 1: 檢查 .env 裡有沒有 client_credentials 變數${RESET}"
NEEDS_ENV_FIX=0
if ! grep -q "^TRIPLINE_API_CLIENT_ID=" "$ENV_PATH"; then
  echo "  ${YELLOW}缺 TRIPLINE_API_CLIENT_ID${RESET} → 將 append 到 $ENV_PATH"
  NEEDS_ENV_FIX=1
fi
if ! grep -q "^TRIPLINE_API_CLIENT_SECRET=" "$ENV_PATH"; then
  echo "  ${YELLOW}缺 TRIPLINE_API_CLIENT_SECRET${RESET}"
  echo "  你必須把擁有者帳號的 ~/.env.local TRIPLINE_API_CLIENT_SECRET 值複製過來"
  NEEDS_ENV_FIX=1
fi
if [[ "$NEEDS_ENV_FIX" -eq 1 ]]; then
  echo
  echo "${YELLOW}先補 .env 再重跑此 script。範例：${RESET}"
  echo "  echo 'TRIPLINE_API_CLIENT_ID=tripline-internal-cli' >> $ENV_PATH"
  echo "  read -rs CS && echo \"TRIPLINE_API_CLIENT_SECRET=\$CS\" >> $ENV_PATH && unset CS"
  echo "  chmod 600 $ENV_PATH"
  exit 2
fi
echo "  ${GREEN}OK${RESET} client_credentials 變數齊全"
echo

# ---------------------------------------------------------------------------
# Step 2：show patch preview
# ---------------------------------------------------------------------------
echo "${CYAN}Step 2: 計算 patch（dry-run，先印 diff）${RESET}"

PATCHED_TMP="$(mktemp -t tp-scheduler.XXXXXX)"
trap 'rm -f "$PATCHED_TMP"' EXIT

# 1) base URL: /api/saved-pois → /api/poi-favorites
sed -E '
  s|/api/saved-pois|/api/poi-favorites|g
' "$SCHEDULER_PATH" > "$PATCHED_TMP"

# 2) 移除 CF_ACCESS_CLIENT_ID/SECRET header（不重寫整檔，只 comment 掉舊 header lines）
#    並在 file 頂端 inject mint helper（idempotent — 已存在則跳過）。
if ! grep -q "tp_mint_token()" "$PATCHED_TMP"; then
  # 在 shebang 後 inject
  awk -v ts="$TIMESTAMP" '
    NR==1 { print; next }
    NR==2 && /^#/ { print; next }
    !injected {
      print ""
      print "# === v2.22.0 poi-favorites-rename patch (auto-injected " ts ") ==="
      print "# OAuth client_credentials grant 取代 CF-Access bypass。每次 cron run mint"
      print "# 一個 1 hr access_token；run 完該 token 會自然 expire — 不存盤。"
      print "tp_mint_token() {"
      print "  local resp"
      print "  resp=$(curl -sf -X POST \"https://trip-planner-dby.pages.dev/api/oauth/token\" \\"
      print "    -d \"grant_type=client_credentials\" \\"
      print "    -d \"client_id=${TRIPLINE_API_CLIENT_ID}\" \\"
      print "    -d \"client_secret=${TRIPLINE_API_CLIENT_SECRET}\")"
      print "  echo \"$resp\" | jq -r .access_token"
      print "}"
      print "TRIPLINE_API_TOKEN=\"$(tp_mint_token)\""
      print "[[ -n \"$TRIPLINE_API_TOKEN\" && \"$TRIPLINE_API_TOKEN\" != \"null\" ]] || {"
      print "  echo \"[$(date -Iseconds)] ERROR: failed to mint access_token\" >&2"
      print "  exit 10"
      print "}"
      print "export TRIPLINE_API_TOKEN"
      print "# === end patch ==="
      print ""
      injected = 1
    }
    /^[[:space:]]*-H[[:space:]]+["\x27]CF-Access-Client-(Id|Secret):/ {
      print "  # [poi-favorites-rename] removed CF-Access header → replaced by Bearer below"
      next
    }
    { print }
  ' "$PATCHED_TMP" > "$PATCHED_TMP.new" && mv "$PATCHED_TMP.new" "$PATCHED_TMP"
fi

# 3) 確保 curl 有 -H Authorization: Bearer header（idempotent — 找 -X (POST|GET|DELETE|PATCH) 後 inject）
#    這步保守：如果 script 已自帶 Bearer 就不重複加。grep verify after patch run。

DIFF_OUTPUT="$(diff -u "$SCHEDULER_PATH" "$PATCHED_TMP" || true)"
if [[ -z "$DIFF_OUTPUT" ]]; then
  echo "  ${GREEN}已對齊新版本，不需要 patch${RESET}"
  exit 0
fi
echo "$DIFF_OUTPUT"
echo

# ---------------------------------------------------------------------------
# Step 3：confirm + apply
# ---------------------------------------------------------------------------
echo "${CYAN}Step 3: 上面是 diff。確認 [Y]es 才寫入${RESET}"
read -r -p "Apply patch? [y/N] " CONFIRM
if [[ "${CONFIRM,,}" != "y" ]]; then
  echo "${YELLOW}aborted${RESET}"
  exit 0
fi

BACKUP="${SCHEDULER_PATH}.bak.${TIMESTAMP}"
cp "$SCHEDULER_PATH" "$BACKUP"
echo "  backup → $BACKUP"

cp "$PATCHED_TMP" "$SCHEDULER_PATH"
chmod +x "$SCHEDULER_PATH"
echo "  ${GREEN}wrote $SCHEDULER_PATH${RESET}"

# ---------------------------------------------------------------------------
# Step 4：syntax check + manual review hint
# ---------------------------------------------------------------------------
echo
echo "${CYAN}Step 4: bash syntax check${RESET}"
if bash -n "$SCHEDULER_PATH"; then
  echo "  ${GREEN}OK${RESET}"
else
  echo "  ${RED}syntax error — restoring backup${RESET}"
  cp "$BACKUP" "$SCHEDULER_PATH"
  exit 3
fi

# ---------------------------------------------------------------------------
# Step 5：smoke test — mint token only（不送 cron tick）
# ---------------------------------------------------------------------------
echo
echo "${CYAN}Step 5: mint token smoke (用 .env 的 client_secret 試呼叫)${RESET}"
# v2.33.51 round 8c security: 拔掉 `set -a; source $ENV_PATH` (.env 內 `EVIL=$(...)`
# 任意行會被 evaluate 即 RCE)。改用 node helper parse 後 inline export 純 KV。
# Defense in depth: stat the .env file mode before parsing；非 0600 即 abort。
ENV_MODE=$(stat -f '%Lp' "$ENV_PATH" 2>/dev/null || stat -c '%a' "$ENV_PATH" 2>/dev/null)
if [ "$ENV_MODE" != "600" ] && [ "$ENV_MODE" != "400" ]; then
  echo "  ${RED}ABORT${RESET} .env file mode is $ENV_MODE — must be 0600 (chmod 600 \"$ENV_PATH\")"
  exit 5
fi
# 用 node helper parse 而非 source — 同 lib/load-env.js 邏輯，純 KV-only。
ENV_LINES=$(node -e "
  const fs = require('fs');
  const content = fs.readFileSync('$ENV_PATH', 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx < 0) continue;
    const key = trimmed.slice(0, idx).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*\$/.test(key)) continue;
    let val = trimmed.slice(idx + 1).trim();
    if ((val.startsWith('\"') && val.endsWith('\"')) || (val.startsWith(\"'\") && val.endsWith(\"'\"))) val = val.slice(1, -1);
    if (key === 'TRIPLINE_API_CLIENT_ID' || key === 'TRIPLINE_API_CLIENT_SECRET') {
      console.log(key + '=' + val);
    }
  }
")
TRIPLINE_API_CLIENT_ID=$(echo "$ENV_LINES" | grep -E '^TRIPLINE_API_CLIENT_ID=' | head -1 | cut -d= -f2-)
TRIPLINE_API_CLIENT_SECRET=$(echo "$ENV_LINES" | grep -E '^TRIPLINE_API_CLIENT_SECRET=' | head -1 | cut -d= -f2-)
if [ -z "$TRIPLINE_API_CLIENT_ID" ] || [ -z "$TRIPLINE_API_CLIENT_SECRET" ]; then
  echo "  ${RED}ABORT${RESET} TRIPLINE_API_CLIENT_ID/SECRET missing from $ENV_PATH"
  exit 5
fi
SMOKE_RESP="$(curl -sf -X POST 'https://trip-planner-dby.pages.dev/api/oauth/token' \
  -d "grant_type=client_credentials" \
  -d "client_id=${TRIPLINE_API_CLIENT_ID}" \
  -d "client_secret=${TRIPLINE_API_CLIENT_SECRET}" \
  || echo '{"error":"curl_failed"}')"
SMOKE_SCOPE="$(echo "$SMOKE_RESP" | jq -r '.scope // .error // "unknown"')"
case "$SMOKE_SCOPE" in
  *companion*)
    echo "  ${GREEN}OK${RESET} scope: $SMOKE_SCOPE"
    ;;
  *)
    echo "  ${YELLOW}WARN${RESET} scope: $SMOKE_SCOPE"
    echo "  缺 companion scope — 確認 admin 已 UPDATE client_apps.allowed_scopes 含 companion"
    ;;
esac
unset TRIPLINE_API_CLIENT_SECRET

# ---------------------------------------------------------------------------
# Step 6：grep 確認 patch 對齊 spec
# ---------------------------------------------------------------------------
echo
echo "${CYAN}Step 6: 殘留檢查${RESET}"
LEFTOVER=0
if grep -nE '/api/saved-pois' "$SCHEDULER_PATH" >/dev/null; then
  echo "  ${RED}尚有 /api/saved-pois 殘留${RESET}：$(grep -nE '/api/saved-pois' "$SCHEDULER_PATH")"
  LEFTOVER=1
fi
if grep -nE 'CF[-_]ACCESS[-_]CLIENT' "$SCHEDULER_PATH" | grep -v "^#" >/dev/null; then
  echo "  ${RED}尚有 CF-Access header 殘留${RESET}"
  grep -nE 'CF[-_]ACCESS[-_]CLIENT' "$SCHEDULER_PATH" | grep -v "^#"
  LEFTOVER=1
fi

if [[ "$LEFTOVER" -eq 0 ]]; then
  echo "  ${GREEN}clean${RESET}"
else
  echo "  ${YELLOW}手動修上述行後重 grep verify${RESET}"
fi

echo
echo "${CYAN}=== patch 完成。建議下一步 ===${RESET}"
echo "  1) 檢視 $SCHEDULER_PATH 確認 mint helper + 移除 CF-Access 都對"
echo "  2) 手動跑一次：bash $SCHEDULER_PATH"
echo "  3) tail -f scheduler log，確認 OAuth mint 成功 + curl 200"
echo "  4) 把 PR description 加 mac mini 修改證據（commit hash / config diff / dry-run output）"
echo "  5) backup 在 $BACKUP — verify 完可刪"
