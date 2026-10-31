/**
 * throttled-alert helper unit tests — v2.33.124 PR1
 *
 * Cover: shouldSendAlert state-transition rules（funnel-guard pattern 抽通用）+
 * source-grep 確認 funnel-guard guard.sh 已遷移到共用 helper（不再內含 should_alert 死碼）。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { shouldSendAlert } from '../../scripts/_lib/cron-shared';

describe('shouldSendAlert — state-transition + throttle rules', () => {
  const now = 10_000;
  const ttl = 3600;

  it('recovery（unhealthy → healthy）永遠 alert', () => {
    expect(shouldSendAlert('heal_failed', 'healthy', now - 60, now, ttl)).toBe(true);
    expect(shouldSendAlert('healed', 'healthy', now - 60, now, ttl)).toBe(true);
    expect(shouldSendAlert('drift', 'healthy', now - 60, now, ttl)).toBe(true);
  });

  it('healthy steady-state（healthy → healthy）silent', () => {
    expect(shouldSendAlert('healthy', 'healthy', now - 60, now, ttl)).toBe(false);
    expect(shouldSendAlert('healthy', 'healthy', 0, now, ttl)).toBe(false);
  });

  it('unknown → healthy silent（first run 不報 recovery 假信號）', () => {
    expect(shouldSendAlert('unknown', 'healthy', 0, now, ttl)).toBe(false);
  });

  it('state change（不論方向）alert', () => {
    expect(shouldSendAlert('healthy', 'heal_failed', now - 60, now, ttl)).toBe(true);
    expect(shouldSendAlert('healed', 'heal_failed', now - 60, now, ttl)).toBe(true);
    expect(shouldSendAlert('unknown', 'heal_failed', 0, now, ttl)).toBe(true);
  });

  it('same unhealthy state — throttle window 內 silent', () => {
    expect(shouldSendAlert('heal_failed', 'heal_failed', now - 1, now, ttl)).toBe(false);
    expect(shouldSendAlert('heal_failed', 'heal_failed', now - 3599, now, ttl)).toBe(false);
  });

  it('same unhealthy state — throttle window 過了 alert', () => {
    expect(shouldSendAlert('heal_failed', 'heal_failed', now - 3600, now, ttl)).toBe(true);
    expect(shouldSendAlert('heal_failed', 'heal_failed', now - 7200, now, ttl)).toBe(true);
  });

  it('custom ttl 生效', () => {
    expect(shouldSendAlert('drift', 'drift', now - 30, now, 60)).toBe(false);
    expect(shouldSendAlert('drift', 'drift', now - 60, now, 60)).toBe(true);
  });
});

describe('funnel-guard 已遷移到共用 helper', () => {
  const GUARD = readFileSync(
    join(__dirname, '../../scripts/funnel-guard/guard.sh'),
    'utf8',
  );

  it('guard.sh source 共用 throttled-alert.sh', () => {
    expect(GUARD).toMatch(/source\s+["']?\$REPO_ROOT\/scripts\/lib\/throttled-alert\.sh/);
  });

  it('guard.sh 不再內含 should_alert / maybe_alert 死碼', () => {
    expect(GUARD).not.toMatch(/^should_alert\(\)/m);
    expect(GUARD).not.toMatch(/^maybe_alert\(\)/m);
    expect(GUARD).not.toMatch(/^read_state\(\)/m);
    expect(GUARD).not.toMatch(/^write_state\(\)/m);
  });

  it('guard.sh 改用 throttled_alert 取代 maybe_alert', () => {
    expect(GUARD).toMatch(/throttled_alert\s+"funnel-guard"\s+"healthy"/);
    expect(GUARD).toMatch(/throttled_alert\s+"funnel-guard"\s+"healed"/);
    expect(GUARD).toMatch(/throttled_alert\s+"funnel-guard"\s+"heal_failed"/);
  });

  it('kill-switch 仍保留', () => {
    expect(GUARD).toMatch(/kill-switch.*\.disabled/);
  });
});

describe('throttled-alert.sh helper guard 條件', () => {
  const HELPER = readFileSync(
    join(__dirname, '../../scripts/lib/throttled-alert.sh'),
    'utf8',
  );

  it('v2.33.133 regression: sourced-vs-exec guard 已拔（zsh launchd FUNCTION_ARGZERO 誤判 → exit 2 funnel-guard 2hr orphan）', () => {
    expect(HELPER).not.toMatch(/source this file, do not execute directly/);
    expect(HELPER).not.toMatch(/exit 2$/m);
  });

  it('key 內非 [A-Za-z0-9_-] 字元被替換（防 path traversal）', () => {
    expect(HELPER).toMatch(/tr -c 'A-Za-z0-9_-'/);
  });

  it('default throttle ttl 3600s', () => {
    expect(HELPER).toMatch(/THROTTLED_ALERT_DEFAULT_TTL:=3600/);
  });

  it('state file 寫前先檢查 send-telegram.sh exit code（失敗不更新 timestamp）', () => {
    expect(HELPER).toMatch(/if \[ \$rc -eq 0 \]; then\s+printf '%s\|%s\\n'/);
  });
});
