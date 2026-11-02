import { describe, expect, it } from 'vitest';
import { RUN_DIR_RE, sweepStalePrintRuns } from '../../scripts/lib/print-run-sweep';

function host(entries: string[], removeOk: (name: string) => boolean = () => true) {
  const calls: string[] = [];
  const errors: string[] = [];
  const deps = {
    listEntries: () => entries,
    killRun: (name: string) => { calls.push(`kill:${name}`); },
    removeDir: (name: string) => { calls.push(`rm:${name}`); return removeOk(name); },
    log: () => {},
    logError: (m: string) => { errors.push(m); },
  };
  return { deps, calls, errors };
}

describe('啟動清掃（上一代 api-server 殘留的 contained run）', () => {
  it('print 路徑（-r<輪>）與舊 REPL 路徑（無 -r）的目錄都清；先殺 process 再刪目錄', () => {
    const h = host(['tripline-tp-request-1793-77-r2', 'tripline-tp-request-1793-77']);
    expect(sweepStalePrintRuns(h.deps)).toBe(2);
    expect(h.calls).toEqual([
      'kill:tripline-tp-request-1793-77-r2', 'rm:tripline-tp-request-1793-77-r2',
      'kill:tripline-tp-request-1793-77', 'rm:tripline-tp-request-1793-77',
    ]);
  });

  it('不是 run 目錄格式的東西一律不碰（含路徑穿越形狀、其他 skill、被人放進去的檔案）', () => {
    const h = host(['.', '..', 'notes.txt', 'tripline-tp-daily-check-1-2', '../etc', 'tripline-tp-request-1-2-rX', 'tripline-tp-request-1-2-r1/../x']);
    expect(sweepStalePrintRuns(h.deps)).toBe(0);
    expect(h.calls).toEqual([]);
  });

  it('刪除失敗要記 log、不計入清掉的數量，也不影響後面的目錄', () => {
    const h = host(['tripline-tp-request-1-1-r1', 'tripline-tp-request-2-2-r1'], (n) => n.includes('-1-1-'));
    expect(sweepStalePrintRuns(h.deps)).toBe(1);
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]).toContain('tripline-tp-request-2-2-r1');
  });

  it('目錄名格式與 worker 產生的 run 名一致（prefix + now + pid + -r<輪>）', () => {
    expect(RUN_DIR_RE.test('tripline-tp-request-1700000000000-4242-r1')).toBe(true);
    expect(RUN_DIR_RE.test('tripline-tp-request-1700000000000-4242')).toBe(true);
  });
});
