/**
 * agent 入口的來源 IP 限制：只放行本機與 Cloudflare（issue #12）
 *
 * seam：createAgentHandler 回傳的 fetch handler。對端 IP 由 Bun.serve 注入（第二個參數），
 * 這裡直接傳字串。Funnel 流量的 TCP 對端永遠是 127.0.0.1（經 Caddy），真實來源在 X-Forwarded-For。
 * 判定一律走 /health：它在認證之前，能乾淨地分出「被 IP 閘擋下」與「放行」。
 */
import { describe, it, expect } from 'vitest';
import { createAgentHandler } from '../../scripts/lib/agent-http';

function setup(opts: { restrict?: boolean } = {}) {
  const errors: string[] = [];
  const handler = createAgentHandler({
    legacySecret: '',
    signing: { keys: { trigger: [], mail: [], mint: [] } },
    routes: [],
    health: () => ({ ok: true }),
    logError: (m) => errors.push(m),
    restrictToLocalAndCloudflare: opts.restrict ?? true,
  });
  const call = (peer: string | undefined, headers: Record<string, string> = {}, path = '/health') =>
    handler(new Request(`http://agent.local${path}`, { headers }), peer);
  return { call, errors };
}

describe('對端是 loopback、沒有 X-Forwarded-For（本機直連）', () => {
  it('放行', async () => {
    const { call } = setup();
    expect((await call('127.0.0.1')).status).toBe(200);
  });
});

describe('對端不是 loopback', () => {
  it('區網位址直連 → 403', async () => {
    const { call } = setup();
    expect((await call('192.168.1.50')).status).toBe(403);
  });
});

describe('對端是 loopback、帶 X-Forwarded-For（Funnel 經 Caddy 進來）', () => {
  const xff = (ip: string) => ({ 'x-forwarded-for': ip, 'tailscale-funnel-request': '?1' });

  it('Cloudflare IPv4 網段 → 放行', async () => {
    const { call } = setup();
    expect((await call('127.0.0.1', xff('104.16.5.9'))).status).toBe(200);
  });

  it('非 Cloudflare 的公網 IP → 403', async () => {
    const { call } = setup();
    expect((await call('127.0.0.1', xff('8.8.8.8'))).status).toBe(403);
  });

  it('tailnet 位址 → 403（只限本機與 Cloudflare）', async () => {
    const { call } = setup();
    expect((await call('127.0.0.1', xff('100.101.102.103'))).status).toBe(403);
  });
});

describe('IPv6 與 loopback 的各種寫法', () => {
  const xff = (ip: string) => ({ 'x-forwarded-for': ip });

  it('Cloudflare IPv6 網段 → 放行；其他 IPv6 → 403', async () => {
    const { call } = setup();
    expect((await call('127.0.0.1', xff('2606:4700::1'))).status).toBe(200);
    expect((await call('127.0.0.1', xff('2001:db8::1'))).status).toBe(403);
  });

  it('對端寫成 ::1 或 IPv4-mapped 的 loopback → 放行', async () => {
    const { call } = setup();
    expect((await call('::1')).status).toBe(200);
    expect((await call('::ffff:127.0.0.1')).status).toBe(200);
  });

  it('X-Forwarded-For 自己就是 loopback（本機 curl 經 Caddy）→ 放行', async () => {
    const { call } = setup();
    expect((await call('127.0.0.1', xff('127.0.0.1'))).status).toBe(200);
  });
});

describe('X-Forwarded-For 只在對端是 loopback 時才信', () => {
  it('非 loopback 對端偽造 XFF 成 127.0.0.1 或 Cloudflare IP → 403', async () => {
    const { call } = setup();
    expect((await call('192.168.1.50', { 'x-forwarded-for': '127.0.0.1' })).status).toBe(403);
    expect((await call('203.0.113.7', { 'x-forwarded-for': '104.16.5.9' })).status).toBe(403);
  });

  it('對端未知（Bun 沒給）→ 403，不因判不出來而放行', async () => {
    const { call } = setup();
    expect((await call(undefined)).status).toBe(403);
  });
});

