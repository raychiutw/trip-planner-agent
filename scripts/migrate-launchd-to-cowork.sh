#!/bin/zsh
# migrate-launchd-to-cowork.sh — v2.30.5 一次性手動執行
#
# 廢除舊 launchd-based scheduler（daily-check / request-job / poi-enrich-monthly），
# 改用 Claude Desktop Cowork scheduled task 觸發 skill。詳見 CHANGELOG v2.30.5。
#
# 跑完後在 Claude Desktop 內手動建 3 個 Cowork scheduled task（task name 列在
# 每個 SKILL.md 開頭「排程」段）。
#
# Usage: bash scripts/migrate-launchd-to-cowork.sh
#
# **保留** com.tripline.api-server.plist — API server LaunchAgent 不是 scheduler。

set -eo pipefail

echo "==== Tripline launchd → Cowork migration ===="
echo ""

DAEMON_PLIST="/Library/LaunchDaemons/com.tripline.daily-check.plist"
AGENT_DIR="$HOME/Library/LaunchAgents"
BIN_DIR="$HOME/.local/bin"

# ── Step 1: bootout LaunchDaemon (sudo required) ────────────────
if [ -f "$DAEMON_PLIST" ]; then
  echo "[1/4] Bootout LaunchDaemon: $DAEMON_PLIST"
  echo "    (需要 sudo 因為 /Library/LaunchDaemons/ 屬於 root)"
  sudo launchctl bootout system "$DAEMON_PLIST" 2>/dev/null || true
  sudo rm -f "$DAEMON_PLIST"
  echo "    ✓ Removed"
else
  echo "[1/4] LaunchDaemon $DAEMON_PLIST 不存在，skip"
fi
echo ""

# ── Step 2: bootout LaunchAgents ─────────────────────────────────
echo "[2/4] Bootout LaunchAgents:"
USER_UID=$(id -u)

for plist_name in com.tripline.daily-check.plist com.tripline.request-job.plist com.tripline.poi-enrich-monthly.plist; do
  plist_path="$AGENT_DIR/$plist_name"
  if [ -f "$plist_path" ]; then
    echo "    bootout: $plist_path"
    launchctl bootout "gui/$USER_UID" "$plist_path" 2>/dev/null || true
    rm -f "$plist_path"
    echo "    ✓ Removed $plist_name"
  fi
  # 順便清 .migrated-* 備份
  for migrated in "$AGENT_DIR/$plist_name".migrated-*; do
    if [ -f "$migrated" ]; then
      echo "    rm migrated backup: $migrated"
      rm -f "$migrated"
    fi
  done 2>/dev/null
done

echo "    （保留 com.tripline.api-server.plist — 不是 scheduler）"
echo ""

# ── Step 3: rm helper bin scripts ────────────────────────────────
echo "[3/4] Remove helper bin scripts:"
for bin_name in tripline-daily-check.sh tripline-poi-enrich-monthly.sh; do
  bin_path="$BIN_DIR/$bin_name"
  if [ -f "$bin_path" ]; then
    rm -f "$bin_path"
    echo "    ✓ Removed $bin_path"
  fi
done
echo ""

# ── Step 4: 提示手動步驟 ─────────────────────────────────────────
echo "[4/4] ✅ Cleanup 完成。"
echo ""
echo "── 接下來請在 Claude Desktop 內手動建 3 個 Cowork scheduled task ──"
echo ""
echo "  1. Name: Tripline Daily Check"
echo "     Frequency: Daily"
echo "     Prompt: /tp-daily-check"
echo "     Working folder: /Users/ray/Projects/trip-planner"
echo ""
echo "  2. Name: Tripline Request Handler"
echo "     Frequency: Hourly"
echo "     Prompt: /tp-request"
echo "     Working folder: /Users/ray/Projects/trip-planner"
echo ""
echo "  3. Name: Tripline POI Enrich Monthly"
echo "     Frequency: Daily (skill 內檢查是否 1 號)"
echo "     Prompt: /tp-poi-enrich-monthly"
echo "     Working folder: /Users/ray/Projects/trip-planner"
echo ""
echo "建好後 Cowork 會自動觸發。確認 launchctl 已清空："
echo "  launchctl list | grep tripline"
echo "  （應該只剩 com.tripline.api-server）"
