#!/usr/bin/env node
'use strict';
/**
 * tp-request-mcp-server.js — zero-shell MCP tool surface for the contained
 * tp-request agent (activation 前置 (0) containment, layer B-full).
 *
 * The tp-request ephemeral Claude session runs with `--permission-mode dontAsk`
 * and ONLY `mcp__tripline__*` allowed (no Bash/Read/Write/WebFetch/Agent). This
 * stdio MCP server is the agent's ENTIRE capability surface: a fixed set of
 * typed tools, each a single tripline API operation. It cannot reach arbitrary
 * URLs, methods, or trips.
 *
 * Hard security properties (do NOT weaken):
 *   - tripId is ALWAYS the injected `TRIPLINE_RESTRICT_TRIP`. Tools never accept
 *     a tripId; the agent physically cannot target another trip.
 *   - Host is HARDCODED (API_BASE). No url/method/host parameter on any tool.
 *   - Only the security.md ✅ allowlist operations exist as tools. The ❌ ops
 *     (DELETE entry, DELETE poi, trips create/delete, permissions) are absent.
 *   - poi-favorites tools are NOT exposed — favorites are user-scoped cross-trip
 *     data; restrict_trip tokens are denied at the API (T1). Exposing them would
 *     only 403.
 *   - Fail-closed: no RESTRICT_TRIP / no TOKEN → server refuses to build any
 *     request.
 *
 * Auth: uses the injected `TRIPLINE_API_TOKEN` (the restrict_trip-scoped user
 * token). The server never reads .env.local or mints a token.
 *
 * Transport: newline-delimited JSON-RPC 2.0 over stdio (MCP stdio transport).
 * Hand-rolled (no SDK) to keep the trusted surface minimal + auditable + free
 * of new supply-chain inside the contained process.
 */

// Hardcoded prod host. Intentionally NOT env-overridable (auditor MEDIUM:
// settings/host must not be looseneable by the environment the agent runs in).
// Tests exercise the pure builders + a mock fetch; they never need to change it.
const API_BASE = 'https://trip-planner-dby.pages.dev';
const PROTOCOL_VERSION = '2024-11-05';
const SERVER_NAME = 'tripline';
const SERVER_VERSION = '1.0.0';

/**
 * Tool table. Each entry is ONE tripline API operation.
 *   method      — fixed HTTP method
 *   path        — template; {tripId} is ALWAYS replaced with RESTRICT_TRIP,
 *                 never from args. Other {placeholders} come from pathParams.
 *   pathParams  — agent-supplied path segments (validated present, encoded)
 *   query       — agent-supplied query params
 *   injectTripIdQuery — add ?tripId=RESTRICT_TRIP (reads scoped to the trip)
 *   body        — true if the operation takes a JSON body (passthrough; the API
 *                 validates body schema — the MCP boundary is method+host+trip)
 *   injectTripIdBody  — force body.tripId = RESTRICT_TRIP (PATCH /pois needs it)
 *   companion   — add `X-Request-Scope: companion` (write allowlist gate)
 */
