import { describe, it, expect } from 'vitest';
import { todayISO } from '../../scripts/lib/local-date.js';

describe('todayISO', () => {
  // new Date(y, m, d, h, m) 以本地時區解讀，getFullYear/Month/Date 也回本地值，
  // 所以下列測試在任何 system timezone 下都穩定（不依 TZ=Asia/Taipei 或 UTC）。

  it('Date 物件的本地 YYYY-MM-DD（month 0-indexed）', () => {
    const d = new Date(2026, 3, 15, 14, 30); // April 15, 14:30 local
    expect(todayISO(d)).toBe('2026-04-15');
  });

  it('單位數月日補 0', () => {
    const d = new Date(2026, 0, 5, 12, 0); // Jan 5
    expect(todayISO(d)).toBe('2026-01-05');
  });

  it('regression for PR #171：凌晨本地時間仍屬「今天」', () => {
    // 原 bug：daily-check 用 toISOString().split('T')[0]（UTC date），在 CST 06:13
    // 會變 UTC 22:13 前一天，導致 daily-check 檔名被標成昨天。
    // 正確行為：todayISO 取本地 TZ date，不受 UTC 偏移影響。
    const d = new Date(2026, 3, 12, 6, 13); // April 12, 06:13 local
    expect(todayISO(d)).toBe('2026-04-12');

    // 反面保險：確保實作不是 UTC。若 system TZ ≠ UTC，d.toISOString 會跨日。
    const utcDate = d.toISOString().split('T')[0];
    if (utcDate !== '2026-04-12') {
      // 本 CI runner 的 TZ 讓 06:13 local 跨到前一天 UTC；todayISO 必須仍回 local
      expect(todayISO(d)).not.toBe(utcDate);
    }
  });

  it('月初邊界：本地 1 日零時', () => {
    const d = new Date(2026, 4, 1, 0, 0); // May 1 midnight local
    expect(todayISO(d)).toBe('2026-05-01');
  });

  it('年尾：12 月 31 日', () => {
    const d = new Date(2026, 11, 31, 23, 59);
    expect(todayISO(d)).toBe('2026-12-31');
  });

  it('無參數時用當下 (smoke)', () => {
    const out = todayISO();
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
