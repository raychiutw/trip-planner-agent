/**
 * load-env.mjs — scheduler 環境變數載入器
 *
 * 取代 scheduler-common.sh 原本 `while IFS= read -r line` 的土法 parser。
 * 該 parser 遇到單引號跨多行的值（例：multi-line JSON private_key）會把每行
 * 當獨立 KEY=VALUE，base64 切片的 `+ /` 觸發 zsh export 「not an identifier」
 * → `set -eo pipefail` 中止 scheduler-common.sh source → daily-check-scheduler.sh
 * 連 LOG_FILE 都還沒建就死掉，沒有 telegram 也沒有 log（觀察到 2026-05-11 06:13
 * 的 .context/daily-check-stderr.log 即此症狀）。
 *
 * 新 loader 用 dotenv.parse()（純函數、已支援 multi-line single-quote、不碰 stdout），輸出 bash
 * ANSI-C `$'...'` quoting 的 `export KEY=$'…'` lines；scheduler-common.sh 用
 * `eval "$(node load-env.mjs path)"` 就能正確 inject env。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const SCRIPT = path.resolve(__dirname, '../../scripts/lib/load-env.mjs');

type TestShell = {
  command: string;
  label: string;
};

function uniqueShells(candidates: TestShell[]): TestShell[] {
  const seen = new Set<string>();
  return candidates.filter(candidate => {
    const key = candidate.command.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function supportsLoaderEval(command: string): boolean {
  const probe = spawnSync(command, ['-c', `set -e\nexport FOO=$'bar'\ntest "$FOO" = bar\n`], { encoding: 'utf8' });
  return probe.status === 0;
}

// 偵測 shell — macOS production scheduler 優先 zsh；Windows 優先 Git Bash。
// Windows PATH 上的 bash 可能是 WSL launcher（C:\Windows\System32\bash.exe），
// 它可執行 `-c`，但從 Node spawnSync 傳入 ANSI-C `$'…'` export 時會讓值變空。
const SHELL: TestShell = (() => {
  const gitBashCandidates =
    process.platform === 'win32'
      ? [
          process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'Git/bin/bash.exe') : '',
          process.env['ProgramFiles(x86)'] ? path.join(process.env['ProgramFiles(x86)'], 'Git/bin/bash.exe') : '',
          process.env.LocalAppData ? path.join(process.env.LocalAppData, 'Programs/Git/bin/bash.exe') : '',
          'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
        ]
          .filter(Boolean)
          .map(command => ({ command, label: `Git Bash (${command})` }))
      : [];

  const candidates = uniqueShells([
    ...(process.platform === 'win32' ? gitBashCandidates : [{ command: 'zsh', label: 'zsh' }]),
    { command: 'bash', label: 'bash' },
  ]);
  const shell = candidates.find(candidate => supportsLoaderEval(candidate.command));
  if (!shell) {
    throw new Error('load-env.mjs tests require zsh or bash with ANSI-C export support');
  }
  return shell;
})();

function runLoader(envContent: string): { code: number; stdout: string; stderr: string } {
  const tmp = path.join(os.tmpdir(), `load-env-test-${Date.now()}-${Math.random().toString(36).slice(2)}.env`);
  fs.writeFileSync(tmp, envContent);
  try {
    const result = spawnSync('node', [SCRIPT, tmp], { encoding: 'utf8' });
    return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
  } finally {
    fs.unlinkSync(tmp);
  }
}

/** eval loader output in subshell, dump requested vars via base64 (preserves multi-line + ctrl chars) */
function evalAndDump(loaderOutput: string, varNames: string[]): Record<string, string> {
  // Linux base64 預設 wrap 76 chars，macOS 不 wrap — 加 `tr -d '\n'` 統一單行輸出
  // 否則 stdout split-by-newline 會把 base64 後半段當沒 `=` 的行 skip 掉
  const dumpCmd = varNames.map(n => `echo "${n}=$(printf %s "$${n}" | base64 | tr -d '\\n')"`).join('\n');
  const script = `set -e\n${loaderOutput}\n${dumpCmd}\n`;
  const result = spawnSync(SHELL.command, ['-c', script], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`${SHELL.label} eval failed (code=${result.status}): ${result.stderr}\n--- loader output ---\n${loaderOutput}`);
  }
  const out: Record<string, string> = {};
  for (const line of result.stdout.split('\n')) {
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq);
    const b64 = line.slice(eq + 1).replace(/\s+/g, ''); // base64 可能被 wrap
    out[key] = Buffer.from(b64, 'base64').toString('utf8');
  }
  return out;
}

