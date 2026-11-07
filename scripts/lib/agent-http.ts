/**
 * agent 的 HTTP 入口（fetch handler）。
 *
 * 從 tripline-api-server.ts 抽出來，好讓測試能對它直接發 Request（不必起 Bun.serve）。
 * 來源限制（issue #12）：認證之前先看來源 IP，只放行本機與 Cloudflare（見 ip-allowlist.ts），其餘 403。
 * 認證規則（T17）：
 * - 請求帶任何 X-Tripline-* 簽章 header → 只看簽章（錯就 401，不會降級去試舊 Bearer）。
 * - 沒帶簽章 header → 路由 allowLegacy 才試舊 TRIPLINE_API_SECRET（Bearer）。T21 切換後移除。
 * - 兩者都沒有 → 401。
 */
import { timingSafeEqual } from 'node:crypto';
import { checkSource } from './ip-allowlist';
import {
  createSigningVerifier, hasSigningHeaders, type SigningPurpose, type SigningVerifierConfig,
} from './request-signing';

export interface AgentRoute {
  method: string;
  path: string;
  purpose: SigningPurpose;
  /** true = 在簽章 header 缺席時，仍接受舊的 Bearer secret（T21 前的並存期）。 */
  allowLegacy: boolean;
  /** 已通過認證；req 的 body 是重建過的，可正常讀取。 */
  handle: (req: Request) => Response | Promise<Response>;
}

export interface AgentHandlerDeps {
  legacySecret: string;
  signing: SigningVerifierConfig;
  routes: AgentRoute[];
  health: () => unknown;
  log?: (msg: string) => void;
  logError?: (msg: string) => void;
  /** 只放行本機與 Cloudflare 來源（issue #12）。預設啟用（fail closed）；只有明確傳 false 才關閉。 */
  restrictToLocalAndCloudflare?: boolean;
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function createAgentHandler(deps: AgentHandlerDeps) {
  const verifier = createSigningVerifier(deps.signing);
  const logError = deps.logError ?? deps.log ?? (() => {});

  function legacyOk(req: Request): boolean {
    if (!deps.legacySecret) return false;
    return constantTimeEqual(req.headers.get('Authorization') || '', `Bearer ${deps.legacySecret}`);
  }

  // 掃描流量可能很多：同一來源每分鐘最多一行，避免洗版 log。
  const lastRejectLog = new Map<string, number>();
  function logRejectThrottled(ip: string, msg: string) {
    const now = Date.now();
    if (now - (lastRejectLog.get(ip) ?? 0) < 60_000) return;
    if (lastRejectLog.size > 1000) lastRejectLog.clear();
    lastRejectLog.set(ip, now);
    logError(msg);
  }

  const unauthorized = () => Response.json({ error: 'unauthorized' }, { status: 401 });

  return async function handle(req: Request, peerIp?: string): Promise<Response> {
    if (deps.restrictToLocalAndCloudflare !== false) {
      const verdict = checkSource(peerIp, req.headers.get('x-forwarded-for'), req.headers.has('tailscale-funnel-request'));
      if (!verdict.ok) {
        logRejectThrottled(verdict.ip, `ip reject: ${verdict.reason} ip=${verdict.ip} ${req.method} ${new URL(req.url).pathname}`);
        return Response.json({ error: 'forbidden' }, { status: 403 });
      }
    }
    const url = new URL(req.url);

    if (req.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        },
      });
    }

    if (url.pathname === '/health' && req.method === 'GET') {
      return Response.json(deps.health());
    }

    const route = deps.routes.find((r) => r.method === req.method && r.path === url.pathname);
    if (!route) return Response.json({ error: 'not found' }, { status: 404 });

    const bodyText = await req.text();
    const where = `${req.method} ${url.pathname}`;

    if (hasSigningHeaders(req)) {
      const result = verifier.verify(req, route.purpose, bodyText);
      if (!result.ok) {
        logError(`signing reject: ${result.reason} purpose=${route.purpose} ${where}`);
        return unauthorized();
      }
    } else if (route.allowLegacy && legacyOk(req)) {
      // 舊方式：並存期內接受
    } else {
      const hadAuth = req.headers.has('Authorization');
      logError(`signing reject: missing purpose=${route.purpose} ${where}${hadAuth ? ' (legacy auth failed or not allowed)' : ''}`);
      return unauthorized();
    }

    // body 已被讀走，重建一個可讀的 Request 給 handler
    const forwarded = new Request(req.url, {
      method: req.method,
      headers: req.headers,
      body: bodyText.length > 0 ? bodyText : undefined,
    });
    return route.handle(forwarded);
  };
}
