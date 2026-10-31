/**
 * mailer-handler onSendResult hook — v2.33.128 PR5 G2
 *
 * 失敗 → throttledAlert + 含 to/template/error context；user 手動重 trigger。
 * 成功 → throttledAlert healthy (recovery 從 failed → healthy 自動發 alert)。
 */
import { describe, it, expect, vi } from 'vitest';
import { makeMailHandler, type MailHandlerDeps, type MailSendResult } from '../../scripts/lib/mailer-handler';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function buildReq(body: object): Request {
  return new Request('http://localhost/internal/mail/send', {
    method: 'POST',
    headers: { Authorization: 'Bearer test' },
    body: JSON.stringify(body),
  });
}

function baseDeps(overrides: Partial<MailHandlerDeps> = {}): MailHandlerDeps {
  return {
    verifyAuth: () => true,
    emailFrom: 'test@example.com',
    transporter: () =>
      ({
        sendMail: vi.fn().mockResolvedValue({ messageId: 'msg-1' }),
      }) as unknown as ReturnType<MailHandlerDeps['transporter']>,
    log: vi.fn(),
    logError: vi.fn(),
    ...overrides,
  };
}

describe('onSendResult hook — success path', () => {
  it('fire 含 ok=true + messageId + elapsedMs + template', async () => {
    const results: MailSendResult[] = [];
    const handler = makeMailHandler(
      baseDeps({ onSendResult: (r) => results.push(r) }),
    );
    const res = await handler(
      buildReq({
        to: 'user@example.com',
        subject: 'hi',
        html: '<p>hi</p>',
        template: 'invitation',
      }),
    );
    expect(res.status).toBe(200);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      ok: true,
      to: 'user@example.com',
      subject: 'hi',
      template: 'invitation',
      messageId: 'msg-1',
    });
    expect(results[0].elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('hook 拋例外不影響 HTTP response（log only）', async () => {
    const logError = vi.fn();
    const handler = makeMailHandler(
      baseDeps({
        logError,
        onSendResult: () => {
          throw new Error('hook boom');
        },
      }),
    );
    const res = await handler(
      buildReq({ to: 'u@e.com', subject: 's', html: '<p>x</p>', template: 't' }),
    );
    expect(res.status).toBe(200);
    expect(logError).toHaveBeenCalledWith(
      expect.stringContaining('onSendResult hook threw (ok path): hook boom'),
    );
  });
});

describe('onSendResult hook — failure path', () => {
  it('fire 含 ok=false + error + 仍含 to/template', async () => {
    const results: MailSendResult[] = [];
    const handler = makeMailHandler(
      baseDeps({
        transporter: () =>
          ({
            sendMail: vi.fn().mockRejectedValue(new Error('SMTP timeout')),
          }) as unknown as ReturnType<MailHandlerDeps['transporter']>,
        onSendResult: (r) => results.push(r),
      }),
    );
    const res = await handler(
      buildReq({
        to: 'user@example.com',
        subject: 'reset',
        html: '<p>reset</p>',
        template: 'password-reset',
      }),
    );
    expect(res.status).toBe(500);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      ok: false,
      to: 'user@example.com',
      subject: 'reset',
      template: 'password-reset',
      error: 'SMTP timeout',
    });
  });

  it('failure hook 拋例外不影響 HTTP 500 response', async () => {
    const logError = vi.fn();
    const handler = makeMailHandler(
      baseDeps({
        transporter: () =>
          ({
            sendMail: vi.fn().mockRejectedValue(new Error('SMTP timeout')),
          }) as unknown as ReturnType<MailHandlerDeps['transporter']>,
        logError,
        onSendResult: () => {
          throw new Error('hook fail');
        },
      }),
    );
    const res = await handler(
      buildReq({ to: 'u@e.com', subject: 's', html: '<p>x</p>', template: 't' }),
    );
    expect(res.status).toBe(500);
    expect(logError).toHaveBeenCalledWith(
      expect.stringContaining('onSendResult hook threw (fail path): hook fail'),
    );
  });
});

describe('api-server 注入 throttledAlert (source-grep)', () => {
  const SRC = readFileSync(
    join(__dirname, '../../scripts/tripline-api-server.ts'),
    'utf8',
  );

  it('makeMailHandler call 帶 onSendResult callback', () => {
    expect(SRC).toMatch(/onSendResult: \(result\) =>/);
  });

  it('成功 path：throttledAlert key=mail-{template} state=healthy', () => {
    expect(SRC).toMatch(/`mail-\$\{result\.template \?\? 'unknown'\}`/);
    expect(SRC).toMatch(/恢復寄送/);
  });

  it('失敗 path：alert 含 template/to/subject(80)/error(200)/重發 hint', () => {
    expect(SRC).toMatch(/template=\$\{result\.template \?\? '-'\} to=\$\{result\.to\}/);
    expect(SRC).toMatch(/subject=\$\{result\.subject\.slice\(0, 80\)\}/);
    expect(SRC).toMatch(/error=\$\{\(result\.error \?\? 'unknown'\)\.slice\(0, 200\)\}/);
    expect(SRC).toMatch(/user 可重新 trigger 該流程/);
  });

  it('per-template key（不同 template 失敗各自 1hr throttle）', () => {
    expect(SRC).toMatch(/key per template/);
  });
});
