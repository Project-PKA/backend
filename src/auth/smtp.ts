import nodemailer from 'nodemailer';

import type { SmtpConfig } from '../config/env.js';
import type { EmailSender, InvitationMessage, OtpMessage } from './email.js';

/** O que o enviador precisa do nodemailer (permite trocar por um transporte falso nos testes). */
export interface MailTransport {
  sendMail: (mail: {
    from: string;
    to: string;
    subject: string;
    text: string;
    html: string;
  }) => Promise<unknown>;
}

interface LoggerLike {
  error: (object: Record<string, unknown>, message: string) => void;
}

const escapeHtml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

const ROLE_LABEL = { OWNER: 'dono', STAFF: 'equipe' } as const;

export function createTransport(config: SmtpConfig): MailTransport {
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    ...(config.user !== null && config.password !== null
      ? { auth: { user: config.user, pass: config.password } }
      : {}),
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
}

/**
 * Envia por SMTP (Gmail com senha de app em produção; Mailpit no desenvolvimento).
 * Falha de envio é registrada SEM o destinatário nem o conteúdo (o código e o link são segredos)
 * e relançada, para a rota responder erro em vez de fingir que enviou.
 */
export class SmtpEmailSender implements EmailSender {
  private readonly transport: MailTransport;

  constructor(
    private readonly config: SmtpConfig,
    private readonly logger: () => LoggerLike,
    transport?: MailTransport,
  ) {
    this.transport = transport ?? createTransport(config);
  }

  async sendOtp(message: OtpMessage): Promise<void> {
    const text = [
      `Seu código de acesso é ${message.code}.`,
      `Ele vale por ${String(message.expiresInMinutes)} minutos e só pode ser usado uma vez.`,
      'Se você não pediu este código, ignore este e-mail.',
    ].join('\n\n');
    const html = `<p>Seu código de acesso é <strong style="font-size:1.4em;letter-spacing:.15em">${escapeHtml(message.code)}</strong>.</p><p>Ele vale por ${String(message.expiresInMinutes)} minutos e só pode ser usado uma vez.</p><p>Se você não pediu este código, ignore este e-mail.</p>`;
    await this.deliver(message.to, 'Seu código de acesso', text, html);
  }

  async sendInvitation(message: InvitationMessage): Promise<void> {
    const where = message.storeName === null ? 'à plataforma' : `à loja ${message.storeName}`;
    const role = message.role === null ? '' : ` como ${ROLE_LABEL[message.role]}`;
    const until = message.expiresAt.toISOString().slice(0, 10);
    const text = [
      `Você foi convidado ${where}${role}.`,
      `Para aceitar, abra: ${message.link}`,
      `O convite vale até ${until}.`,
    ].join('\n\n');
    const html = `<p>Você foi convidado ${escapeHtml(where)}${escapeHtml(role)}.</p><p><a href="${escapeHtml(message.link)}">Aceitar o convite</a></p><p>O convite vale até ${until}.</p>`;
    await this.deliver(message.to, 'Você recebeu um convite', text, html);
  }

  private async deliver(to: string, subject: string, text: string, html: string): Promise<void> {
    try {
      await this.transport.sendMail({ from: this.config.from, to, subject, text, html });
    } catch (error) {
      this.logger().error(
        { code: (error as { code?: string }).code ?? 'SMTP_FAILED' },
        'falha ao enviar e-mail',
      );
      throw error;
    }
  }
}
