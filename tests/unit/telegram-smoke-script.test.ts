/**
 * scripts/telegram-smoke.sh + .github/workflows/telegram-smoke.yml 結構測試
 * （B-P6 task 10.4）
 *
 * 驗 smoke script 的 contract：
 * - TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID env 名稱不變
 * - Exit code semantics（0 ok / 1 env / 2 API fail）
 * - workflow yml schedule + dispatch + secrets reference 正確
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SCRIPT = fs.readFileSync(
  path.resolve(__dirname, '../../scripts/telegram-smoke.sh'),
  'utf8',
);
const WORKFLOW = fs.readFileSync(
  path.resolve(__dirname, '../../.github/workflows/telegram-smoke.yml'),
  'utf8',
);

describe('telegram-smoke.sh — script contract', () => {
  it('shebang 用 bash + set -euo pipefail（fail-loud）', () => {
    expect(SCRIPT).toMatch(/^#!\/usr\/bin\/env bash/);
    expect(SCRIPT).toMatch(/set -euo pipefail/);
  });

  it('讀 TELEGRAM_BOT_HOME_TOKEN 或 TELEGRAM_BOT_TOKEN env（與 daily-check-scheduler 一致）', () => {
    expect(SCRIPT).toMatch(/TELEGRAM_BOT_HOME_TOKEN/);
    expect(SCRIPT).toMatch(/TELEGRAM_BOT_TOKEN/);
  });

  it('讀 TELEGRAM_CHAT_ID env，不內建任何 chat id（個人識別資訊不進 repo）', () => {
    expect(SCRIPT).toMatch(/TELEGRAM_CHAT_ID/);
    expect(SCRIPT).not.toMatch(/\d{8,}/);
  });

  it('沒設 TELEGRAM_CHAT_ID → 退出碼 1（不是悄悄用預設值寄給別人）', () => {
    expect(SCRIPT).toMatch(/-z "\$CHAT_ID"/);
  });

  it('No-token exit code 1', () => {
    expect(SCRIPT).toMatch(/exit 1/);
  });

  it('Telegram API fail exit code 2', () => {
    expect(SCRIPT).toMatch(/exit 2/);
  });

  it('呼叫 Telegram sendMessage endpoint', () => {
    expect(SCRIPT).toMatch(/api\.telegram\.org\/bot\$\{TOKEN\}\/sendMessage/);
  });

  it('verify response ok:true（不只看 HTTP 200）', () => {
    expect(SCRIPT).toMatch(/['"]ok['"]:true/);
  });

  it('用 node JSON.stringify 安全 escape message body（避免 shell quote 問題）', () => {
    expect(SCRIPT).toMatch(/JSON\.stringify/);
  });
});

describe('telegram-smoke.yml — workflow contract', () => {
  it('on workflow_dispatch（manual trigger）', () => {
    expect(WORKFLOW).toMatch(/workflow_dispatch:/);
  });

  it('on schedule monthly cron', () => {
    expect(WORKFLOW).toMatch(/cron:.*1 \*/);
  });

  it('reference secrets.TELEGRAM_BOT_TOKEN / TELEGRAM_BOT_HOME_TOKEN / TELEGRAM_CHAT_ID', () => {
    expect(WORKFLOW).toMatch(/secrets\.TELEGRAM_BOT_TOKEN/);
    expect(WORKFLOW).toMatch(/secrets\.TELEGRAM_BOT_HOME_TOKEN/);
    expect(WORKFLOW).toMatch(/secrets\.TELEGRAM_CHAT_ID/);
  });

  it('runs bash scripts/telegram-smoke.sh', () => {
    expect(WORKFLOW).toMatch(/bash scripts\/telegram-smoke\.sh/);
  });
});
