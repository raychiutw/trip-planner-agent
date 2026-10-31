/**
 * api → agent HMAC 簽章驗證（T17）—— 只走 agent 的 HTTP 邊界：
 * 對 createAgentHandler 回傳的 fetch handler 發 Request、看 Response 與 log。
 *
 * 簽章端在測試裡用 node:crypto 獨立實作一份（不 import 被測的驗證器），
 * 並用與 api repo 相同的固定向量對拍，確保兩個 repo 的 canonical string 一致。
 */
import { describe, it, expect, vi } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import { createAgentHandler } from '../../scripts/lib/agent-http';

const K_TRIGGER = 'trigger-key-aaaaaaaaaaaaaaaaaaaa';
const K_TRIGGER_OLD = 'trigger-key-OLD-aaaaaaaaaaaaaaaa';
const K_MAIL = 'mail-key-bbbbbbbbbbbbbbbbbbbbbbbb';
const K_MINT = 'mint-key-cccccccccccccccccccccccc';
const LEGACY = 'legacy-secret-dddddddddddddddddd';
const T0 = 1_800_000_000; // 秒

type Purpose = 'trigger' | 'mail' | 'mint';

function sign(o: {
  purpose: Purpose; key: string; method?: string; pathAndQuery: string; body?: string; ts?: number; nonce?: string;
}) {
  const ts = o.ts ?? T0;
  const nonce = o.nonce ?? `n-${Math.random().toString(36).slice(2)}`;
  const canonical = [
    'TRIPLINE-HMAC-V1', o.purpose, (o.method ?? 'POST').toUpperCase(), o.pathAndQuery, String(ts), nonce,
    createHash('sha256').update(o.body ?? '').digest('hex'),
  ].join('\n');
  return {
    'X-Tripline-Timestamp': String(ts),
    'X-Tripline-Nonce': nonce,
    'X-Tripline-Signature': createHmac('sha256', o.key).update(canonical).digest('hex'),
  };
}

function setup(opts: {
  keys?: Partial<Record<Purpose, string[]>>; windowSec?: number; legacySecret?: string; nowSec?: number;
} = {}) {
  const calls = { trigger: 0, mail: 0, mint: 0, mailBodies: [] as string[] };
  const logs: string[] = [];
  const handler = createAgentHandler({
    legacySecret: opts.legacySecret ?? LEGACY,
    signing: {
      keys: { trigger: [K_TRIGGER], mail: [K_MAIL], mint: [K_MINT], ...opts.keys },
      windowSec: opts.windowSec,
      now: () => (opts.nowSec ?? T0) * 1000,
    },
    health: () => ({ ok: true }),
    routes: [
      { method: 'POST', path: '/trigger', purpose: 'trigger', allowLegacy: true,
        handle: async () => { calls.trigger++; return Response.json({ triggered: true }); } },
      { method: 'POST', path: '/internal/mail/send', purpose: 'mail', allowLegacy: true,
        handle: async (req) => { calls.mail++; calls.mailBodies.push(await req.text()); return Response.json({ ok: true }); } },
      { method: 'GET', path: '/internal/ping', purpose: 'trigger', allowLegacy: false,
        handle: async () => Response.json({ pong: true }) },
      { method: 'POST', path: '/internal/mint-token', purpose: 'mint', allowLegacy: false,
        handle: async () => { calls.mint++; return Response.json({ minted: true }); } },
    ],
    log: (m) => logs.push(m),
    logError: (m) => logs.push(m),
  });
  const post = (pathAndQuery: string, headers: Record<string, string>, body = '') =>
    handler(new Request(`http://agent.local${pathAndQuery}`, { method: 'POST', headers, body: body || undefined }));
  return { post, calls, logs, handler };
}

describe('簽章通過', () => {
  it('固定向量（與 api repo 同一組）→ 200', async () => {
    const { post, calls } = setup({ keys: { trigger: ['test-key-trigger-0000000000000000'] } });
    const r = await post('/trigger?source=api', {
      'X-Tripline-Timestamp': '1800000000',
      'X-Tripline-Nonce': 'nonce-fixed-0001',
      'X-Tripline-Signature': '7af5b15fb877370c805223a35dc4d3dbb838248f2c3b8c7ba3b0ed4af169e960',
    }, '{"hello":"world"}');
    expect(r.status).toBe(200);
    expect(calls.trigger).toBe(1);
  });

  it('trigger / mail / mint 各用自己的 key → 200，且 mail 的 body 完整傳到 handler', async () => {
    const { post, calls } = setup();
    expect((await post('/trigger', sign({ purpose: 'trigger', key: K_TRIGGER, pathAndQuery: '/trigger' }))).status).toBe(200);
    const body = JSON.stringify({ to: 'a@example.test', subject: 's', html: '<p>x</p>' });
    expect((await post('/internal/mail/send', sign({ purpose: 'mail', key: K_MAIL, pathAndQuery: '/internal/mail/send', body }), body)).status).toBe(200);
    expect(calls.mailBodies).toEqual([body]);
    expect((await post('/internal/mint-token', sign({ purpose: 'mint', key: K_MINT, pathAndQuery: '/internal/mint-token' }))).status).toBe(200);
  });

  it('/health 不需簽章', async () => {
    const { handler } = setup();
    const r = await handler(new Request('http://agent.local/health'));
    expect(r.status).toBe(200);
  });
});

