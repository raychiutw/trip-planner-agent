/**
 * 契約快照守門：重新產生 contract/api-contract.json，必須與已 commit 的一致。
 * daily-check 的 SQL 或 MCP companion 工具一改，這裡就紅——提醒你跑 `npm run export:contract`
 * 並把新快照同步到 api repo（tests/fixtures/agent-contract.json），否則 api 端的契約測試驗的是舊資料。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildApiContract, serializeContract, CONTRACT_PATH } from '../../scripts/export-api-contract';

describe('agent ↔ api 契約快照', () => {
  it('已 commit 的 contract/api-contract.json 與現行程式產生的一致', async () => {
    const committed = readFileSync(CONTRACT_PATH, 'utf8');
    const fresh = serializeContract(await buildApiContract());
    expect(fresh, '契約已過期：請執行 npm run export:contract，並把快照同步到 api repo').toBe(committed);
  });

  it('快照涵蓋預期的 D1 來源與 companion 工具（不是空殼）', async () => {
    const c = await buildApiContract();
    expect(c.dailyCheckSql.map((s) => s.source)).toEqual(
      expect.arrayContaining(['apiErrors', 'requestErrors', 'auditAnomaly', 'dataHygiene']));
    expect(c.dailyCheckSql.every((s) => s.sql.length > 0)).toBe(true);
    expect(c.companionTools.length).toBeGreaterThanOrEqual(10);
    expect(c.companionTools.every((t) => t.method && t.path.startsWith('/api/'))).toBe(true);
  });
});
