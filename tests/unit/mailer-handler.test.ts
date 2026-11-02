/**
 * mailer-handler unit tests
 * 驗證 POST /internal/mail/send 處理邏輯（auth / body validation / SMTP / 錯誤）
 */
import { describe, it, expect, vi } from 'vitest';
import { makeMailHandler } from '../../scripts/lib/mailer-handler';

const FAKE_MESSAGE = { messageId: 'fake-id-12345' };

function makeReq(
  body: unknown,
  opts: { auth?: string | null; bodyOverride?: string } = {},
): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.auth !== null && opts.auth !== undefined) headers.Authorization = opts.auth;
  return new Request('http://localhost/internal/mail/send', {
    method: 'POST',
    headers,
    body: opts.bodyOverride ?? JSON.stringify(body),
  });
}

interface DepsOverrides {
  sendMail?: ReturnType<typeof vi.fn>;
  verifyAuth?: ReturnType<typeof vi.fn>;
  emailFrom?: string;
  log?: ReturnType<typeof vi.fn>;
  logError?: ReturnType<typeof vi.fn>;
}

function makeDeps(overrides: DepsOverrides = {}) {
  const sendMail = overrides.sendMail ?? vi.fn().mockResolvedValue(FAKE_MESSAGE);
  const verifyAuth = overrides.verifyAuth ?? vi.fn().mockReturnValue(true);
  const log = overrides.log ?? vi.fn();
  const logError = overrides.logError ?? vi.fn();
  // Cast through unknown to satisfy nodemailer Transporter shape (test mock only uses sendMail).
  const fakeTransporter = { sendMail } as unknown as import('nodemailer').Transporter;
  return {
    deps: {
      verifyAuth,
      transporter: () => fakeTransporter,
      emailFrom: overrides.emailFrom ?? 'Tripline <noreply@example.com>',
      log,
      logError,
    },
    sendMail,
    verifyAuth,
    log,
    logError,
  };
}

