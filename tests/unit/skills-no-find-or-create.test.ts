// 守門：/tp-request 是 mint-restricted 受限 session，MCP 只有 security.md ✅ 白名單的工具。
// `POST /api/pois/find-or-create` 不在白名單、也沒有對應工具；掛／換 POI 一律走
// addAlternate／setEntryPoi（server 端自己 find-or-create master）。
// 例外：整行含「已移除／已刪除／已退役／❌／不在／不可」的說明（告訴 agent 這個端點不能用）不檢查。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..', '..');
const HISTORY = /已移除|已刪除|已退役|❌|不在|不可/;

function mdFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const f = join(dir, n);
    return statSync(f).isDirectory() ? mdFiles(f) : f.endsWith('.md') ? [f] : [];
  });
}

describe('skills 不得指示呼叫 /api/pois/find-or-create', () => {
  it('沒有任何未標註為禁用的參照', () => {
    const bad: string[] = [];
    for (const f of mdFiles(join(root, '.claude/skills'))) {
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        if (!HISTORY.test(line) && line.includes('/api/pois/find-or-create')) bad.push(`${f.slice(root.length + 1)}:${i + 1}`);
      });
    }
    expect(bad).toEqual([]);
  });

  it('tp-request 不再保留「加入收藏 fast-path」流程（受限 token 打 poi-favorites 會 403）', () => {
    const s = readFileSync(join(root, '.claude/skills/tp-request/SKILL.md'), 'utf8');
    expect(s).not.toMatch(/3d-bis/);
    expect(s).not.toMatch(/POST \/api\/poi-favorites/);
    // 3d-trib 是同一條舊收藏路徑的 401 排錯清單（wrangler pages secret、companionRequestId…），一併退役
    expect(s).not.toMatch(/3d-trib/);
    expect(s).not.toMatch(/\/api\/poi-favorites/);
    // 白名單摘要也不得再列收藏端點（不帶 /api 前綴的寫法）
    expect(s).not.toMatch(/poi-favorites/);
  });
});
