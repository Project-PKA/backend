import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';

let app: FastifyInstance | undefined;

async function start(checkDatabase: () => Promise<void> = () => Promise.resolve()) {
  app = await buildApp({ env: { logLevel: 'silent', serviceName: 'test' }, checkDatabase });
  await app.ready();
  return app;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('GET /health', () => {
  it('responde 200 sem depender do banco', async () => {
    const server = await start(() => Promise.reject(new Error('banco fora')));

    const response = await server.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });
});

describe('GET /ready', () => {
  it('responde 200 quando o banco responde', async () => {
    const server = await start();

    const response = await server.inject({ method: 'GET', url: '/ready' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ready' });
  });

  it('responde 503 em problem+json quando o banco não responde', async () => {
    const server = await start(() => Promise.reject(new Error('conexão recusada')));

    const response = await server.inject({ method: 'GET', url: '/ready' });

    expect(response.statusCode).toBe(503);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.json()).toMatchObject({ status: 503, code: 'DATABASE_UNAVAILABLE' });
    // Não vaza a mensagem interna do erro.
    expect(response.body).not.toContain('conexão recusada');
  });
});

describe('GET /metrics', () => {
  it('expõe métricas no formato Prometheus', async () => {
    const server = await start();

    const response = await server.inject({ method: 'GET', url: '/metrics' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.body).toContain('process_cpu_user_seconds_total');
  });
});

describe('rota inexistente', () => {
  it('responde 404 em problem+json', async () => {
    const server = await start();

    const response = await server.inject({ method: 'GET', url: '/nao-existe' });

    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.json()).toMatchObject({ status: 404, instance: '/nao-existe' });
  });
});

describe('trace_id', () => {
  it('reaproveita o trace id do header traceparent', async () => {
    // Sem `start()`: o hook precisa entrar antes de o servidor ficar pronto.
    app = await buildApp({
      env: { logLevel: 'silent', serviceName: 'test' },
      checkDatabase: () => Promise.resolve(),
    });
    const server = app;
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    let seen = '';
    server.addHook('onRequest', (request, _reply, done) => {
      seen = request.id;
      done();
    });

    await server.inject({
      method: 'GET',
      url: '/health',
      headers: { traceparent: `00-${traceId}-00f067aa0ba902b7-01` },
    });

    expect(seen).toBe(traceId);
  });
});
