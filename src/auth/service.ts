import { and, desc, eq, gt, isNull } from 'drizzle-orm';

import type { AuthConfig } from '../config/env.js';
import type { Db, Tx } from '../db/context.js';
import * as schema from '../db/schema.js';
import {
  DUMMY_HASH,
  generateOtpCode,
  hashOtp,
  hashToken,
  newToken,
  safeEqualHex,
} from './crypto.js';
import type { EmailSender } from './email.js';
import { signAccessToken } from './jwt.js';

const { users, refreshTokens } = schema;

export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}

export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
}

export interface Session {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  refreshExpiresAt: Date;
  user: SessionUser;
}

export interface SessionInfo {
  id: string;
  createdAt: Date;
  userAgent: string | null;
  ip: string | null;
  current: boolean;
}

interface LoggerLike {
  error: (object: Record<string, unknown>, message: string) => void;
}

export interface AuthServiceDeps {
  db: Db;
  config: AuthConfig;
  email: EmailSender;
  log: LoggerLike;
  now?: () => Date;
}

export const normalizeEmail = (email: string): string => email.trim().toLowerCase();
const clip = (value: string | null, max: number): string | null =>
  value === null ? null : value.slice(0, max);

/**
 * Login por OTP, sessão (JWT curto + refresh rotacionado) e revogação.
 * Acesso é só por convite (ADR 0012): e-mail sem conta ativa recebe a mesma
 * resposta e nenhum código.
 */
export class AuthService {
  private readonly pending = new Set<Promise<void>>();

  constructor(private readonly deps: AuthServiceDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** Espera os e-mails em andamento (usado nos testes e no encerramento). */
  async flush(): Promise<void> {
    await Promise.all([...this.pending]);
  }

  private dispatch(task: Promise<void>, what: string): void {
    // O envio não é aguardado: o tempo de resposta não revela se a conta existe.
    const guarded = task
      .catch((err: unknown) => {
        this.deps.log.error({ err }, `falha ao enviar ${what}`);
      })
      .finally(() => {
        this.pending.delete(guarded);
      });
    this.pending.add(guarded);
  }

  /** Pede um código. Sempre "funciona" por fora; só envia se a conta estiver ativa. */
  async requestOtp(rawEmail: string): Promise<void> {
    const { db, config } = this.deps;
    const email = normalizeEmail(rawEmail);
    const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (user?.status !== 'ACTIVE') return;

    const now = this.now();
    if (user.otpHash !== null && user.otpExpiresAt !== null) {
      const issuedAt = user.otpExpiresAt.getTime() - config.otpTtlSeconds * 1000;
      if (now.getTime() - issuedAt < config.otpResendSeconds * 1000) return;
    }

    const code = generateOtpCode();
    await db
      .update(users)
      .set({
        otpHash: hashOtp(config.otpSecret, email, code),
        otpExpiresAt: new Date(now.getTime() + config.otpTtlSeconds * 1000),
        otpAttempts: 0,
      })
      .where(eq(users.id, user.id));

    this.dispatch(
      this.deps.email.sendOtp({
        to: email,
        code,
        expiresInMinutes: Math.ceil(config.otpTtlSeconds / 60),
      }),
      'OTP',
    );
  }

  /** Confere o código e abre a sessão. `null` para qualquer falha, sem dizer o motivo. */
  async verifyOtp(rawEmail: string, code: string, meta: RequestMeta): Promise<Session | null> {
    const { db, config } = this.deps;
    const email = normalizeEmail(rawEmail);
    const now = this.now();

    const outcome = await db.transaction(async (tx) => {
      const [user] = await tx
        .select()
        .from(users)
        .where(eq(users.email, email))
        .for('update')
        .limit(1);

      // Mesmo custo com ou sem conta: o hash é sempre calculado e comparado.
      const candidate = hashOtp(config.otpSecret, email, code);
      const same = safeEqualHex(candidate, user?.otpHash ?? DUMMY_HASH);
      const usable =
        user !== undefined &&
        user.status === 'ACTIVE' &&
        user.otpHash !== null &&
        user.otpExpiresAt !== null &&
        user.otpExpiresAt > now &&
        user.otpAttempts < config.otpMaxAttempts;

      if (!usable) return null;
      if (!same) {
        const attempts = user.otpAttempts + 1;
        // Esgotou as tentativas: o código deixa de valer (precisa pedir outro).
        await tx
          .update(users)
          .set(
            attempts >= config.otpMaxAttempts
              ? { otpAttempts: attempts, otpHash: null, otpExpiresAt: null }
              : { otpAttempts: attempts },
          )
          .where(eq(users.id, user.id));
        return null;
      }

      await tx
        .update(users)
        .set({ otpHash: null, otpExpiresAt: null, otpAttempts: 0, lastLoginAt: now })
        .where(eq(users.id, user.id));
      const refresh = await this.issueRefresh(tx, user.id, meta, now);
      return { user: { id: user.id, email: user.email, name: user.name }, ...refresh };
    });

    return outcome === null ? null : this.buildSession(outcome, now);
  }

  /**
   * Troca o refresh token por um novo (rotação). Reusar um token já trocado é
   * sinal de roubo: todas as sessões da pessoa são revogadas.
   */
  async refresh(rawToken: string, meta: RequestMeta): Promise<Session | null> {
    const { db, config } = this.deps;
    const now = this.now();
    const tokenHash = hashToken(config.refreshPepper, 'refresh', rawToken);

    const outcome = await db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(refreshTokens)
        .where(eq(refreshTokens.tokenHash, tokenHash))
        .for('update')
        .limit(1);
      if (row === undefined) return null;

      if (row.revokedAt !== null) {
        await this.revokeAllIn(tx, row.userId, now);
        return null;
      }
      const [user] = await tx.select().from(users).where(eq(users.id, row.userId)).limit(1);
      if (row.expiresAt <= now || user?.status !== 'ACTIVE') {
        await tx.update(refreshTokens).set({ revokedAt: now }).where(eq(refreshTokens.id, row.id));
        return null;
      }

      await tx.update(refreshTokens).set({ revokedAt: now }).where(eq(refreshTokens.id, row.id));
      const next = await this.issueRefresh(tx, user.id, meta, now);
      return { user: { id: user.id, email: user.email, name: user.name }, ...next };
    });

