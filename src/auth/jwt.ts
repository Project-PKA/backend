import { jwtVerify, SignJWT } from 'jose';

import type { AuthConfig } from '../config/env.js';

const encoder = new TextEncoder();

export interface AccessToken {
  token: string;
  expiresIn: number;
}

/** JWT de acesso curto. O algoritmo é fixo no servidor (HS256), nunca vem do token. */
export async function signAccessToken(
  config: AuthConfig,
  userId: string,
  now: Date = new Date(),
): Promise<AccessToken> {
  const issuedAt = Math.floor(now.getTime() / 1000);
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuer(config.issuer)
    .setAudience(config.audience)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + config.accessTtlSeconds)
    .sign(encoder.encode(config.accessSecret));
  return { token, expiresIn: config.accessTtlSeconds };
}

/** Devolve o id do usuário, ou `null` para qualquer token inválido ou vencido. */
export async function verifyAccessToken(
  config: AuthConfig,
  token: string,
  now: Date = new Date(),
): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, encoder.encode(config.accessSecret), {
      algorithms: ['HS256'],
      issuer: config.issuer,
      audience: config.audience,
      currentDate: now,
    });
    return typeof payload.sub === 'string' ? payload.sub : null;
  } catch {
    return null;
  }
}
