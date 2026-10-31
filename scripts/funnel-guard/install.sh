#!/bin/zsh
# install.sh — 安裝 / 重灌 funnel-guard launchd job
#
# Idempotent：先 bootout（容忍 not loaded）→ 再 bootstrap。多跑不破。
#
# Usage:
#   bash scripts/funnel-guard/install.sh
#
# Uninstall:
#   launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.tripline.funnel-guard.plist
#   rm ~/Library/LaunchAgents/com.tripline.funnel-guard.plist

set -eo pipefail

REPO_ROOT="/Users/ray/Projects/trip-planner-agent"
PLIST_NAME="com.tripline.funnel-guard.plist"
SRC_PLIST="$REPO_ROOT/scripts/$PLIST_NAME"
DST_PLIST="$HOME/Library/LaunchAgents/$PLIST_NAME"
LOG_DIR="$REPO_ROOT/scripts/logs/funnel-guard"
GUI_TARGET="gui/$(id -u)"

if [ ! -f "$SRC_PLIST" ]; then
  echo "✗ 找不到 $SRC_PLIST" >&2
  exit 1
fi

if [ ! -x "$REPO_ROOT/scripts/funnel-guard/guard.sh" ]; then
  echo "✗ guard.sh 不存在或無 +x 權限" >&2
  exit 1
fi

# 預檢：tailscale CLI（brew 或 macOS App 版）+ jq 必須存在
if [ ! -x /opt/homebrew/bin/tailscale ] && [ ! -x /usr/local/bin/tailscale ] && [ ! -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ]; then
  echo "✗ 找不到 tailscale CLI（/opt/homebrew/bin、/usr/local/bin、Tailscale.app）" >&2
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "✗ 缺少必要工具：jq" >&2
  echo "  jq 安裝：brew install jq" >&2
  exit 1
fi

mkdir -p "$LOG_DIR"
mkdir -p "$(dirname "$DST_PLIST")"

# Symlink 而非 copy — repo 內 plist 改動立即生效（reinstall 即可）
ln -sf "$SRC_PLIST" "$DST_PLIST"

# Bootout 既有 job（容忍 not loaded — exit code 3 = "No such process"）
launchctl bootout "$GUI_TARGET/com.tripline.funnel-guard" 2>/dev/null || true

# Bootstrap 新 job
launchctl bootstrap "$GUI_TARGET" "$DST_PLIST"

# Enable + kickstart（確保 RunAtLoad 立即 trigger 第一次）
launchctl enable "$GUI_TARGET/com.tripline.funnel-guard"
launchctl kickstart -k "$GUI_TARGET/com.tripline.funnel-guard"

echo "✓ funnel-guard 已安裝並啟動"
echo "  plist: $DST_PLIST → $SRC_PLIST"
echo "  log:   $LOG_DIR/{stdout,stderr}.log"
echo ""
echo "驗證："
echo "  launchctl print $GUI_TARGET/com.tripline.funnel-guard | head -20"
echo "  tail -f $LOG_DIR/stdout.log"