const TOOLS = [
  // ----- reads -----
  {
    name: 'listRequests',
    description: '列出本 trip 待處理的旅伴請求（status=processing|open）。tripId 自動綁定，不可指定其他 trip。',
    method: 'GET',
    path: '/api/requests',
    query: { status: { required: true, description: 'processing | open' } },
    injectTripIdQuery: true,
  },
  {
    name: 'getTrip',
    description: '讀取本 trip 的 meta（名稱、天數、目的地等）。',
    method: 'GET',
    path: '/api/trips/{tripId}',
  },
  {
    name: 'getDay',
    description: '讀取本 trip 指定天的完整內容（entries + POI）。',
    method: 'GET',
    path: '/api/trips/{tripId}/days/{dayNum}',
    pathParams: { dayNum: { required: true, description: '第幾天（1-based）' } },
  },
  {
    name: 'poiSearch',
    description: 'Google Maps 驗證：以文字查詢搜尋 POI（確認存在 + 取 place_id/lat/lng）。containment 下取代 WebSearch。',
    method: 'GET',
    path: '/api/poi-search',
    query: { q: { required: true, description: 'POI 名稱 + 地區，如「美麗海水族館 沖繩」' } },
  },
  // ----- POI master -----
  // 註：無 createPoi / findPoiByPlaceId — bare POST/GET /api/pois 不在 ✅ 白名單。
  // find-or-create master 由 setEntryPoi (PUT poi-id) / addAlternate 帶 search payload
  // server-side 完成；旅伴不需獨立建 POI master。
  {
    name: 'patchPoi',
    description: '更新 pois master（資料須來自 poiSearch/enrich；tripId 自動帶入）。',
    method: 'PATCH',
    path: '/api/pois/{id}',
    pathParams: { id: { required: true, description: 'poi id' } },
    body: true,
    injectTripIdBody: true,
    companion: true,
  },
  {
    name: 'enrichPoi',
    description: 'Google Place Details 自動補齊 POI 資料（首選，優於手動 patchPoi）。',
    method: 'POST',
    path: '/api/pois/{id}/enrich',
    pathParams: { id: { required: true, description: 'poi id' } },
    injectTripIdQuery: true, // enrich 讀 ?tripId=（requirePoiWrite 授權需要）— 缺則 400
    companion: true,
  },
  // ----- entries (writes) -----
  {
    name: 'addEntry',
    description: '在指定天新增 entry（必填 title）。',
    method: 'POST',
    path: '/api/trips/{tripId}/days/{dayNum}/entries',
    pathParams: { dayNum: { required: true } },
    body: true,
    companion: true,
  },
  {
    name: 'patchEntry',
    description: '修改 entry 欄位（時間、location、description 等）。',
    method: 'PATCH',
    path: '/api/trips/{tripId}/entries/{eid}',
    pathParams: { eid: { required: true, description: 'entry id' } },
    body: true,
    companion: true,
  },
  {
    name: 'addAlternate',
    description: '在 entry 下新增 alternate POI。',
    method: 'POST',
    path: '/api/trips/{tripId}/entries/{eid}/alternates',
    pathParams: { eid: { required: true } },
    body: true,
    companion: true,
  },
  {
    name: 'swapMaster',
    description: 'entry 內 swap master ↔ alternate。',
    method: 'PATCH',
    path: '/api/trips/{tripId}/entries/{eid}/master',
    pathParams: { eid: { required: true } },
    body: true,
    companion: true,
  },
  {
    name: 'setEntryPoi',
    description: 'find-or-create master from search payload（PUT poi-id）。',
    method: 'PUT',
    path: '/api/trips/{tripId}/entries/{eid}/poi-id',
    pathParams: { eid: { required: true } },
    body: true,
    companion: true,
  },
  {
    name: 'deleteAlternate',
    description: '刪除 entry 下的 alternate POI（需帶 entryPoisVersion）。',
    method: 'DELETE',
    path: '/api/trips/{tripId}/entries/{eid}/alternates/{poiId}',
    pathParams: { eid: { required: true }, poiId: { required: true } },
    query: { entryPoisVersion: { required: true, description: '樂觀鎖版本號' } },
    companion: true,
  },
  {
    name: 'reorderAlternates',
    description: '重排 entry 下的 alternates。',
    method: 'PATCH',
    path: '/api/trips/{tripId}/entries/{eid}/alternates/reorder',
    pathParams: { eid: { required: true } },
    body: true,
    companion: true,
  },
  {
    name: 'recomputeTravel',
    description: '結構動完後重算指定天的車程（鐵律：不手動算 travel）。',
    method: 'POST',
    path: '/api/trips/{tripId}/recompute-travel',
    query: { day: { required: true, description: '受影響天' } },
    companion: true,
  },
  // ⚠️ putDoc（PUT /api/trips/{tripId}/docs/{type}）**刻意移除**，2026-07-28。
  //
  // trip_docs 整條是死路：行程筆記頁讀的是 trip_pretrip_notes + trip_emergency_contacts
  // （migration 0073），從不讀 trip_docs；checklist/emergency 這些 doc 的 UI 入口在
  // v2.17.17 就整批移除，前端現在完全不 fetch /docs。
  //
  // 留著它的後果（prod 事故 request 280，Ray 的沖繩之旅）：使用者要求「重新生成行程
  // 筆記的緊急聯絡與行程須知」，agent 挑了工具表裡唯一能寫筆記的 putDoc，對 trip_docs
  // 寫四次、audit_log 四筆全是 entries_count=0，然後回報「已重新生成…包含警察/消防/
  // 海保電話…」。使用者在 App 裡什麼都看不到。
  //
  // 筆記的正解是 POST /trips/:id/notes/:type/generate（App 筆記頁的 AI 生成鈕）——
  // 那條 pipeline 帶人工維護保護、semantic_key 去重與 exclusion tombstone，不該讓
  // 自由格式的 agent 繞過。**不要為了「讓 agent 也能寫筆記」把它加回來。**
  // ----- request lifecycle -----
  {
    name: 'updateRequest',
    description: '更新請求的 reply/status（處理完必呼叫 status=completed + reply）。無 companion header。',
    method: 'PATCH',
    path: '/api/requests/{id}',
    pathParams: { id: { required: true, description: 'request id' } },
    body: true,
  },
];

const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/** JSON Schema for a tool's inputs (path params + query + optional body). */
function toolInputSchema(tool) {
  const properties = {};
  const required = [];
  for (const [name, def] of Object.entries(tool.pathParams || {})) {
    properties[name] = { type: 'string', description: def.description || '' };
    if (def.required) required.push(name);
  }
  for (const [name, def] of Object.entries(tool.query || {})) {
    properties[name] = { type: 'string', description: def.description || '' };
    if (def.required) required.push(name);
  }
  if (tool.body) {
    properties.body = { type: 'object', description: '操作的 JSON payload（欄位由 API 驗證）' };
  }
  return { type: 'object', properties, required, additionalProperties: false };
}

