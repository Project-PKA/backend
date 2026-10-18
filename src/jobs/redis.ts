import type { ConnectionOptions } from 'bullmq';

/**
 * Converte `REDIS_URL` (`redis://:senha@host:6379/0` ou `rediss://...`) nas opções do BullMQ.
 * A senha nunca aparece na mensagem de erro.
 */
export function parseRedisUrl(value: string): ConnectionOptions {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('REDIS_URL inválida: use redis://[:senha@]host[:porta][/banco]');
  }
  if (url.protocol !== 'redis:' && url.protocol !== 'rediss:') {
    throw new Error('REDIS_URL inválida: o esquema deve ser redis:// ou rediss://');
  }
  if (url.hostname === '') throw new Error('REDIS_URL inválida: falta o host');
  const db = url.pathname.length > 1 ? Number(url.pathname.slice(1)) : 0;
  if (!Number.isInteger(db) || db < 0 || db > 15) {
    throw new Error('REDIS_URL inválida: o banco deve ser um inteiro entre 0 e 15');
  }
  return {
    host: url.hostname,
    port: url.port === '' ? 6379 : Number(url.port),
    ...(url.password === '' ? {} : { password: decodeURIComponent(url.password) }),
    ...(url.username === '' ? {} : { username: decodeURIComponent(url.username) }),
    db,
    ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
  };
}
