import { describe, expect, it } from 'vitest';

import { SmtpEmailSender, type MailTransport } from '../src/auth/smtp.js';

const config = {
  host: 'localhost',
  port: 1025,
  secure: false,
  user: null,
  password: null,
  from: 'no-reply@example.test',
};

function fake(fail?: Error): {
  transport: MailTransport;
  sent: Record<string, string>[];
  errors: unknown[];
} {
  const sent: Record<string, string>[] = [];
  const errors: unknown[] = [];
  return {
    sent,
    errors,
    transport: {
      sendMail: (mail) => {
        if (fail !== undefined) return Promise.reject(fail);
        sent.push(mail);
        return Promise.resolve({});
      },
    },
  };
}

// Código de erro do nodemailer (não é um código da API).
const smtpCode = 'EAUTH';

describe('SmtpEmailSender', () => {
  it('envia o código de acesso com remetente, assunto e corpo em texto e HTML', async () => {
    const { transport, sent } = fake();
    const sender = new SmtpEmailSender(config, () => ({ error: () => undefined }), transport);

    await sender.sendOtp({ to: 'cliente@example.test', code: '123456', expiresInMinutes: 10 });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      from: 'no-reply@example.test',
      to: 'cliente@example.test',
      subject: 'Seu código de acesso',
    });
    expect(sent[0]?.['text']).toContain('123456');
    expect(sent[0]?.['text']).toContain('10 minutos');
    expect(sent[0]?.['html']).toContain('123456');
  });

  it('envia o convite com o link e escapa o nome da loja no HTML', async () => {
    const { transport, sent } = fake();
    const sender = new SmtpEmailSender(config, () => ({ error: () => undefined }), transport);

    await sender.sendInvitation({
      to: 'novo@example.test',
      link: 'https://app.example.test/invite#token=abc',
      storeName: '<b>Loja</b>',
      role: 'STAFF',
      expiresAt: new Date('2026-11-01T12:00:00Z'),
    });

    const mail = sent[0];
    expect(mail?.['text']).toContain('https://app.example.test/invite#token=abc');
    expect(mail?.['text']).toContain('2026-11-01');
    expect(mail?.['html']).toContain('&lt;b&gt;Loja&lt;/b&gt;');
    expect(mail?.['html']).not.toContain('<b>Loja</b>');
  });

  it('registra a falha sem destinatário nem código e a relança', async () => {
    const boom = Object.assign(new Error('auth failed for cliente@example.test'), {
      code: smtpCode,
    });
    const { transport } = fake(boom);
    const logged: Record<string, unknown>[] = [];
    const sender = new SmtpEmailSender(
      config,
      () => ({
        error: (o) => {
          logged.push(o);
        },
      }),
      transport,
    );

    await expect(
      sender.sendOtp({ to: 'cliente@example.test', code: '654321', expiresInMinutes: 10 }),
    ).rejects.toThrow('auth failed');
    expect(logged).toEqual([{ code: smtpCode }]);
    expect(JSON.stringify(logged)).not.toContain('cliente@example.test');
  });
});
