// 守門：skill 與 README 內寫的 /api/... 路徑必須存在於新 api 的 openapi 路徑快照。
// 快照更新方式（新 api 加／刪端點後）：
//   curl -s https://trip-planner-api-production.lean-lean.workers.dev/openapi.json \
//     | python3 -c "import json,sys;json.dump(sorted(json.load(sys.stdin)['paths']),open('tests/fixtures/api-paths.json','w'),indent=1)"
// 例外：整行含「已移除／已刪除／已退役／❌／不在」的歷史說明（告訴 agent 這個端點不能用）不檢查。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..', '..');
const norm = (p: string) => p.replace(/\{[^}]*\}|\$\{[^}]*\}|\$[A-Za-z_]+|:[A-Za-z_]+|\[[^\]]*\]/g, '{}');
const known = new Set(
  (JSON.parse(readFileSync(join(root, 'tests/fixtures/api-paths.json'), 'utf8')) as string[]).map(norm),
);
const HISTORY = /已移除|已刪除|已退役|❌|不在/;

function mdFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const f = join(dir, n);
    return statSync(f).isDirectory() ? mdFiles(f) : f.endsWith('.md') ? [f] : [];
  });
}

describe('skills / README 的 /api 路徑', () => {
  it('都存在於 openapi 快照', () => {
    const bad: string[] = [];
    for (const f of [...mdFiles(join(root, '.claude/skills')), join(root, 'README.md')]) {
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        if (HISTORY.test(line)) return;
        for (const m of line.match(/\/api\/[A-Za-z0-9_\-./{}$:[\]]*/g) ?? []) {
          const p = norm(m.replace(/[`.*\]]+$/, '').replace(/\/$/, ''));
          if (p !== '/api' && p !== '/api/{}' && !known.has(p)) bad.push(`${f.slice(root.length + 1)}:${i + 1} ${m}`);
        }
      });
    }
    expect(bad).toEqual([]);
  });
});