describe('拒絕並留紀錄', () => {
  it('缺簽章（什麼憑證都沒帶）→ 401 + log', async () => {
    const { post, calls, logs } = setup();
    const r = await post('/trigger', {});
    expect(r.status).toBe(401);
    expect(calls.trigger).toBe(0);
    expect(logs.join('\n')).toMatch(/reject.*missing/i);
  });

  it('缺其中一個 header（有簽章沒 nonce）→ 401', async () => {
    const { post, calls } = setup();
    const h = sign({ purpose: 'trigger', key: K_TRIGGER, pathAndQuery: '/trigger' });
    delete (h as Record<string, string>)['X-Tripline-Nonce'];
    expect((await post('/trigger', h)).status).toBe(401);
    expect(calls.trigger).toBe(0);
  });

  it('錯 key → 401 + log', async () => {
    const { post, calls, logs } = setup();
    const r = await post('/trigger', sign({ purpose: 'trigger', key: 'wrong-key-wrong-key-wrong-key-0', pathAndQuery: '/trigger' }));
    expect(r.status).toBe(401);
    expect(calls.trigger).toBe(0);
    expect(logs.join('\n')).toMatch(/reject.*bad_signature/i);
  });

  it('body 被改 → 401', async () => {
    const { post, calls } = setup();
    const h = sign({ purpose: 'mail', key: K_MAIL, pathAndQuery: '/internal/mail/send', body: '{"to":"a@example.test"}' });
    const r = await post('/internal/mail/send', h, '{"to":"evil@example.test"}');
    expect(r.status).toBe(401);
    expect(calls.mail).toBe(0);
  });

  it('query 被改（source=api → source=job）→ 401', async () => {
    const { post, calls } = setup();
    const h = sign({ purpose: 'trigger', key: K_TRIGGER, pathAndQuery: '/trigger?source=api' });
    expect((await post('/trigger?source=job', h)).status).toBe(401);
    expect(calls.trigger).toBe(0);
  });

  it('method 被換掉（簽 POST、實際 GET）→ 401；簽對 GET → 200', async () => {
    const { handler } = setup();
    const get = (h: Record<string, string>) => handler(new Request('http://agent.local/internal/ping', { method: 'GET', headers: h }));
    expect((await get(sign({ purpose: 'trigger', key: K_TRIGGER, method: 'POST', pathAndQuery: '/internal/ping' }))).status).toBe(401);
    expect((await get(sign({ purpose: 'trigger', key: K_TRIGGER, method: 'GET', pathAndQuery: '/internal/ping' }))).status).toBe(200);
  });

  it('簽章長度不對 / 非 hex / timestamp 非數字 → 401（不拋例外）', async () => {
    const { post } = setup();
    const good = sign({ purpose: 'trigger', key: K_TRIGGER, pathAndQuery: '/trigger' });
    expect((await post('/trigger', { ...good, 'X-Tripline-Signature': 'abcd' })).status).toBe(401);
    expect((await post('/trigger', { ...good, 'X-Tripline-Signature': 'zz'.repeat(32) })).status).toBe(401);
    expect((await post('/trigger', { ...good, 'X-Tripline-Timestamp': 'yesterday' })).status).toBe(401);
  });

  it('log 不含 key 也不含完整簽章', async () => {
    const { post, logs } = setup();
    const h = sign({ purpose: 'trigger', key: 'wrong-key-wrong-key-wrong-key-0', pathAndQuery: '/trigger' });
    await post('/trigger', h);
    const all = logs.join('\n');
    expect(all.length).toBeGreaterThan(0);
    for (const secret of [K_TRIGGER, K_TRIGGER_OLD, K_MAIL, K_MINT, LEGACY, 'wrong-key-wrong-key-wrong-key-0', h['X-Tripline-Signature']]) {
      expect(all).not.toContain(secret);
    }
  });
});

