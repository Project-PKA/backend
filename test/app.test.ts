import { afterEach, describe, expect, it } from 'vitest';

import { buildTestApp, type TestApp } from './helpers/app.js';

let current: TestApp | undefined;

async function start(checkDatabase: () => Promise<void> = () => Promise.resolve()) {
  current = await buildTestApp({ checkDatabase });
  return current.app;
}

afterEach(async () => {
  await current?.close();
  current = undefined;
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

describe('cabeçalhos de segurança', () => {
  it('envia os cabeçalhos do helmet', async () => {
    const server = await start();

    const response = await server.inject({ method: 'GET', url: '/health' });

    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['strict-transport-security']).toBeDefined();
    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  it('só autoriza CORS para as origens configuradas', async () => {
    const server = await start();

    const allowed = await server.inject({
      method: 'OPTIONS',
      url: '/v1/me',
      headers: { origin: 'http://localhost:3000', 'access-control-request-method': 'GET' },
    });
    const denied = await server.inject({
      method: 'OPTIONS',
      url: '/v1/me',
      headers: { origin: 'https://site-malicioso.example', 'access-control-request-method': 'GET' },
    });

    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    expect(allowed.headers['access-control-allow-credentials']).toBe('true');
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('trace_id', () => {
  it('reaproveita o trace id do header traceparent', async () => {
    current = await buildTestApp({ ready: false });
    const server = current.app;
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
