/**
 * api → agent 請求簽章驗證（ADR-0011、T17）。
 *
 * canonical string（以 \n 相連）必須與 api repo 的 src/lib/signing.ts 逐字一致：
 *   TRIPLINE-HMAC-V1 / purpose / METHOD / path+query / timestamp(秒) / nonce / sha256hex(body)
 * 兩邊的測試以同一組固定向量鎖住。
 *
 * 驗證順序：header 齊全 → timestamp 在時間窗內 → 簽章對（逐把 key 比對、constant-time）→
 * 才登記 nonce（簽章錯的請求不能搶先佔用合法 nonce）→ nonce 重複即拒。
 * 輪替：每個用途可有多把 key，新舊並存都接受。
 * log 只寫拒絕原因與 method / path，不寫 key、不寫簽章。
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export type SigningPurpose = 'trigger' | 'mail' | 'mint';

export const SIGNING_HEADERS = {
  timestamp: 'x-tripline-timestamp',
  nonce: 'x-tripline-nonce',
  signature: 'x-tripline-signature',
} as const;

export const DEFAULT_WINDOW_SEC = 300;
const MAX_NONCE_LENGTH = 128;
const MAX_NONCE_ENTRIES = 100_000;

export type SigningRejectReason =
  | 'missing'
  | 'malformed'
  | 'expired'
  | 'bad_signature'
  | 'replay'
  | 'no_key_configured'
  | 'nonce_store_full';

export type VerifyResult = { ok: true } | { ok: false; reason: SigningRejectReason };

export interface SigningVerifierConfig {
  keys: Partial<Record<SigningPurpose, string[]>>;
  /** 容許的時間偏差（秒，前後各算）；預設 300。 */
  windowSec?: number;
  /** 注入時鐘（毫秒），測試用。 */
  now?: () => number;
}

/** 請求是否帶了任何簽章 header（決定走簽章還是舊方式）。 */
export function hasSigningHeaders(req: Request): boolean {
  return Object.values(SIGNING_HEADERS).some((h) => req.headers.has(h));
}

/** 從環境變數字串（逗號分隔，新舊並存）解析 key 清單；空白項丟掉。 */
export function parseKeyList(raw: string | undefined): string[] {
  return (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

export function createSigningVerifier(config: SigningVerifierConfig) {
  const windowSec = config.windowSec && config.windowSec > 0 ? config.windowSec : DEFAULT_WINDOW_SEC;
  const now = config.now ?? Date.now;
  /** `${purpose}:${nonce}` → 到期時間（毫秒） */
  const seen = new Map<string, number>();

  function prune(nowMs: number) {
    for (const [k, exp] of seen) if (exp <= nowMs) seen.delete(k);
  }

  /** body 以原文字串傳入（呼叫端已讀完，不重複消耗 stream）。 */
  function verify(req: Request, purpose: SigningPurpose, bodyText: string): VerifyResult {
    const ts = req.headers.get(SIGNING_HEADERS.timestamp);
    const nonce = req.headers.get(SIGNING_HEADERS.nonce);
    const sig = req.headers.get(SIGNING_HEADERS.signature);
    if (!ts || !nonce || !sig) return { ok: false, reason: 'missing' };

    if (!/^\d{1,12}$/.test(ts) || nonce.length > MAX_NONCE_LENGTH || !/^[0-9a-fA-F]{64}$/.test(sig)) {
      return { ok: false, reason: 'malformed' };
    }
    const tsSec = Number(ts);
    const nowMs = now();
    if (Math.abs(nowMs / 1000 - tsSec) > windowSec) return { ok: false, reason: 'expired' };

    const keys = (config.keys[purpose] ?? []).filter((k) => k.length > 0);
    if (keys.length === 0) return { ok: false, reason: 'no_key_configured' };

    const u = new URL(req.url);
    const canonical = [
      'TRIPLINE-HMAC-V1',
      purpose,
      req.method.toUpperCase(),
      u.pathname + u.search,
      ts,
      nonce,
      createHash('sha256').update(bodyText).digest('hex'),
    ].join('\n');
    const provided = Buffer.from(sig, 'hex');
    let matched = false;
    for (const key of keys) {
      const expected = createHmac('sha256', key).update(canonical).digest();
      // 不短路：每把 key 都比，避免從耗時推測是第幾把
      if (timingSafeEqual(expected, provided)) matched = true;
    }
    if (!matched) return { ok: false, reason: 'bad_signature' };

    prune(nowMs);
    const id = `${purpose}:${nonce}`;
    if (seen.has(id)) return { ok: false, reason: 'replay' };
    if (seen.size >= MAX_NONCE_ENTRIES) return { ok: false, reason: 'nonce_store_full' };
    seen.set(id, (tsSec + windowSec + 1) * 1000);
    return { ok: true };
  }

  return { verify };
}