describe('過期與時間窗', () => {
  it('過期（比時間窗舊）→ 401；窗內 → 200', async () => {
    const stale = setup({ windowSec: 300 });
    expect((await stale.post('/trigger', sign({ purpose: 'trigger', key: K_TRIGGER, pathAndQuery: '/trigger', ts: T0 - 301 }))).status).toBe(401);
    const fresh = setup({ windowSec: 300 });
    expect((await fresh.post('/trigger', sign({ purpose: 'trigger', key: K_TRIGGER, pathAndQuery: '/trigger', ts: T0 - 299 }))).status).toBe(200);
  });

  it('未來太遠的 timestamp 也拒絕', async () => {
    const { post } = setup({ windowSec: 300 });
    expect((await post('/trigger', sign({ purpose: 'trigger', key: K_TRIGGER, pathAndQuery: '/trigger', ts: T0 + 301 }))).status).toBe(401);
  });

  it('時間窗可設定：同一個 400 秒前的請求，窗 300 拒、窗 600 收', async () => {
    const h = () => sign({ purpose: 'trigger', key: K_TRIGGER, pathAndQuery: '/trigger', ts: T0 - 400 });
    expect((await setup({ windowSec: 300 }).post('/trigger', h())).status).toBe(401);
    expect((await setup({ windowSec: 600 }).post('/trigger', h())).status).toBe(200);
  });

  it('log 標明 expired', async () => {
    const { post, logs } = setup();
    await post('/trigger', sign({ purpose: 'trigger', key: K_TRIGGER, pathAndQuery: '/trigger', ts: T0 - 10_000 }));
    expect(logs.join('\n')).toMatch(/reject.*expired/i);
  });
});

describe('重放', () => {
  it('同一個請求送兩次：第一次 200、第二次 401，handler 只跑一次', async () => {
    const { post, calls, logs } = setup();
    const h = sign({ purpose: 'trigger', key: K_TRIGGER, pathAndQuery: '/trigger', nonce: 'replay-1' });
    expect((await post('/trigger', h)).status).toBe(200);
    expect((await post('/trigger', h)).status).toBe(401);
    expect(calls.trigger).toBe(1);
    expect(logs.join('\n')).toMatch(/reject.*replay/i);
  });

  it('不同 nonce 互不影響', async () => {
    const { post } = setup();
    expect((await post('/trigger', sign({ purpose: 'trigger', key: K_TRIGGER, pathAndQuery: '/trigger', nonce: 'a1' }))).status).toBe(200);
    expect((await post('/trigger', sign({ purpose: 'trigger', key: K_TRIGGER, pathAndQuery: '/trigger', nonce: 'a2' }))).status).toBe(200);
  });

  it('簽章錯的請求不會燒掉 nonce（攻擊者不能搶先佔用合法 nonce）', async () => {
    const { post } = setup();
    const bad = sign({ purpose: 'trigger', key: 'wrong-key-wrong-key-wrong-key-0', pathAndQuery: '/trigger', nonce: 'victim-nonce' });
    expect((await post('/trigger', bad)).status).toBe(401);
    const good = sign({ purpose: 'trigger', key: K_TRIGGER, pathAndQuery: '/trigger', nonce: 'victim-nonce' });
    expect((await post('/trigger', good)).status).toBe(200);
  });

  it('被拒的重放不會讓後續合法請求失效', async () => {
    const { post } = setup();
    const h = sign({ purpose: 'trigger', key: K_TRIGGER, pathAndQuery: '/trigger', nonce: 'r-x' });
    await post('/trigger', h);
    await post('/trigger', h);
    expect((await post('/trigger', sign({ purpose: 'trigger', key: K_TRIGGER, pathAndQuery: '/trigger' }))).status).toBe(200);
  });
});

