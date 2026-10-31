/**
 * tp-request MCP server — behavioural unit tests (activation containment layer B-full).
 *
 * The MCP server is the ENTIRE capability surface of the contained tp-request
 * agent. These tests lock the security invariants that make containment hold:
 *   - tripId is ALWAYS the injected RESTRICT_TRIP, never an agent argument
 *   - host is hardcoded, method is fixed per tool
 *   - only the security.md ✅ allowlist ops exist (no DELETE entry / DELETE poi /
 *     trips create-delete / permissions / favorites)
 *   - write tools carry X-Request-Scope: companion (except PATCH /requests)
 *   - fail-closed without RESTRICT_TRIP / token
 *
 * Behavioural (require + call), NOT source-grep — refactors that keep behaviour
 * must not false-fail (memory: source-grep-locked tests are brittle).
 */
import { describe, it, expect } from 'vitest';

const load = () => import('../../scripts/tp-request-mcp-server.js');
const CFG = { restrictTrip: 'trip-ABC', token: 'tok-XYZ' };

describe('tp-request MCP — tripId injection (never from agent)', () => {
  it('getDay: {tripId} = RESTRICT_TRIP, agent-supplied tripId ignored', async () => {
    const m = await load();
    const r = m.buildRequest(m.TOOLS_BY_NAME.get('getDay'), { dayNum: '3', tripId: 'trip-EVIL' }, CFG);
    expect(r.url).toContain('/api/trips/trip-ABC/days/3');
    expect(r.url).not.toContain('trip-EVIL');
    expect(r.method).toBe('GET');
  });

  it('patchPoi: body.tripId forced to RESTRICT_TRIP, overriding agent value', async () => {
    const m = await load();
    const r = m.buildRequest(m.TOOLS_BY_NAME.get('patchPoi'), { id: '5', body: { tripId: 'trip-EVIL', name: 'n' } }, CFG);
    expect(JSON.parse(r.body).tripId).toBe('trip-ABC');
  });

  it('listRequests: injects ?tripId=RESTRICT_TRIP (reads scoped to trip)', async () => {
    const m = await load();
    const r = m.buildRequest(m.TOOLS_BY_NAME.get('listRequests'), { status: 'processing' }, CFG);
    expect(r.url).toContain('tripId=trip-ABC');
    expect(r.url).toContain('status=processing');
  });

  it('tripId is NOT an input-schema property on any tool (agent cannot pass it)', async () => {
    const m = await load();
    for (const tool of m.TOOLS) {
      const schema = m.toolInputSchema(tool);
      expect(Object.keys(schema.properties)).not.toContain('tripId');
    }
  });
});

describe('tp-request MCP — companion write gate', () => {
  it('addEntry (write) carries X-Request-Scope: companion', async () => {
    const m = await load();
    const r = m.buildRequest(m.TOOLS_BY_NAME.get('addEntry'), { dayNum: '1', body: { title: 'x' } }, CFG);
    expect(r.headers['X-Request-Scope']).toBe('companion');
  });

  it('updateRequest (PATCH /requests) does NOT carry companion header', async () => {
    const m = await load();
    const r = m.buildRequest(m.TOOLS_BY_NAME.get('updateRequest'), { id: '9', body: { status: 'completed' } }, CFG);
    expect(r.headers['X-Request-Scope']).toBeUndefined();
  });

  it('every write tool except updateRequest carries companion header', async () => {
    const m = await load();
    const writeMethods = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);
    for (const tool of m.TOOLS) {
      if (!writeMethods.has(tool.method)) continue;
      if (tool.name === 'updateRequest') continue;
      // give it minimal valid args
      const args = {};
      for (const p of Object.keys(tool.pathParams || {})) args[p] = '1';
      for (const q of Object.keys(tool.query || {})) args[q] = '1';
      if (tool.body) args.body = {};
      const r = m.buildRequest(tool, args, CFG);
      expect(r.headers['X-Request-Scope'], `${tool.name} must carry companion`).toBe('companion');
    }
  });
});

describe('tp-request MCP — trip_docs 是死路，不可暴露給 agent', () => {
  /*
   * 2026-07-28 prod 事故（Ray 的沖繩之旅，request 280）：使用者在聊天要求「重新生成
   * 行程筆記的緊急聯絡與行程須知」，agent 用 putDoc 對 trip_docs 寫了四次，audit_log
   * 四筆全是 entries_count=0，然後回報「已重新生成…包含警察/消防/海保電話…」。
   *
   * 兩層問題：(1) 空寫入被講成完成；(2) 就算真寫進去也看不到 —— 行程筆記頁讀的是
   * trip_pretrip_notes + trip_emergency_contacts（migration 0073），從不讀 trip_docs，
   * 而 checklist/emergency 這些 doc 的 UI 入口在 v2.17.17 就整批移除了。前端現在
   * 完全不 fetch /docs。
   *
   * putDoc 是工具表裡唯一能寫「筆記類」的工具 —— 留著它，agent 想寫筆記時只能倒進
   * 這個黑洞。筆記的正解是 App 筆記頁的 POST /trips/:id/notes/:type/generate，那條
   * pipeline 有人工維護保護與 exclusion tombstone，不該讓自由格式的 agent 繞過。
   */
  it('工具表沒有 putDoc', async () => {
    const m = await load();
    const names = m.TOOLS.map((t: { name: string }) => t.name);
    expect(names).not.toContain('putDoc');
  });

  it('沒有任何工具打 /docs（不留別名繞過）', async () => {
    const m = await load();
    const docTools = m.TOOLS.filter((t: { path: string }) => /\/docs\b/.test(t.path));
    expect(docTools.map((t: { name: string }) => t.name)).toEqual([]);
  });

  it('也沒有直寫筆記表的工具 —— 筆記只能走 generate pipeline', async () => {
    const m = await load();
    const noteWriters = m.TOOLS.filter(
      (t: { path: string; method: string }) =>
        /\/notes\b/.test(t.path) && t.method !== 'GET',
    );
    expect(noteWriters.map((t: { name: string }) => t.name)).toEqual([]);
  });
});

