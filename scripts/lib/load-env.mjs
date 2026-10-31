#!/usr/bin/env node
// load-env.mjs — 把 .env.local parse 完輸出 bash `export` 指令，給 shell 腳本用 `eval`
// （tripline-job.sh、tp-* skills；scheduler-common.sh 已不存在）。parser 與其他 JS 腳本共用
// lib/load-env.js 的 parseEnv。
//
// 替代品：原本 scheduler-common.sh 用 `while IFS= read -r line` 讀 .env.local，
// 遇到 multi-line single-quoted JSON（例：GOOGLE_CLOUD_SA_KEY 的 private_key）
// 就把每行 base64 切片當獨立 KEY=VALUE export → zsh 丟「not an identifier」+
// `set -eo pipefail` 中止 → daily-check-scheduler.sh 沒建 LOG_FILE 就死。
// 觀察到 2026-05-11 06:13 的 .context/daily-check-stderr.log 即此症狀。
//
// 用法：eval "$(node scripts/lib/load-env.mjs path/to/.env)"
//
// 輸出格式：每行 `export KEY=$'value'`（bash ANSI-C quoting）— 能在單行內
// encode 跨行值、控制字元、單引號，比 single-quoted shell 更穩。

import fs from 'node:fs';
import { createRequire } from 'node:module';

// 與其他腳本共用同一個 parser（lib/load-env.js 的 parseEnv）。
const { parseEnv } = createRequire(import.meta.url)('./load-env.js');

const envPath = process.argv[2];
if (!envPath) {
  process.stderr.write('load-env.mjs: 缺 argument，usage: node load-env.mjs <path>\n');
  process.exit(1);
}
if (!fs.existsSync(envPath)) {
  process.stderr.write(`load-env.mjs: file not found: ${envPath}\n`);
  process.exit(1);
}

// 用 dotenv.parse（純函數）而非 config()：config() 會注入 process.env，且 v17+
// 把「injected env … { override: true }」tip 印到 stdout，污染本 loader「stdout 只
// 有 export 行」的契約 → eval 進 zsh 時 `parse error near '}'`。parse() 無 side
// effect、不碰 stdout，與 dotenv 版本無關。
// 非法 key 由 parseEnv 過濾，這裡只負責把「跳過了誰」寫到 stderr（stdout 只能有 export 行）。
const parsed = parseEnv(fs.readFileSync(envPath, 'utf8'), (key) => {
  process.stderr.write(`load-env.mjs: 跳過非法 key: ${key}\n`);
});

function ansiCQuote(value) {
  return `$'${String(value)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')}'`;
}

for (const [key, value] of Object.entries(parsed)) {
  process.stdout.write(`export ${key}=${ansiCQuote(value)}\n`);
}