describe('Cloudflare 網段邊界', () => {
  const xff = (ip: string) => ({ 'x-forwarded-for': ip });
  it.each([
    ['103.21.244.0', 200],      // 103.21.244.0/22 起點
    ['103.21.247.255', 200],    // 終點
    ['103.21.243.255', 403],    // 起點前一個
    ['103.21.248.0', 403],      // 終點後一個
    ['104.23.255.255', 200],    // 104.16.0.0/13 終點
    ['104.28.0.0', 403],        // 104.24.0.0/14 之後
  ])('%s → %i', async (ip, status) => {
    const { call } = setup();
    expect((await call('127.0.0.1', xff(ip))).status).toBe(status);
  });
});

describe('格式異常與多跳點', () => {
  const xff = (v: string) => ({ 'x-forwarded-for': v });

  it.each(['', 'abc', '104.16.5.9:443', '999.1.1.1', '104.16.5.9;8.8.8.8'])('XFF=%j → 403', async (v) => {
    const { call } = setup();
    expect((await call('127.0.0.1', xff(v))).status).toBe(403);
  });

  it('格式異常在 log 裡有獨立的原因碼（事後分辨掃描還是設定出錯）', async () => {
    const { call, errors } = setup();
    await call('127.0.0.1', xff('abc'));
    await call('127.0.0.1', xff('8.8.8.8'));
    expect(errors[0]).toContain('xff-malformed');
    expect(errors[1]).toContain('not-local-or-cloudflare');
  });

  it('Caddy 追加自己的 loopback 跳點 → 放行', async () => {
    const { call } = setup();
    expect((await call('127.0.0.1', xff('104.16.5.9, 127.0.0.1'))).status).toBe(200);
  });

  it('後面夾帶非 loopback 跳點 → 403；第一段非 Cloudflare 也 403', async () => {
    const { call } = setup();
    expect((await call('127.0.0.1', xff('104.16.5.9, 8.8.8.8'))).status).toBe(403);
    expect((await call('127.0.0.1', xff('8.8.8.8, 104.16.5.9'))).status).toBe(403);
  });
});

describe('回復開關', () => {
  it('不啟用限制時，任何來源（含未知對端）都放行', async () => {
    const { call } = setup({ restrict: false });
    expect((await call(undefined)).status).toBe(200);
    expect((await call('8.8.8.8')).status).toBe(200);
  });
});

describe('拒絕的回應與紀錄', () => {
  it('在路由與 OPTIONS 之前就擋；body 不洩漏白名單', async () => {
    const { call } = setup();
    const r = await call('192.168.1.50', {}, '/trigger');
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: 'forbidden' });
    const handler = createAgentHandler({
      legacySecret: '', signing: { keys: { trigger: [], mail: [], mint: [] } },
      routes: [], health: () => ({}), restrictToLocalAndCloudflare: true,
    });
    const opt = await handler(new Request('http://agent.local/trigger', { method: 'OPTIONS' }), '192.168.1.50');
    expect(opt.status).toBe(403);
  });

  it('log 記來源 IP、原因與路徑；同一來源 1 分鐘內只記一行，不同來源各記一行', async () => {
    const { call, errors } = setup();
    await call('192.168.1.50', {}, '/trigger');
    await call('192.168.1.50', {}, '/trigger');
    await call('192.168.1.51', {}, '/health');
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain('192.168.1.50');
    expect(errors[0]).toContain('peer-not-loopback');
    expect(errors[0]).toContain('/trigger');
  });
});

describe('帶 Tailscale-Funnel-Request 的請求一定來自公網（Caddy 漏設 trusted_proxies 時要擋，不是放行）', () => {
  const funnel = { 'tailscale-funnel-request': '?1' };

  it('XFF 被 Caddy 改寫成 127.0.0.1 → 403（不能把公網流量當本機）', async () => {
    const { call, errors } = setup();
    expect((await call('127.0.0.1', { ...funnel, 'x-forwarded-for': '127.0.0.1' })).status).toBe(403);
    expect(errors[0]).toContain('funnel-not-cloudflare');
  });

  it('XFF 整個不見 → 403', async () => {
    const { call } = setup();
    expect((await call('127.0.0.1', funnel)).status).toBe(403);
  });

  it('XFF 是 Cloudflare（含 Caddy 追加的 loopback 跳點）→ 放行', async () => {
    const { call } = setup();
    expect((await call('127.0.0.1', { ...funnel, 'x-forwarded-for': '104.16.5.9, 127.0.0.1' })).status).toBe(200);
  });
});
