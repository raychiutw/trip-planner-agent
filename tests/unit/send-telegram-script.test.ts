/**
 * scripts/lib/send-telegram.sh —— chat id 只從環境變數取，不內建任何預設值
 * （個人識別資訊不進 repo；沒設就明確失敗，而不是悄悄寄給預設的人）。
 * 以假的 curl 擋住網路：真的被呼叫到就代表腳本越過了 chat id 檢查。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCRIPT = path.resolve(__dirname, '../../scripts/lib/send-telegram.sh');
const VALID_TOKEN = '123456:ABCdef_ghi-JKL';

let fakeBin: string;
beforeAll(() => {
  fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-curl-'));
  fs.writeFileSync(path.join(fakeBin, 'curl'), '#!/bin/sh\necho "curl 不該被呼叫" >&2\nexit 99\n', { mode: 0o755 });
});
afterAll(() => fs.rmSync(fakeBin, { recursive: true, force: true }));

function run(env: Record<string, string>) {
  return spawnSync('zsh', [SCRIPT, 'hello'], {
    encoding: 'utf-8',
    env: { PATH: `${fakeBin}:${process.env.PATH}`, HOME: os.tmpdir(), ...env },
  });
}

describe('send-telegram.sh 的 chat id', () => {
  it('沒設 TELEGRAM_CHAT_ID → 退出碼 1，訊息指出缺 chat id，且不呼叫 curl', () => {
    const r = run({ TELEGRAM_BOT_TOKEN: VALID_TOKEN });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('TELEGRAM_CHAT_ID 未設定');
    expect(r.stderr).not.toContain('curl 不該被呼叫');
  });

  it('腳本內不內建任何 chat id（8 位以上的數字）', () => {
    expect(fs.readFileSync(SCRIPT, 'utf-8')).not.toMatch(/\d{8,}/);
  });

  it('有設 TELEGRAM_CHAT_ID → 才會走到 curl', () => {
    const r = run({ TELEGRAM_BOT_TOKEN: VALID_TOKEN, TELEGRAM_CHAT_ID: '12345' });
    expect(r.stderr).toContain('curl 不該被呼叫');
  });
});
