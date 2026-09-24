import assert from 'node:assert/strict';
import test from 'node:test';

import { createGatewayApp } from '../src/proxy.js';
import { createStatusApp } from '../src/status.js';

const metric = {
  id: 'm-1',
  at: new Date().toISOString(),
  keyId: 'key-1',
  path: '/v1/responses',
  model: 'modelo-local',
  status: 200,
  latencyMs: 120,
  inputTokens: 10,
  outputTokens: 5
};

function makeStore({ validToken = 'valid-token', pausedToken = 'paused-token' } = {}) {
  return {
    getSettings: () => ({}),
    listKeys: () => [{ id: 'key-1', name: 'Equipo Alpha', prefix: 'lmg_a', revokedAt: null, pausedAt: null }],
    getMetrics: () => [metric],
    getModels: () => [],
    recordMetric: async () => {},
    findKeyByToken: (token) => {
      if (token === validToken) return { id: 'key-1', name: 'Equipo Alpha', prefix: 'lmg_a', revokedAt: null, pausedAt: null };
      if (token === pausedToken) {
        return { id: 'key-2', name: 'Acceso pausado', prefix: 'lmg_p', revokedAt: null, pausedAt: new Date().toISOString(), pausedMessage: 'Aviso personalizado de pausa' };
      }
      if (token === 'revoked-token') return { id: 'key-3', name: 'Revocada', prefix: 'lmg_r', revokedAt: new Date().toISOString(), pausedAt: null };
      return null;
    }
  };
}

function startGateway(store) {
  const gateway = createGatewayApp({
    config: { upstreamBaseUrl: 'http://127.0.0.1:1234', upstreamApiKey: '', requestTimeoutMs: 1000 },
    store,
    statusApp: createStatusApp({ store })
  });
  return new Promise((resolve) => {
    const server = gateway.listen(0, '127.0.0.1');
    server.once('listening', () => resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` }));
  });
}

test('/status sirve la página del dashboard sin pedir nada antes, como /chat', async (t) => {
  const { server, baseUrl } = await startGateway(makeStore());
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const page = await fetch(`${baseUrl}/status`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('www-authenticate'), null);
  assert.match(page.headers.get('cache-control') || '', /no-store/);
  const body = await page.text();
  assert.match(body, /<body class="status-mode">/);
  assert.match(body, /<title>Estado · benzIA<\/title>/);
  // La página misma es pública; lo que pide el token es la interfaz, como en el chat.
  const withToken = await fetch(`${baseUrl}/status`, { headers: { 'x-api-key': 'cualquiera' } });
  assert.equal(withToken.status, 200);
});

test('/status/api exige la clave de acceso creada en el panel', async (t) => {
  const { server, baseUrl } = await startGateway(makeStore());
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const missing = await fetch(`${baseUrl}/status/api/session`);
  assert.equal(missing.status, 401);
  assert.equal((await missing.json()).error.code, 'invalid_api_key');

  const unknown = await fetch(`${baseUrl}/status/api/session`, { headers: { authorization: 'Bearer inexistente' } });
  assert.equal(unknown.status, 401);

  const revoked = await fetch(`${baseUrl}/status/api/session`, { headers: { 'x-api-key': 'revoked-token' } });
  assert.equal(revoked.status, 401);

  const paused = await fetch(`${baseUrl}/status/api/session`, { headers: { authorization: 'Bearer paused-token' } });
  assert.equal(paused.status, 403);
  assert.equal((await paused.json()).error, 'Aviso personalizado de pausa');

  const headers = { 'x-api-key': 'valid-token' };

  const session = await fetch(`${baseUrl}/status/api/session`, { headers });
  assert.equal(session.status, 200);
  assert.deepEqual(await session.json(), {
    authenticated: true,
    identity: { id: 'key-1', name: 'Equipo Alpha' }
  });

  const overview = await fetch(`${baseUrl}/status/api/overview?hours=24`, { headers });
  assert.equal(overview.status, 200);
  const payload = await overview.json();
  assert.equal(payload.totals.requests, 1);
  assert.equal(payload.totals.inputTokens, 10);
  assert.equal(payload.totals.outputTokens, 5);
  assert.deepEqual(payload.byKey.map((item) => item.name), ['Equipo Alpha']);
  assert.deepEqual(payload.recent.map((item) => item.id), ['m-1']);

  const invalidOverview = await fetch(`${baseUrl}/status/api/overview?from=fecha-invalida`, { headers });
  assert.equal(invalidOverview.status, 400);

  const keys = await fetch(`${baseUrl}/status/api/keys`, { headers });
  assert.equal(keys.status, 200);
  assert.deepEqual((await keys.json()).keys.map((key) => key.id), ['key-1']);

  const live = await fetch(`${baseUrl}/status/api/live`, { headers });
  assert.equal(live.status, 200);
  assert.deepEqual(await live.json(), { activeStreams: 0, tokensPerSecond: 0, streams: [] });

  // La cabecera administrativa no vale para la vista de estado.
  const withAdminHeader = await fetch(`${baseUrl}/status/api/session`, { headers: { 'x-admin-token': 'whatever' } });
  assert.equal(withAdminHeader.status, 401);
});