describe('tp-request MCP — allowlist surface (❌ ops absent)', () => {
  it('exposes no favorites, no entry-delete, no poi-delete, no trips create/delete, no permissions tool', async () => {
    const m = await load();
    const names = m.TOOLS.map((t: { name: string }) => t.name);
    // favorites blocked at API (T1) — not exposed
    expect(names.find((n: string) => /favorite/i.test(n))).toBeUndefined();
    // ❌ destructive / out-of-scope ops must not exist as tools
    const forbidden = new Set<string>();
    for (const t of m.TOOLS) {
      // DELETE only allowed for alternates (entry-scoped), never whole entry/poi/trip
      if (t.method === 'DELETE' && !/alternate/i.test(t.name)) forbidden.add(t.name);
      // no tool may hit /permissions or delete a trip/poi wholesale
      if (/\/permissions/.test(t.path)) forbidden.add(t.name);
      if (t.method === 'DELETE' && /\/pois\/\{id\}$/.test(t.path)) forbidden.add(t.name);
      if (t.method === 'DELETE' && /\/trips\/\{tripId\}$/.test(t.path)) forbidden.add(t.name);
    }
    expect([...forbidden]).toEqual([]);
  });

  it('all tool hosts are the hardcoded API_BASE — no host/url param', async () => {
    const m = await load();
    for (const tool of m.TOOLS) {
      const r = m.buildRequest(tool, minimalArgs(tool), CFG);
      expect(r.url.startsWith(m.API_BASE + '/api/')).toBe(true);
    }
  });
});

describe('tp-request MCP — fail-closed', () => {
  it('throws without restrictTrip', async () => {
    const m = await load();
    expect(() => m.buildRequest(m.TOOLS_BY_NAME.get('getTrip'), {}, { token: 'x' })).toThrow(/fail-closed/);
  });
  it('throws without token', async () => {
    const m = await load();
    expect(() => m.buildRequest(m.TOOLS_BY_NAME.get('getTrip'), {}, { restrictTrip: 'trip-ABC' })).toThrow(/fail-closed/);
  });
  it('throws on missing required path param', async () => {
    const m = await load();
    expect(() => m.buildRequest(m.TOOLS_BY_NAME.get('getDay'), {}, CFG)).toThrow(/dayNum/);
  });
});

describe('tp-request MCP — JSON-RPC protocol', () => {
  it('initialize returns protocolVersion + tools capability + serverInfo', async () => {
    const m = await load();
    const resp = JSON.parse(await m.handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize' }, CFG));
    expect(resp.result.protocolVersion).toBeTruthy();
    expect(resp.result.capabilities.tools).toBeDefined();
    expect(resp.result.serverInfo.name).toBe('tripline');
  });

  it('tools/list returns every tool with name+description+inputSchema', async () => {
    const m = await load();
    const resp = JSON.parse(await m.handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, CFG));
    expect(resp.result.tools.length).toBe(m.TOOLS.length);
    for (const t of resp.result.tools) {
      expect(t.name).toBeTruthy();
      expect(t.description).toBeTruthy();
      expect(t.inputSchema.type).toBe('object');
    }
  });

  it('tools/call dispatches through injected fetch and shapes the response', async () => {
    const m = await load();
    let seenUrl = '', seenMethod = '', seenScope: string | undefined;
    const fetchMock = async (url: string, init: { method: string; headers: Record<string, string> }) => {
      seenUrl = url; seenMethod = init.method; seenScope = init.headers['X-Request-Scope'];
      return { status: 200, text: async () => '{"ok":true}' };
    };
    const resp = JSON.parse(await m.handleMessage(
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'addEntry', arguments: { dayNum: '2', body: { title: 't' } } } },
      { ...CFG, fetch: fetchMock },
    ));
    expect(seenUrl).toBe(m.API_BASE + '/api/trips/trip-ABC/days/2/entries');
    expect(seenMethod).toBe('POST');
    expect(seenScope).toBe('companion');
    expect(resp.result.isError).toBe(false);
    expect(resp.result.content[0].text).toContain('HTTP 200');
  });

  it('tools/call marks isError=true on HTTP >= 400', async () => {
    const m = await load();
    const fetchMock = async () => ({ status: 403, text: async () => 'denied' });
    const resp = JSON.parse(await m.handleMessage(
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'getTrip', arguments: {} } },
      { ...CFG, fetch: fetchMock },
    ));
    expect(resp.result.isError).toBe(true);
    expect(resp.result.content[0].text).toContain('HTTP 403');
  });

  it('tools/call on unknown tool → JSON-RPC error', async () => {
    const m = await load();
    const resp = JSON.parse(await m.handleMessage(
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'deleteEverything', arguments: {} } }, CFG));
    expect(resp.error).toBeDefined();
  });

  it('notification (no id) returns null (no response written)', async () => {
    const m = await load();
    const resp = await m.handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, CFG);
    expect(resp).toBeNull();
  });
});

function minimalArgs(tool: { pathParams?: Record<string, unknown>; query?: Record<string, unknown>; body?: boolean }) {
  const args: Record<string, unknown> = {};
  for (const p of Object.keys(tool.pathParams || {})) args[p] = '1';
  for (const q of Object.keys(tool.query || {})) args[q] = '1';
  if (tool.body) args.body = {};
  return args;
}
