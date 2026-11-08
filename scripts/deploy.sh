#!/bin/zsh
# deploy.sh — 把 main 部署到獨立的執行目錄，launchd 只跑那份複本，不跑 git 工作目錄
#
# Why: plist 以前 symlink 回 repo、直接跑工作目錄，切 branch／改到一半的檔案都會立刻改變線上行為。
# 現在 repo 只是原始碼；上線的是 ~/.tripline-agent/app（從 commit 複製，不含未 commit 的東西）。
#
# Usage（合併到 main 後在這台 Mac 跑）：
#   zsh scripts/deploy.sh
#
# 執行目錄結構：
#   $RUNTIME/app/        程式（每次部署整份覆蓋；.env.local、logs、.disabled 例外）
#   $RUNTIME/.env.local  secret，執行目錄自己持有；首次部署從 repo 的 .env.local 帶過去，之後不再覆蓋
#   $RUNTIME/logs/       log；app/scripts/logs 是指向它的 symlink
#
# 環境變數（測試用）：RUNTIME_DIR、LAUNCH_AGENTS_DIR、DEPLOY_REF（預設 origin/main）、
# NO_FETCH、NO_LAUNCHCTL、SKIP_INSTALL。
set -eo pipefail

SRC="$(cd "$(dirname "${(%):-%x}")/.." && pwd)"
RUNTIME="${RUNTIME_DIR:-$HOME/.tripline-agent}"
AGENTS="${LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}"
REF="${DEPLOY_REF:-origin/main}"
JOBS=(com.tripline.api-server com.tripline.funnel-guard)

[ -n "$NO_FETCH" ] || git -C "$SRC" fetch -q origin main
SHA=$(git -C "$SRC" rev-parse --verify "$REF^{commit}")

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
git -C "$SRC" archive "$REF" | tar -x -C "$stage"

mkdir -p "$RUNTIME/app" "$RUNTIME/logs"/{api-server,funnel-guard}
# 被排除的路徑 rsync 不會刪：這些是執行目錄自己持有的狀態
rsync -a --delete \
  --exclude=/node_modules --exclude=/.env.local --exclude=/scripts/logs \
  --exclude=/scripts/funnel-guard/.disabled \
  --exclude=/tests --exclude=/.github \
  "$stage/" "$RUNTIME/app/"

if [ ! -e "$RUNTIME/.env.local" ] && [ -f "$SRC/.env.local" ]; then
  cp "$SRC/.env.local" "$RUNTIME/.env.local"
fi
[ -e "$RUNTIME/.env.local" ] && chmod 600 "$RUNTIME/.env.local"
# tp-agent（contained session 的 unix user）要讀 app 裡的 skill 與 MCP server；憑證不給 other 讀
chmod 755 "$RUNTIME"
chmod -R go+rX "$RUNTIME/app"
ln -sfn ../.env.local "$RUNTIME/app/.env.local"
ln -sfn ../../logs "$RUNTIME/app/scripts/logs"
echo "$SHA" > "$RUNTIME/app/.deployed-ref"

# Claude Code 對沒開過的資料夾會先跳「信任這個資料夾？」，吃掉 api-server 送進 tmux session 的 skill 指令
#（2026-11-08 06:10 daily-check 因此失敗：「REPL 未接到輸入」）。執行目錄是新路徑時沒有信任紀錄 → 部署時補上。
# 已信任就不改寫（執行中的 Claude 也會寫這個檔）；設定檔不存在或壞掉只警告，不中止部署。
# shortcut: 讀改寫沒有跨行程鎖，與同時寫檔的 Claude 理論上會互蓋；窗口極短，真的撞到再重跑部署即可。
CLAUDE_CONFIG="${CLAUDE_CONFIG_FILE:-$HOME/.claude.json}"
if [ -f "$CLAUDE_CONFIG" ]; then
  node -e '
    const fs = require("fs"), [file, dir] = process.argv.slice(1);
    const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
    const proj = (cfg.projects ||= {})[dir] ||= {};
    if (proj.hasTrustDialogAccepted === true) process.exit(0);
    proj.hasTrustDialogAccepted = true;
    const tmp = file + ".tmp-" + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
    fs.chmodSync(tmp, fs.statSync(file).mode & 0o777);   // writeFileSync 的 mode 會被 umask 遮掉，要明確 chmod
    fs.renameSync(tmp, file);
  ' "$CLAUDE_CONFIG" "$RUNTIME/app" || echo "⚠ 無法更新 $CLAUDE_CONFIG：請手動在 $RUNTIME/app 開一次 claude 並選信任" >&2
fi

[ -n "$SKIP_INSTALL" ] || (cd "$RUNTIME/app" && bun install --production)

mkdir -p "$AGENTS"
for job in $JOBS; do
  dst="$AGENTS/$job.plist"
  rm -f "$dst"   # 舊版是 symlink 回 repo；不先刪，下面的寫入會穿過去改到 repo 的範本
  sed "s#__RUNTIME__#$RUNTIME#g" "$stage/scripts/$job.plist" > "$dst"
  # plutil 只有 macOS 有（CI 跑在 Linux 上只驗到佔位符被替換）
  ! command -v plutil >/dev/null || plutil -lint "$dst" >/dev/null
done

if [ -z "$NO_LAUNCHCTL" ]; then
  gui="gui/$(id -u)"
  for job in $JOBS; do
    launchctl bootout "$gui/$job" 2>/dev/null || true
    # bootout 是非同步的：舊行程還在收尾時 bootstrap 會回 "Input/output error"（2026-11-07 首次部署踩到，
    # set -e 中斷後 api-server 沒起來、funnel-guard 沒重載）→ 等 service 真的消失再 bootstrap
    for _ in {1..20}; do launchctl print "$gui/$job" >/dev/null 2>&1 || break; sleep 0.5; done
    launchctl bootstrap "$gui" "$AGENTS/$job.plist" || { sleep 2; launchctl bootstrap "$gui" "$AGENTS/$job.plist"; }
    launchctl enable "$gui/$job"
    launchctl kickstart -k "$gui/$job"
  done
fi

echo "✓ 已部署 ${SHA[1,8]} → $RUNTIME/app"