describe('load-env.mjs — scheduler env loader', () => {
  beforeAll(() => {
    expect(fs.existsSync(SCRIPT), `${SCRIPT} 必須存在`).toBe(true);
  });

  it('簡單 KEY=VALUE 行能被 export', () => {
    const result = runLoader(`FOO=bar\nBAZ=qux\n`);
    expect(result.code).toBe(0);
    const env = evalAndDump(result.stdout, ['FOO', 'BAZ']);
    expect(env.FOO).toBe('bar');
    expect(env.BAZ).toBe('qux');
  });

  it('comment + 空行 被跳過', () => {
    const result = runLoader(`# comment line\n\nFOO=bar\n# 中文註解\nBAZ=qux\n`);
    expect(result.code).toBe(0);
    const env = evalAndDump(result.stdout, ['FOO', 'BAZ']);
    expect(env.FOO).toBe('bar');
    expect(env.BAZ).toBe('qux');
  });

  it('value 含 shell metachar (< > & |) 不被 shell 解釋', () => {
    // .env.local 真實案例：EMAIL_FROM=Tripline <owner@example.com>
    // 舊 parser source 會把 < > 當 redirect 操作，新 loader 必須 quote 掉
    const result = runLoader(`EMAIL_FROM=Tripline <lean@example.com>\nPIPE=a|b&c\n`);
    expect(result.code).toBe(0);
    const env = evalAndDump(result.stdout, ['EMAIL_FROM', 'PIPE']);
    expect(env.EMAIL_FROM).toBe('Tripline <lean@example.com>');
    expect(env.PIPE).toBe('a|b&c');
  });

  it('value 含 $(...)、反引號、引號、反斜線、分號：eval 後原樣還原且不執行（tripline-job.sh 會 eval 這份輸出）', () => {
    const canary = path.join(os.tmpdir(), `load-env-canary-${process.pid}-${Date.now()}`);
    const nasty = `a"b $(touch ${canary}) \`touch ${canary}\` \\ ; touch ${canary} #x`;
    const result = runLoader(`NASTY='${nasty}'\nSQ="it's ok"\nSAFE=ok\n`);
    expect(result.code).toBe(0);
    const env = evalAndDump(result.stdout, ['NASTY', 'SQ', 'SAFE']);
    expect(fs.existsSync(canary), 'eval 不可執行值裡的指令').toBe(false);
    expect(env.NASTY).toBe(nasty);
    expect(env.SQ).toBe("it's ok");
    expect(env.SAFE).toBe('ok');
  });

  it('multi-line single-quoted value 被完整 parse（regression: 2026-05-11 GOOGLE_CLOUD_SA_KEY 案）', () => {
    // 模擬 GOOGLE_CLOUD_SA_KEY 的 multi-line JSON 結構（單引號跨多行）
    // 假資料；標頭在執行時才組起來，原始碼裡不出現完整的 PEM 標頭（避免 secret scanning 誤報）
    const pem = (tag: string) => `-----${tag} ${'PRIVATE'} KEY-----`;
    const value = `{"type":"service_account","private_key":"${pem('BEGIN')}\nMIIEvQIBADANBgkqhkiG9w0BAQEFAA+/SCB\nKcwggSjAgEAAoIBAQDb1234567890+/\n${pem('END')}\n"}`;
    const result = runLoader(`SOMEKEY=plain\nGOOGLE_CLOUD_SA_KEY='${value}'\nAFTERKEY=trailing\n`);
    expect(result.code, `loader stderr: ${result.stderr}`).toBe(0);
    const env = evalAndDump(result.stdout, ['SOMEKEY', 'GOOGLE_CLOUD_SA_KEY', 'AFTERKEY']);
    expect(env.SOMEKEY).toBe('plain');
    expect(env.GOOGLE_CLOUD_SA_KEY).toBe(value);
    expect(env.AFTERKEY).toBe('trailing');
  });

  it('value 含單引號 被 ANSI-C quote 正確 escape', () => {
    // dotenv 不會給我們含 raw single quote 的值（因為單引號是分隔符），但雙引號值內可能含 single quote
    const result = runLoader(`MSG="it's a test"\n`);
    expect(result.code).toBe(0);
    const env = evalAndDump(result.stdout, ['MSG']);
    expect(env.MSG).toBe("it's a test");
  });

  it('value 含 backslash 與 newline escape sequence', () => {
    // dotenv double-quoted 會 interpret \n 為 literal newline
    const result = runLoader(`MULTI="line1\\nline2"\n`);
    expect(result.code).toBe(0);
    const env = evalAndDump(result.stdout, ['MULTI']);
    expect(env.MULTI).toBe('line1\nline2');
  });

  it('未提供 path → exit 1 + stderr 訊息', () => {
    const result = spawnSync('node', [SCRIPT], { encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/usage|path|argument/i);
  });

  it('path 不存在 → exit 1 + stderr 訊息', () => {
    const result = spawnSync('node', [SCRIPT, '/tmp/definitely-does-not-exist.env'], { encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/not found|ENOENT|不存在/i);
  });

  // Regression：非法 key 的 stderr warning 絕對不能被合進 stdout
  // 不然 scheduler-common.sh 若用 `2>&1` 捕獲會把 warning eval 成 shell → zsh 死。
  // 兩道防線都要保留：(1) loader 維持 stderr/stdout 分離 (2) scheduler-common.sh 不用 `2>&1`
  it('非法 key 走 stderr 不污染 stdout（regression: 2>&1 silent-death 同類）', () => {
    // dotenv 接受含「.」「-」的 key（dotenv 用 [\w.-]+），但 loader 的 VALID_KEY
    // regex 拒絕 → 寫 warning 到 stderr。stdout 必須只含合法 export。
    const result = runLoader(`OK_KEY=alpha\nBAD.KEY=should-skip\nHAS-DASH=also-skip\nAFTER=zulu\n`);
    expect(result.code, `unexpected exit code (stderr: ${result.stderr})`).toBe(0);
    expect(result.stdout).not.toMatch(/BAD\.KEY|HAS-DASH/);
    expect(result.stdout).toMatch(/export OK_KEY=/);
    expect(result.stdout).toMatch(/export AFTER=/);
    expect(result.stderr).toMatch(/BAD\.KEY|HAS-DASH/);

    // 確認單獨 eval stdout 在 production shell（zsh/bash）`set -e` 下不會炸
    const evalCheck = spawnSync(SHELL.command, ['-c', `set -eo pipefail\n${result.stdout}\necho OK_KEY=$OK_KEY\necho AFTER=$AFTER\n`], { encoding: 'utf8' });
    expect(evalCheck.status, `${SHELL.label} eval 失敗 stderr: ${evalCheck.stderr}`).toBe(0);
    expect(evalCheck.stdout).toContain('OK_KEY=alpha');
    expect(evalCheck.stdout).toContain('AFTER=zulu');
  });
});
