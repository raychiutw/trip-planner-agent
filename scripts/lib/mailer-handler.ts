/**
 * mailer-handler — POST /internal/mail/send 處理邏輯
 *
 * Pure function with DI（verifyAuth / transporter / emailFrom / log），方便 unit test
 * 不依賴 Bun.serve / process.env / nodemailer.createTransport 直接 wire。
 *
 * 由 scripts/tripline-api-server.ts 透過 makeMailHandler() 注入真實 deps 後使用。
 */

import type { Transporter } from 'nodemailer';

export interface MailRequestBody {
  to?: string;
  subject?: string;
  html?: string;
  text?: string;       // optional plain-text fallback for non-HTML clients
  template?: string;
}

export interface MailSendResult {
  ok: boolean;
  to: string;
  subject: string;
  template: string | null;
  messageId?: string;
  error?: string;
  elapsedMs: number;
}

export interface MailHandlerDeps {
  verifyAuth: (req: Request) => boolean;
  transporter: () => Transporter;
  emailFrom: string;
  log?: (msg: string) => void;
  logError?: (msg: string) => void;
  /**
   * Optional observability hook：每次 sendMail 完成後 fire（成功 / 失敗都 fire）。
   * 用來：throttledAlert Telegram on failure + audit log。
   * 不影響 HTTP response（fire-and-forget；不 await）。v2.33.128 G2.
   */
  onSendResult?: (result: MailSendResult) => void;
}

export function makeMailHandler(deps: MailHandlerDeps) {
  return async (req: Request): Promise<Response> => {
    if (!deps.verifyAuth(req)) {
      return jsonResponse({ error: 'unauthorized' }, 401);
    }

    let body: MailRequestBody;
    try {
      body = (await req.json()) as MailRequestBody;
    } catch {
      return jsonResponse({ error: 'bad json' }, 400);
    }

    const { to, subject, html, text, template } = body;
    if (!to || !subject || !html) {
      return jsonResponse({ error: 'missing to/subject/html' }, 400);
    }

    // Validate `to` is a single, plain email address — defends against open-relay
    // abuse if TRIPLINE_API_SECRET ever leaks. nodemailer accepts comma-separated
    // lists and 'Display Name <email>' syntax which would let a caller send to
    // arbitrary recipients under the Tripline Gmail identity.
    if (!isPlainEmail(to)) {
      return jsonResponse({ error: 'invalid to: must be a single plain email' }, 400);
    }

    const t0 = Date.now();
    try {
      const info = await deps.transporter().sendMail({
        from: deps.emailFrom,
        to,
        subject,
        html,
        ...(text ? { text } : {}),
      });
      const elapsedMs = Date.now() - t0;
      deps.log?.(
        `mail sent: template=${template ?? '-'} to=${to} messageId=${info.messageId} ${elapsedMs}ms`,
      );
      // v2.33.128 G2：observability hook — caller 注入 throttledAlert + audit
      try {
        deps.onSendResult?.({
          ok: true,
          to,
          subject,
          template: template ?? null,
          messageId: info.messageId,
          elapsedMs,
        });
      } catch (hookErr) {
        deps.logError?.(`onSendResult hook threw (ok path): ${(hookErr as Error).message}`);
      }
      return jsonResponse({
        ok: true,
        messageId: info.messageId,
        elapsed: elapsedMs,
        template: template ?? null,
      });
    } catch (err) {
      const elapsedMs = Date.now() - t0;
      const msg = err instanceof Error ? err.message : String(err);
      deps.logError?.(
        `mail send failed: template=${template ?? '-'} to=${to} error=${msg}`,
      );
      try {
        deps.onSendResult?.({
          ok: false,
          to,
          subject,
          template: template ?? null,
          error: msg,
          elapsedMs,
        });
      } catch (hookErr) {
        deps.logError?.(`onSendResult hook threw (fail path): ${(hookErr as Error).message}`);
      }
      return jsonResponse({ error: msg }, 500);
    }
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Single-email RFC 5322-ish check. Rejects:
 * - comma-separated lists ('a@b.c, attacker@evil.com')
 * - display-name syntax ('Display Name <email>')
 * - CRLF injection (header smuggling)
 * - missing @ or local/domain
 *
 * Intentionally strict — for system-generated transactional email there's no
 * legitimate need for multi-recipient or display-name on this internal endpoint.
 */
function isPlainEmail(addr: string): boolean {
  if (typeof addr !== 'string' || addr.length === 0 || addr.length > 254) return false;
  // Reject any control char (including CR/LF), comma, angle bracket, quote, semicolon
  if (/[\r\n,<>\";]/.test(addr)) return false;
  // Basic shape: local@domain.tld with at least one dot in domain
  return /^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/.test(addr);
}
