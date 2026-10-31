/**
 * daily-check.js — requestErrors 對真實 SQL 的行為（in-memory SQLite）。
 *
 * 2026-10-28 / 10-29 連兩天把使用者在 UI 主動取消的請求（#285、#288，
 * terminal_reason=cancelled）報成 warning。但 #285 是 10/27 AI 真的沒回、使用者
 * 等了 18 分鐘才取消 —— 那是故障訊號，不能一起藏掉；#288 是 18 秒就取消。
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';

const require = createRequire(import.meta.url);

// [status, terminal_reason, 建立到最後更新經過幾分鐘]
type Row = [string, string | null, number?];

function runRequestErrors(rows: Row[]) {
  const db = new DatabaseSync(':memory:');
  db.exec(
    "CREATE TABLE trip_requests (id INTEGER PRIMARY KEY, trip_id TEXT NOT NULL, message TEXT NOT NULL, reply TEXT, status TEXT NOT NULL, terminal_reason TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT)",
  );
  const insert = db.prepare(
    "INSERT INTO trip_requests (trip_id, message, status, terminal_reason, created_at, updated_at) " +
    "VALUES ('t1', 'm', ?, ?, datetime('now', '-60 minutes'), datetime('now', '-60 minutes', '+' || ? || ' minutes'))",
  );
  for (const [status, reason, waited = 0] of rows) insert.run(status, reason, waited);
  const { createCheckSources } = require('../../scripts/daily-check.js');
  const sources = createCheckSources({ queryD1: async (sql: string) => db.prepare(sql).all(), env: {} });
  return sources.requestErrors.run();
}

describe('daily-check.js — queryRequestErrors', () => {
  it('使用者很快就取消的請求不算錯誤', async () => {
    const result = await runRequestErrors([['failed', 'cancelled', 1]]);
    expect(result).toMatchObject({ status: 'ok', total: 0 });
  });

  it('等滿 15 分鐘才取消照報（AI 沒回而放棄等待是故障訊號）', async () => {
    const result = await runRequestErrors([['failed', 'cancelled', 18]]);
    expect(result).toMatchObject({ status: 'warning', total: 1, statusCounts: { failed: 1 } });
  });

  it('只帶 terminalReason 的 PATCH 讓還在跑的請求掛上 cancelled，照報', async () => {
    const result = await runRequestErrors([['open', 'cancelled'], ['processing', 'cancelled']]);
    expect(result).toMatchObject({ status: 'warning', total: 2, statusCounts: { open: 1, processing: 1 } });
  });

  it('逾時、錯誤、需授權與還在跑的請求照報（terminal_reason 為 NULL 也照報）', async () => {
    const result = await runRequestErrors([
      ['failed', 'cancelled'],
      ['failed', 'timed_out'],
      ['failed', 'error'],
      ['failed', 'needs_consent'],
      ['failed', null],
      ['open', null],
      ['processing', null],
      ['completed', null],
    ]);
    expect(result).toMatchObject({ status: 'warning', total: 6, statusCounts: { open: 1, processing: 1, failed: 4 } });
  });
});