    return outcome === null ? null : this.buildSession(outcome, now);
  }

  /** Encerra a sessão do refresh token apresentado. Silencioso se ele não existir. */
  async logout(rawToken: string): Promise<void> {
    const tokenHash = hashToken(this.deps.config.refreshPepper, 'refresh', rawToken);
    await this.deps.db
      .update(refreshTokens)
      .set({ revokedAt: this.now() })
      .where(and(eq(refreshTokens.tokenHash, tokenHash), isNull(refreshTokens.revokedAt)));
  }

  async listSessions(userId: string, currentRawToken: string | null): Promise<SessionInfo[]> {
    const currentHash =
      currentRawToken === null
        ? null
        : hashToken(this.deps.config.refreshPepper, 'refresh', currentRawToken);
    const rows = await this.deps.db
      .select()
      .from(refreshTokens)
      .where(
        and(
          eq(refreshTokens.userId, userId),
          isNull(refreshTokens.revokedAt),
          gt(refreshTokens.expiresAt, this.now()),
        ),
      )
      .orderBy(desc(refreshTokens.createdAt));
    return rows.map((row) => ({
      id: row.id,
      createdAt: row.createdAt,
      userAgent: row.userAgent,
      ip: row.ip,
      current: currentHash !== null && row.tokenHash === currentHash,
    }));
  }

  /** Revoga uma sessão da própria pessoa. `false` se não existir ou for de outra. */
  async revokeSession(userId: string, sessionId: string): Promise<boolean> {
    const result = await this.deps.db
      .update(refreshTokens)
      .set({ revokedAt: this.now() })
      .where(
        and(
          eq(refreshTokens.id, sessionId),
          eq(refreshTokens.userId, userId),
          isNull(refreshTokens.revokedAt),
        ),
      )
      .returning({ id: refreshTokens.id });
    return result.length > 0;
  }

  /** Revoga todas as sessões (suspensão de conta, reuso de token). */
  async revokeAllSessions(userId: string): Promise<void> {
    await this.revokeAllIn(this.deps.db, userId, this.now());
  }

  private async revokeAllIn(tx: Db | Tx, userId: string, now: Date): Promise<void> {
    await tx
      .update(refreshTokens)
      .set({ revokedAt: now })
      .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
  }

  private async issueRefresh(
    tx: Tx,
    userId: string,
    meta: RequestMeta,
    now: Date,
  ): Promise<{ refreshToken: string; refreshExpiresAt: Date }> {
    const { config } = this.deps;
    const refreshToken = newToken();
    const refreshExpiresAt = new Date(now.getTime() + config.refreshTtlDays * 86_400_000);
    await tx.insert(refreshTokens).values({
      userId,
      tokenHash: hashToken(config.refreshPepper, 'refresh', refreshToken),
      expiresAt: refreshExpiresAt,
      userAgent: clip(meta.userAgent, 255),
      ip: clip(meta.ip, 64),
    });
    return { refreshToken, refreshExpiresAt };
  }

  private async buildSession(
    parts: { user: SessionUser; refreshToken: string; refreshExpiresAt: Date },
    now: Date,
  ): Promise<Session> {
    const access = await signAccessToken(this.deps.config, parts.user.id, now);
    return {
      accessToken: access.token,
      expiresIn: access.expiresIn,
      refreshToken: parts.refreshToken,
      refreshExpiresAt: parts.refreshExpiresAt,
      user: parts.user,
    };
  }
}
