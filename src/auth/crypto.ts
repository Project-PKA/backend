import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/** HMAC-SHA256 em hexadecimal. */
function hmac(key: string, data: string): string {
  return createHmac('sha256', key).update(data).digest('hex');
}

/** Código numérico de 6 dígitos, de gerador criptográfico (nunca `Math.random`). */
export function generateOtpCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/**
 * Token opaco e aleatório de 256 bits, em base64url. Serve para refresh token e
 * convite. Só o hash vai para o banco.
 */
export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Hash do OTP amarrado ao e-mail: o mesmo código em contas diferentes gera
 * hashes diferentes, e sem a chave o hash não pode ser recalculado.
 */
export function hashOtp(secret: string, email: string, code: string): string {
  return hmac(secret, `otp:${email}:${code}`);
}

/** Hash de refresh token e de convite. O prefixo separa os domínios. */
export function hashToken(pepper: string, kind: 'refresh' | 'invitation', token: string): string {
  return hmac(pepper, `${kind}:${token}`);
}

/** Comparação em tempo constante de dois hashes hexadecimais. */
export function safeEqualHex(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Hash de mesmo formato usado quando a conta não existe, para o custo ser igual. */
export const DUMMY_HASH = '0'.repeat(64);
