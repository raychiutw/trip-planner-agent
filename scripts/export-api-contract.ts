/**
 * 產生「agent ↔ api」契約快照 contract/api-contract.json。
 *
 * 為什麼存在：agent 與 api 是兩個 repo，單一 repo 的 CI 看不到對方（agent issue #5）。
 * agent 擁有「怎麼產生快照」（本檔），api repo 擁有「驗證快照」（tests/agent-contract/）。
 *
 * 內容：
 *   dailyCheckSql   — daily-check 各來源實際送給 D1 的 SQL（用記錄器攔截 queryD1，不連線）
 *   companionTools  — MCP server 中標為 companion: true 的工具 { name, method, path }
 *   limits          — worker 最長執行時間（分鐘）；api 端驗證它 < REQUEST_STALE_MINUTES
 *
 * 更新：`npm run export:contract`，再把 contract/api-contract.json 複製到 api repo 的
 * tests/fixtures/agent-contract.json。agent 端的 tests/unit/api-contract-export.test.ts
 * 會比對已 commit 的快照，漏更新就紅。
 *
 * 跑法：bun scripts/export-api-contract.ts（也可被 vitest 直接 import buildApiContract）。
 */
import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ORPHAN_MAX_AGE_MS } from './lib/request-worker';

const require_ = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

export const CONTRACT_PATH = resolve(here, '../contract/api-contract.json');

export interface DailyCheckSqlEntry {
  source: string;
  /** 依送出順序；同一來源可能有多條 */
  sql: string[];
  /** 做不到完整記錄時的說明（例如 SQL 依賴前一個查詢的結果） */
  skipped?: string;
}
export interface CompanionToolEntry { name: string; method: string; path: string }
export interface ApiContract {
  version: 1;
  note: string;
  dailyCheckSql: DailyCheckSqlEntry[];
  companionTools: CompanionToolEntry[];
  limits: { requestWorkerMaxMinutes: number };
}

/** 逐一執行各來源的 run()，記錄實際送出的 SQL。其他 IO（網路、檔案、子程序）一律擋下。 */
export async function collectDailyCheckSql(): Promise<DailyCheckSqlEntry[]> {
  const { createCheckSources } = require_('./daily-check.js');
  const out: DailyCheckSqlEntry[] = [];
  let current: string[] = [];
  const queryD1 = async (sql: string) => { current.push(sql); return []; };
  const blocked = () => { throw new Error('export-api-contract: IO 被擋下'); };
  const sources = createCheckSources({
    queryD1,
    env: {},
    fetch: async () => blocked(),
    execSync: blocked,
    fs: new Proxy({}, { get: () => blocked }),
    getToken: async () => null,
    now: () => new Date('2026-01-01T00:00:00Z'),
  });
  for (const name of Object.keys(sources).sort()) {
    current = [];
    let threw: string | null = null;
    try { await sources[name].run(); } catch (e) { threw = (e as Error).message; }
    if (current.length === 0) continue; // 不碰 D1 的來源不屬於契約
    const entry: DailyCheckSqlEntry = { source: name, sql: current };
    // 記錄器回 []：若來源在送出 SQL 後因空結果而拋錯，後續依賴結果的 SQL 就沒送出
    if (threw) entry.skipped = `run() 在空結果下拋錯（${threw}）；其後依賴查詢結果的 SQL 未能記錄`;
    out.push(entry);
  }
  return out;
}

export function collectCompanionTools(): CompanionToolEntry[] {
  const { TOOLS } = require_('./tp-request-mcp-server.js');
  return TOOLS
    .filter((t: { companion?: boolean }) => t.companion === true)
    .map((t: { name: string; method: string; path: string }) => ({ name: t.name, method: t.method, path: t.path }))
    .sort((a: CompanionToolEntry, b: CompanionToolEntry) => a.name.localeCompare(b.name));
}

export async function buildApiContract(): Promise<ApiContract> {
  return {
    version: 1,
    note: '由 scripts/export-api-contract.ts 產生，請勿手改；更新方式見該檔檔頭。',
    dailyCheckSql: await collectDailyCheckSql(),
    companionTools: collectCompanionTools(),
    limits: { requestWorkerMaxMinutes: ORPHAN_MAX_AGE_MS / 60_000 },
  };
}

export function serializeContract(c: ApiContract): string {
  return JSON.stringify(c, null, 2) + '\n';
}

// bun 專用的 CLI 入口（vitest／node import 時 import.meta.main 為 undefined）
if ((import.meta as unknown as { main?: boolean }).main) {
  buildApiContract().then((c) => {
    mkdirSync(dirname(CONTRACT_PATH), { recursive: true });
    writeFileSync(CONTRACT_PATH, serializeContract(c));
    console.log(`已寫入 ${CONTRACT_PATH}（SQL 來源 ${c.dailyCheckSql.length}、companion 工具 ${c.companionTools.length}）`);
  });
}
