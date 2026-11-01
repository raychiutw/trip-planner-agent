/**
 * 排程（tripline-api-server.ts 的 scheduleDailyScript）要執行的東西必須真的存在。
 *
 * 起因：2026-11-01 發現每天 04:30 的 google-poi-refresh 一直失敗（`Script not found "refresh:google"`）——
 * agent 從 web repo 抽出時，排程還在，但 package.json 的 scripts 沒帶過來。排程失敗只留在 stderr，沒人看。
 * 這個測試把「排程指向的腳本」與「實際存在的腳本」對起來，之後再漏帶會在 CI 就失敗。
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../..');
const server = readFileSync(join(ROOT, 'scripts/tripline-api-server.ts'), 'utf8');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };

interface Scheduled { cmd: string; args: string[]; label: string }
/** 取出所有 scheduleDailyScript(h, m, CMD, [args...], 'label') 呼叫。 */
function scheduled(): Scheduled[] {
  const out: Scheduled[] = [];
  const re = /scheduleDailyScript\(\s*\d+\s*,\s*\d+\s*,\s*([A-Za-z_']+[A-Za-z_']*)\s*,\s*\[([^\]]*)\]\s*,\s*'([^']+)'\s*\)/g;
  for (const m of server.matchAll(re)) {
    out.push({ cmd: m[1]!, args: [...m[2]!.matchAll(/'([^']*)'/g)].map((a) => a[1]!), label: m[3]! });
  }
  return out;
}

describe('排程指向的腳本都存在', () => {
  const items = scheduled();

  it('抓得到排程（避免解析失敗而假綠）', () => {
    expect(items.length).toBeGreaterThanOrEqual(3);
    expect(items.map((i) => i.label)).toEqual(expect.arrayContaining(['auth-cleanup', 'google-poi-refresh', 'log-rotate']));
  });

  for (const item of items) {
    it(`${item.label}：${item.cmd} ${item.args.join(' ')}`, () => {
      if (item.args[0] === 'run') {
        const name = item.args[1]!;
        expect(pkg.scripts?.[name], `package.json 缺少 scripts["${name}"]`).toBeTruthy();
        // 腳本指向的檔案也要存在（bun scripts/xxx.ts）
        const file = pkg.scripts![name]!.split(/\s+/).find((t) => /^scripts\/.+\.(ts|js|sh)$/.test(t));
        expect(file, `scripts["${name}"] 沒有指向 scripts/ 底下的檔案`).toBeTruthy();
        expect(existsSync(join(ROOT, file!)), `${file} 不存在`).toBe(true);
      } else {
        expect(existsSync(join(ROOT, item.args[0]!)), `${item.args[0]} 不存在`).toBe(true);
      }
    });
  }
});
