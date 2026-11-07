#!/bin/zsh
# install.sh — 已改由 scripts/deploy.sh 統一部署（launchd 不再 symlink 回 repo 工作目錄）。
exec "$(cd "$(dirname "${(%):-%x}")/.." && pwd)/deploy.sh" "$@"