describe('三把 key 用途隔離', () => {
  it.each([
    ['mail key 簽 trigger', '/trigger', 'trigger' as Purpose, K_MAIL],
    ['mint key 簽 trigger', '/trigger', 'trigger' as Purpose, K_MINT],
    ['trigger key 簽 mail', '/internal/mail/send', 'mail' as Purpose, K_TRIGGER],
    ['trigger key 簽 mint', '/internal/mint-token', 'mint' as Purpose, K_TRIGGER],
    ['mail key 簽 mint', '/internal/mint-token', 'mint' as Purpose, K_MAIL],
  ])('%s → 401', async (_n, p, purpose, key) => {
    const { post, calls } = setup();
    expect((await post(p, sign({ purpose, key, pathAndQuery: p }))).status).toBe(401);
    expect(calls.trigger + calls.mail + calls.mint).toBe(0);
  });

  it('即使兩把 key 設成同一個值，purpose 標錯的簽章仍不通用', async () => {
    const { post } = setup({ keys: { mail: [K_TRIGGER] } });
    // 用 trigger 的 purpose 標籤簽，打到 mail 路由
    const h = sign({ purpose: 'trigger', key: K_TRIGGER, pathAndQuery: '/internal/mail/send' });
    expect((await post('/internal/mail/send', h)).status).toBe(401);
  });

  it('該用途沒設定任何 key → fail-closed 401（不是放行）', async () => {
    const { post, calls } = setup({ keys: { mint: [] } });
    expect((await post('/internal/mint-token', sign({ purpose: 'mint', key: K_MINT, pathAndQuery: '/internal/mint-token' }))).status).toBe(401);
    expect(calls.mint).toBe(0);
  });

  it('該用途完全沒給 key（undefined）→ 401，不會退而用別的用途的 key', async () => {
    const { post, calls } = setup({ keys: { mail: undefined } });
    const h = sign({ purpose: 'mail', key: K_TRIGGER, pathAndQuery: '/internal/mail/send' });
    expect((await post('/internal/mail/send', h)).status).toBe(401);
    expect(calls.mail).toBe(0);
  });

  it('空字串 key 不算設定（不會讓空 key 簽的請求通過）', async () => {
    const { post } = setup({ keys: { trigger: [''] } });
    // 以空字串 key 簽（HMAC 允許空 key）
    expect((await post('/trigger', sign({ purpose: 'trigger', key: '', pathAndQuery: '/trigger' }))).status).toBe(401);
  });
});

describe('金鑰輪替', () => {
  it('新舊並存：兩把都收', async () => {
    const { post } = setup({ keys: { trigger: [K_TRIGGER, K_TRIGGER_OLD] } });
    expect((await post('/trigger', sign({ purpose: 'trigger', key: K_TRIGGER, pathAndQuery: '/trigger' }))).status).toBe(200);
    expect((await post('/trigger', sign({ purpose: 'trigger', key: K_TRIGGER_OLD, pathAndQuery: '/trigger' }))).status).toBe(200);
  });

  it('舊 key 從清單移除後 → 拒絕', async () => {
    const { post } = setup({ keys: { trigger: [K_TRIGGER] } });
    expect((await post('/trigger', sign({ purpose: 'trigger', key: K_TRIGGER_OLD, pathAndQuery: '/trigger' }))).status).toBe(401);
  });

  it('舊 key 排在前面也一樣收新 key（不依清單順序）', async () => {
    const { post } = setup({ keys: { trigger: [K_TRIGGER_OLD, K_TRIGGER] } });
    expect((await post('/trigger', sign({ purpose: 'trigger', key: K_TRIGGER, pathAndQuery: '/trigger' }))).status).toBe(200);
  });
});

describe('舊 TRIPLINE_API_SECRET 並存（T21 才切換）', () => {
  it('舊 Bearer 仍可打 trigger 與 mail', async () => {
    const { post, calls } = setup();
    expect((await post('/trigger', { Authorization: `Bearer ${LEGACY}` })).status).toBe(200);
    expect((await post('/internal/mail/send', { Authorization: `Bearer ${LEGACY}` }, '{}')).status).toBe(200);
    expect(calls.trigger).toBe(1);
    expect(calls.mail).toBe(1);
  });

  it('舊 Bearer 錯 → 401', async () => {
    const { post } = setup();
    expect((await post('/trigger', { Authorization: 'Bearer nope' })).status).toBe(401);
  });

  it('舊 secret 沒設定 → 一律拒絕舊方式', async () => {
    const { post } = setup({ legacySecret: '' });
    expect((await post('/trigger', { Authorization: 'Bearer ' })).status).toBe(401);
  });

  it('帶了簽章 header 就只看簽章：簽章錯時，就算同時帶正確 Bearer 也 401（不能降級繞過）', async () => {
    const { post, calls } = setup();
    const bad = sign({ purpose: 'trigger', key: 'wrong-key-wrong-key-wrong-key-0', pathAndQuery: '/trigger' });
    expect((await post('/trigger', { ...bad, Authorization: `Bearer ${LEGACY}` })).status).toBe(401);
    expect(calls.trigger).toBe(0);
  });

  it('舊 Bearer 打不開不允許 legacy 的路由（mint）', async () => {
    const { post, calls } = setup();
    expect((await post('/internal/mint-token', { Authorization: `Bearer ${LEGACY}` })).status).toBe(401);
    expect(calls.mint).toBe(0);
  });
});

describe('路由', () => {
  it('未知路徑 → 404；方法不符 → 404', async () => {
    const { handler } = setup();
    expect((await handler(new Request('http://agent.local/nope', { method: 'POST' }))).status).toBe(404);
    expect((await handler(new Request('http://agent.local/trigger', { method: 'GET' }))).status).toBe(404);
  });
});