/**
 * Build the concrete HTTP request for a tool call. PURE + testable.
 * @throws Error on fail-closed (no restrictTrip/token) or missing required arg.
 */
function buildRequest(tool, args, cfg) {
  const restrictTrip = cfg && cfg.restrictTrip;
  const token = cfg && cfg.token;
  // Fail-closed: never build a request without an explicit trip scope + token.
  if (!restrictTrip) throw new Error('fail-closed: TRIPLINE_RESTRICT_TRIP 未設定');
  if (!token) throw new Error('fail-closed: TRIPLINE_API_TOKEN 未設定');
  args = args || {};

  // Path: {tripId} is ALWAYS restrictTrip (never from args). Other params typed.
  let path = tool.path.replace('{tripId}', encodeURIComponent(restrictTrip));
  for (const name of Object.keys(tool.pathParams || {})) {
    const def = tool.pathParams[name];
    const val = args[name];
    if (val === undefined || val === null || val === '') {
      if (def.required) throw new Error(`缺少必填參數 ${name}`);
      continue;
    }
    path = path.replace(`{${name}}`, encodeURIComponent(String(val)));
  }
  if (path.includes('{')) throw new Error(`path 仍有未填 placeholder: ${path}`);

  // Query
  const qs = new URLSearchParams();
  for (const name of Object.keys(tool.query || {})) {
    const def = tool.query[name];
    const val = args[name];
    if (val === undefined || val === null || val === '') {
      if (def.required) throw new Error(`缺少必填 query ${name}`);
      continue;
    }
    qs.set(name, String(val));
  }
  if (tool.injectTripIdQuery) qs.set('tripId', restrictTrip); // scope reads to the trip
  const query = qs.toString();

  const headers = { Authorization: `Bearer ${token}` };
  if (tool.companion) headers['X-Request-Scope'] = 'companion';

  let body;
  if (tool.body) {
    const payload = (args.body && typeof args.body === 'object') ? { ...args.body } : {};
    if (tool.injectTripIdBody) payload.tripId = restrictTrip; // lock, override any agent value
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(payload);
  }

  return {
    url: `${API_BASE}${path}${query ? `?${query}` : ''}`,
    method: tool.method,
    headers,
    body,
  };
}

/** Execute a tool call against the API. Returns {status, body}. Never throws on HTTP. */
async function dispatchTool(tool, args, cfg) {
  const req = buildRequest(tool, args, cfg);
  const fetchImpl = (cfg && cfg.fetch) || fetch;
  const res = await fetchImpl(req.url, { method: req.method, headers: req.headers, body: req.body });
  const text = await res.text();
  return { status: res.status, body: text };
}

// ---------------------------------------------------------------------------
// stdio JSON-RPC 2.0 loop (MCP stdio transport: newline-delimited JSON)
// ---------------------------------------------------------------------------

function rpcResult(id, result) {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}
function rpcError(id, code, message) {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handleMessage(msg, cfg) {
  const { id, method, params } = msg;
  // Notifications (no id) get no response.
  if (id === undefined || id === null) return null;

  if (method === 'initialize') {
    return rpcResult(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (method === 'tools/list') {
    return rpcResult(id, {
      tools: TOOLS.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: toolInputSchema(t),
      })),
    });
  }
  if (method === 'tools/call') {
    const name = params && params.name;
    const tool = TOOLS_BY_NAME.get(name);
    if (!tool) return rpcError(id, -32602, `未知工具: ${name}`);
    try {
      const out = await dispatchTool(tool, (params && params.arguments) || {}, cfg);
      const isError = out.status >= 400;
      return rpcResult(id, {
        content: [{ type: 'text', text: `HTTP ${out.status}\n${out.body}` }],
        isError,
      });
    } catch (err) {
      return rpcResult(id, {
        content: [{ type: 'text', text: `tool error: ${err && err.message ? err.message : String(err)}` }],
        isError: true,
      });
    }
  }
  return rpcError(id, -32601, `未支援的 method: ${method}`);
}

function main() {
  const cfg = {
    restrictTrip: process.env.TRIPLINE_RESTRICT_TRIP,
    token: process.env.TRIPLINE_API_TOKEN,
  };
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // ignore non-JSON lines
      }
      handleMessage(msg, cfg)
        .then((resp) => {
          if (resp) process.stdout.write(resp + '\n');
        })
        .catch((err) => {
          if (msg && msg.id != null) {
            process.stdout.write(rpcError(msg.id, -32603, String(err && err.message ? err.message : err)) + '\n');
          }
        });
    }
  });
  process.stdin.on('end', () => process.exit(0));
}

module.exports = { TOOLS, TOOLS_BY_NAME, toolInputSchema, buildRequest, dispatchTool, handleMessage, API_BASE };

if (require.main === module) main();