describe('makeMailHandler', () => {
  it('returns 401 when verifyAuth fails', async () => {
    const { deps, verifyAuth } = makeDeps({ verifyAuth: vi.fn().mockReturnValue(false) });
    const handler = makeMailHandler(deps);
    const res = await handler(makeReq({ to: 'a@b.co', subject: 's', html: '<p>h</p>' }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
    expect(verifyAuth).toHaveBeenCalledOnce();
  });

  it('returns 400 on bad json', async () => {
    const { deps } = makeDeps();
    const handler = makeMailHandler(deps);
    const res = await handler(makeReq({}, { bodyOverride: 'not-json{' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('bad json');
  });

  it('returns 400 when "to" missing', async () => {
    const { deps } = makeDeps();
    const handler = makeMailHandler(deps);
    const res = await handler(makeReq({ subject: 's', html: 'h' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/missing to\/subject\/html/);
  });

  it('returns 400 when "subject" missing', async () => {
    const { deps } = makeDeps();
    const handler = makeMailHandler(deps);
    const res = await handler(makeReq({ to: 'a@b.co', html: 'h' }));
    expect(res.status).toBe(400);
  });

  it('returns 400 when "html" missing', async () => {
    const { deps } = makeDeps();
    const handler = makeMailHandler(deps);
    const res = await handler(makeReq({ to: 'a@b.co', subject: 's' }));
    expect(res.status).toBe(400);
  });

  it('sends mail and returns ok with messageId + elapsed + template', async () => {
    const { deps, sendMail, log } = makeDeps();
    const handler = makeMailHandler(deps);
    const res = await handler(
      makeReq({
        to: 'user@example.com',
        subject: '驗證信',
        html: '<p>請點擊連結驗證</p>',
        template: 'verification',
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.messageId).toBe('fake-id-12345');
    expect(typeof body.elapsed).toBe('number');
    expect(body.template).toBe('verification');
    expect(sendMail).toHaveBeenCalledWith({
      from: 'Tripline <noreply@example.com>',
      to: 'user@example.com',
      subject: '驗證信',
      html: '<p>請點擊連結驗證</p>',
    });
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/mail sent.*template=verification.*to=user@example.com/));
  });

  it('uses configured emailFrom override', async () => {
    const { deps, sendMail } = makeDeps({ emailFrom: 'Custom <custom@example.com>' });
    const handler = makeMailHandler(deps);
    await handler(makeReq({ to: 'a@b.co', subject: 's', html: 'h' }));
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ from: 'Custom <custom@example.com>' }),
    );
  });

  it('returns 500 + error msg + logError when transporter throws', async () => {
    const sendMail = vi.fn().mockRejectedValue(new Error('SMTP server unreachable'));
    const { deps, logError } = makeDeps({ sendMail });
    const handler = makeMailHandler(deps);
    const res = await handler(
      makeReq({ to: 'a@b.co', subject: 's', html: 'h', template: 'forgot-password' }),
    );
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('SMTP server unreachable');
    expect(logError).toHaveBeenCalledWith(
      expect.stringMatching(/mail send failed.*template=forgot-password.*to=a@b.c.*SMTP server unreachable/),
    );
  });

  it('sets template to null when not provided', async () => {
    const { deps } = makeDeps();
    const handler = makeMailHandler(deps);
    const res = await handler(makeReq({ to: 'a@b.co', subject: 's', html: 'h' }));
    expect((await res.json()).template).toBeNull();
  });

  it('logs success without template hint when omitted', async () => {
    const { deps, log } = makeDeps();
    const handler = makeMailHandler(deps);
    await handler(makeReq({ to: 'a@b.co', subject: 's', html: 'h' }));
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/template=-/));
  });

  it('forwards text fallback to nodemailer when provided', async () => {
    const { deps, sendMail } = makeDeps();
    const handler = makeMailHandler(deps);
    await handler(
      makeReq({ to: 'a@b.co', subject: 's', html: '<p>h</p>', text: 'plain h' }),
    );
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ html: '<p>h</p>', text: 'plain h' }),
    );
  });

  it('omits text key from sendMail when not provided', async () => {
    const { deps, sendMail } = makeDeps();
    const handler = makeMailHandler(deps);
    await handler(makeReq({ to: 'a@b.co', subject: 's', html: '<p>h</p>' }));
    const callArgs = sendMail.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs.text).toBeUndefined();
  });

  // Open-relay defense: validate `to` is single plain email (not list / display-name / CRLF)
  describe('to validation (open-relay defense)', () => {
    it('rejects comma-separated recipient list (BCC injection)', async () => {
      const { deps, sendMail } = makeDeps();
      const handler = makeMailHandler(deps);
      const res = await handler(makeReq({
        to: 'victim@example.com, attacker@evil.com',
        subject: 's', html: 'h',
      }));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/single plain email/);
      expect(sendMail).not.toHaveBeenCalled();
    });

    it('rejects "Display Name <email>" syntax (RFC 5322 list)', async () => {
      const { deps, sendMail } = makeDeps();
      const handler = makeMailHandler(deps);
      const res = await handler(makeReq({
        to: 'Display Name <a@b.c>',
        subject: 's', html: 'h',
      }));
      expect(res.status).toBe(400);
      expect(sendMail).not.toHaveBeenCalled();
    });

    it('rejects CRLF injection in to field (header smuggling)', async () => {
      const { deps, sendMail } = makeDeps();
      const handler = makeMailHandler(deps);
      const res = await handler(makeReq({
        to: 'a@b.c\r\nBcc: attacker@evil.com',
        subject: 's', html: 'h',
      }));
      expect(res.status).toBe(400);
      expect(sendMail).not.toHaveBeenCalled();
    });

    it('rejects malformed email (no @)', async () => {
      const { deps, sendMail } = makeDeps();
      const handler = makeMailHandler(deps);
      const res = await handler(makeReq({ to: 'not-an-email', subject: 's', html: 'h' }));
      expect(res.status).toBe(400);
      expect(sendMail).not.toHaveBeenCalled();
    });

    it('rejects empty to (already covered by missing check, but trips here too)', async () => {
      const { deps, sendMail } = makeDeps();
      const handler = makeMailHandler(deps);
      const res = await handler(makeReq({ to: '', subject: 's', html: 'h' }));
      expect(res.status).toBe(400);
      expect(sendMail).not.toHaveBeenCalled();
    });

    it('accepts valid plain email with plus sign + dots', async () => {
      const { deps, sendMail } = makeDeps();
      const handler = makeMailHandler(deps);
      const res = await handler(makeReq({
        to: 'user.name+tag@example.co.jp',
        subject: 's', html: 'h',
      }));
      expect(res.status).toBe(200);
      expect(sendMail).toHaveBeenCalledOnce();
    });
  });

  // Value: protects=handler 送出的 sendMail 參數被真實 nodemailer 接受並組成 MIME; fails_when=nodemailer 升級改變 sendMail 參數或 MIME 組信行為; why_new=其餘案例全 mock transporter; seam=none
  // dependabot 會自動合併 patch/minor，上面 mock 的案例抓不到 nodemailer 本身改壞。
  // ponytail: streamTransport 只組信不連 SMTP，SMTP 連線 / STARTTLS / 登入路徑不在此測；要測得起本地 fake SMTP server。
  it('builds a real MIME message through actual nodemailer (dependency contract)', async () => {
    const nodemailer = (await import('nodemailer')).default;
    const transporter = nodemailer.createTransport({ streamTransport: true, buffer: true });
    const handler = makeMailHandler({
      verifyAuth: () => true,
      transporter: () => transporter,
      emailFrom: 'Tripline <noreply@example.com>',
    });
    const sendMail = vi.spyOn(transporter, 'sendMail');
    const res = await handler(makeReq({ to: 'user@example.com', subject: '驗證信', html: '<p>hi</p>', text: 'hi' }));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    const mime = String(((await sendMail.mock.results[0].value) as { message: Buffer }).message);
    expect(mime).toMatch(/^To: user@example\.com$/m);
    expect(mime).toMatch(/^From: Tripline <noreply@example\.com>$/m);
    expect(mime).toContain('Subject: =?UTF-8?');
    expect(mime).toContain('<p>hi</p>');
  });
});
