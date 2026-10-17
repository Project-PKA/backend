export interface OtpMessage {
  to: string;
  code: string;
  expiresInMinutes: number;
}

export interface InvitationMessage {
  to: string;
  /** Link com o token no fragmento (#), que não vai para log de servidor nem Referer. */
  link: string;
  storeName: string | null;
  role: 'OWNER' | 'STAFF' | null;
  expiresAt: Date;
}

/** Porta de envio de e-mail. O provedor real entra depois, sem mexer no resto. */
export interface EmailSender {
  sendOtp: (message: OtpMessage) => Promise<void>;
  sendInvitation: (message: InvitationMessage) => Promise<void>;
}

interface LoggerLike {
  info: (object: Record<string, unknown>, message: string) => void;
}

/**
 * SÓ DESENVOLVIMENTO: escreve o código e o link no log local, no lugar de enviar
 * e-mail. `loadEnv` recusa este provedor em homolog e prod.
 */
export class LogEmailSender implements EmailSender {
  constructor(private readonly logger: () => LoggerLike) {}

  sendOtp(message: OtpMessage): Promise<void> {
    this.logger().info({ to: message.to, code: message.code }, '[DEV] código OTP');
    return Promise.resolve();
  }

  sendInvitation(message: InvitationMessage): Promise<void> {
    this.logger().info({ to: message.to, link: message.link }, '[DEV] convite');
    return Promise.resolve();
  }
}

/** Guarda as mensagens em memória, para os testes lerem o código e o link. */
export class MemoryEmailSender implements EmailSender {
  readonly otps: OtpMessage[] = [];
  readonly invitations: InvitationMessage[] = [];

  sendOtp(message: OtpMessage): Promise<void> {
    this.otps.push(message);
    return Promise.resolve();
  }

  sendInvitation(message: InvitationMessage): Promise<void> {
    this.invitations.push(message);
    return Promise.resolve();
  }

  lastOtpFor(email: string): OtpMessage | undefined {
    return this.otps.findLast((item) => item.to === email);
  }

  lastInvitationFor(email: string): InvitationMessage | undefined {
    return this.invitations.findLast((item) => item.to === email);
  }
}
