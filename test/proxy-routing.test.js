import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { PAUSED_TOKEN_MESSAGE } from '../src/access-auth.js';
import { adminAuth } from '../src/admin-auth.js';
import { createGatewayApp } from '../src/proxy.js';
import { SqliteStore } from '../src/store.js';

test('health comprueba realmente la disponibilidad del proveedor local', async (t) => {
  const upstream = express();
  upstream.get('/v1/models', (_req, res) => res.json({ object: 'list', data: [{ id: 'modelo-local' }] }));
  const upstreamServer = upstream.listen(0, '127.0.0.1');
  await new Promise((resolve) => upstreamServer.once('listening', resolve));

  const store = { getSettings: () => ({}) };
  const gateway = createGatewayApp({
    config: {
      upstreamBaseUrl: `http://127.0.0.1:${upstreamServer.address().port}`,
      upstreamApiKey: '',
      requestTimeoutMs: 1000
    },
    store
  });
  const gatewayServer = gateway.listen(0, '127.0.0.1');
  await new Promise((resolve) => gatewayServer.once('listening', resolve));
  t.after(() => new Promise((resolve) => gatewayServer.close(resolve)));
  const healthUrl = `http://127.0.0.1:${gatewayServer.address().port}/health`;

  const healthy = await fetch(healthUrl);
  assert.equal(healthy.status, 200);
  assert.deepEqual(await healthy.json(), {
    status: 'ok', service: 'benzIA', upstream: `http://127.0.0.1:${upstreamServer.address().port}`, models: 1
  });

  await new Promise((resolve) => upstreamServer.close(resolve));
  const degraded = await fetch(healthUrl);
  assert.equal(degraded.status, 503);
  assert.equal((await degraded.json()).status, 'degraded');
});

test('publica el dashboard antes de autenticar las rutas de inferencia', async (t) => {
  const adminApp = express();
  adminApp.get('/dashboard', (_req, res) => res.type('html').send('<h1>Dashboard</h1>'));
  adminApp.get('/utilities', (_req, res) => res.type('html').send('<h1>Utilidades</h1>'));
  adminApp.get('/admin/api/session', adminAuth('admin-secret'), (_req, res) => res.json({ ok: true }));
  const chatApp = express();
  chatApp.get('/', (_req, res) => res.type('html').send('<h1>benzIA Chat</h1>'));
  const store = {
    getSettings: () => ({}),
    findKeyByToken: () => null
  };
  const config = {
    adminToken: 'admin-secret',
    upstreamBaseUrl: 'http://127.0.0.1:1234',
    upstreamApiKey: '',
    requestTimeoutMs: 1000
  };
  const app = createGatewayApp({
    config,
    store,
    adminApp,
    chatApp
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();

  const root = await fetch(`http://127.0.0.1:${address.port}/`, { redirect: 'manual' });
  assert.equal(root.status, 302);
  assert.equal(root.headers.get('location'), '/chat');

  const dashboard = await fetch(`http://127.0.0.1:${address.port}/dashboard`);
  assert.equal(dashboard.status, 200);
  assert.equal(dashboard.headers.get('www-authenticate'), null);
  assert.match(await dashboard.text(), /Dashboard/);

  const utilities = await fetch(`http://127.0.0.1:${address.port}/utilities`);
  assert.equal(utilities.status, 200);
  assert.equal(utilities.headers.get('www-authenticate'), null);

  const chat = await fetch(`http://127.0.0.1:${address.port}/chat`);
  assert.equal(chat.status, 200);
  assert.match(await chat.text(), /benzIA Chat/);

  const blockedAdminApi = await fetch(`http://127.0.0.1:${address.port}/admin/api/session`);
  assert.equal(blockedAdminApi.status, 401);
  assert.equal(blockedAdminApi.headers.get('www-authenticate'), null);

  const basicCredentials = Buffer.from('benzIA:admin-secret').toString('base64');
  const ignoredBasic = await fetch(`http://127.0.0.1:${address.port}/admin/api/session`, {
    headers: { authorization: `Basic ${basicCredentials}` }
  });
  assert.equal(ignoredBasic.status, 401);

  const adminApi = await fetch(`http://127.0.0.1:${address.port}/admin/api/session`, {
    headers: { 'x-admin-token': 'admin-secret' }
  });
  assert.equal(adminApi.status, 200);

  const models = await fetch(`http://127.0.0.1:${address.port}/v1/models`);
  assert.equal(models.status, 401);
});

test('un token pausado consulta modelos y recibe el aviso como respuesta de asistente', async (t) => {
  let upstreamCalls = 0;
  let pausedMessage = 'Tu acceso está pausado. Contacta con Benzo para revisar tu suscripción.';
  const upstream = express();
  upstream.get('/v1/models', (_req, res) => {
    upstreamCalls += 1;
    res.json({ object: 'list', data: [{ id: 'modelo-local', object: 'model' }] });
  });
  const upstreamServer = upstream.listen(0, '127.0.0.1');
  await new Promise((resolve) => upstreamServer.once('listening', resolve));
  t.after(() => new Promise((resolve) => upstreamServer.close(resolve)));

  const store = {
    getSettings: () => ({}),
    findKeyByToken: () => ({
      id: 'paused-key',
      name: 'Acceso pausado',
      pausedAt: new Date().toISOString(),
      pausedMessage,
      revokedAt: null
    }),
    recordMetric: async () => {}
  };
  const gateway = createGatewayApp({
    config: {
      upstreamBaseUrl: `http://127.0.0.1:${upstreamServer.address().port}`,
      upstreamApiKey: '',
      requestTimeoutMs: 5000
    },
    store
  });
  const gatewayServer = gateway.listen(0, '127.0.0.1');
  await new Promise((resolve) => gatewayServer.once('listening', resolve));
  t.after(() => new Promise((resolve) => gatewayServer.close(resolve)));
  const baseUrl = `http://127.0.0.1:${gatewayServer.address().port}/v1`;
  const headers = { authorization: 'Bearer paused-token', 'content-type': 'application/json' };

  const models = await fetch(`${baseUrl}/models`, { headers });
  assert.equal(models.status, 200);
  assert.equal((await models.json()).data[0].id, 'modelo-local');

  const responsesStream = await fetch(`${baseUrl}/responses`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: 'modelo-local', input: 'Hola', stream: true })
  });
  assert.equal(responsesStream.status, 200);
  assert.match(responsesStream.headers.get('content-type'), /text\/event-stream/);
  const streamBody = await responsesStream.text();
  assert.match(streamBody, /response\.output_text\.delta/);
  assert.match(streamBody, new RegExp(pausedMessage.replace(/[.*+?^$\{\}()|[\]\\]/g, '\\$&')));

  const responsesJson = await fetch(`${baseUrl}/responses`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: 'modelo-local', input: 'Hola' })
  });
  assert.equal(responsesJson.status, 200);
  assert.equal((await responsesJson.json()).output[0].content[0].text, pausedMessage);

  const chatCompletion = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: 'modelo-local', messages: [{ role: 'user', content: 'Hola' }] })
  });
  assert.equal(chatCompletion.status, 200);
  assert.equal((await chatCompletion.json()).choices[0].message.content, pausedMessage);

  const chatStream = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: 'modelo-local', messages: [{ role: 'user', content: 'Hola' }], stream: true })
  });
  assert.equal(chatStream.status, 200);
  assert.match(chatStream.headers.get('content-type'), /text\/event-stream/);
  assert.match(await chatStream.text(), new RegExp(pausedMessage.replace(/[.*+?^$\{\}()|[\]\\]/g, '\\$&')));

  pausedMessage = null;
  const fallbackResponse = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: 'modelo-local', messages: [{ role: 'user', content: 'Hola' }] })
  });
  assert.equal((await fallbackResponse.json()).choices[0].message.content, PAUSED_TOKEN_MESSAGE);
  assert.equal(upstreamCalls, 1);
});

test('reenvía sin alterar mensajes multimodales a Proveedor IA Local', async (t) => {
  let receivedBody;
  const upstream = express();
  upstream.use(express.json({ limit: '20mb' }));
  upstream.post('/v1/chat/completions', (req, res) => {
    receivedBody = req.body;
    res.json({
      choices: [{ message: { role: 'assistant', content: 'Imagen recibida.' } }],
      usage: { prompt_tokens: 20, completion_tokens: 4 }
    });
  });
  const upstreamServer = upstream.listen(0, '127.0.0.1');
  await new Promise((resolve) => upstreamServer.once('listening', resolve));
  t.after(() => new Promise((resolve) => upstreamServer.close(resolve)));

  const store = {
    getSettings: () => ({}),
    findKeyByToken: (token) => token === 'valid-key' ? { id: 'key-1' } : null,
    recordMetric: async () => {}
  };
  const config = {
    upstreamBaseUrl: `http://127.0.0.1:${upstreamServer.address().port}`,
    upstreamApiKey: '',
    requestTimeoutMs: 5000
  };
  const gateway = createGatewayApp({
    config,
    store
  });
  const gatewayServer = gateway.listen(0, '127.0.0.1');
  await new Promise((resolve) => gatewayServer.once('listening', resolve));
  t.after(() => new Promise((resolve) => gatewayServer.close(resolve)));

  const multimodalContent = [
    { type: 'text', text: 'Describe la imagen' },
    { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,YWJj' } }
  ];
  const response = await fetch(`http://127.0.0.1:${gatewayServer.address().port}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: 'Bearer valid-key', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'vision-model', messages: [{ role: 'user', content: multimodalContent }] })
  });

  assert.equal(response.status, 200);
  assert.deepEqual(receivedBody.messages[0].content, multimodalContent);
});

test('agrega modelos externos sólo para claves autorizadas y enruta el modelo prefijado', async (t) => {
  const local = express();
  local.get('/v1/models', (_req, res) => res.json({ object: 'list', data: [{ id: 'modelo-local', object: 'model' }] }));
  const localServer = local.listen(0, '127.0.0.1');
  await new Promise((resolve) => localServer.once('listening', resolve));
  t.after(() => new Promise((resolve) => localServer.close(resolve)));

  let externalAuthorization = '';
  let externalBody;
  const external = express();
  external.use(express.json());
  external.get('/v1/models', (req, res) => {
    externalAuthorization = req.get('authorization') || '';
    res.json({ object: 'list', data: [{ id: 'org/modelo-cloud', object: 'model', created: 123 }] });
  });
  external.post('/v1/chat/completions', (req, res) => {
    externalAuthorization = req.get('authorization') || '';
    externalBody = req.body;
    res.json({ choices: [{ message: { content: 'Desde cloud' } }], usage: { prompt_tokens: 2, completion_tokens: 2 } });
  });
  const externalServer = external.listen(0, '127.0.0.1');
  await new Promise((resolve) => externalServer.once('listening', resolve));
  t.after(() => new Promise((resolve) => externalServer.close(resolve)));

  const metrics = [];
  const store = {
    getSettings: () => ({ externalProviders: [{ id: 'cloud', name: 'Cloud IA', baseUrl: `http://127.0.0.1:${externalServer.address().port}`, apiKey: 'cloud-secret' }] }),
    findKeyByToken: (token) => token === 'external-key'
      ? { id: 'external', name: 'Externo', allowExternalProviders: true }
      : { id: 'local', name: 'Local', allowExternalProviders: false },
    recordMetric: async (metric) => metrics.push(metric)
  };
  const gateway = createGatewayApp({
    config: { upstreamBaseUrl: `http://127.0.0.1:${localServer.address().port}`, upstreamApiKey: '', requestTimeoutMs: 5000 },
    store
  });
  const gatewayServer = gateway.listen(0, '127.0.0.1');
  await new Promise((resolve) => gatewayServer.once('listening', resolve));
  t.after(() => new Promise((resolve) => gatewayServer.close(resolve)));
  const baseUrl = `http://127.0.0.1:${gatewayServer.address().port}/v1`;

  const localModelsResponse = await fetch(`${baseUrl}/models`, { headers: { authorization: 'Bearer local-key' } });
  assert.deepEqual((await localModelsResponse.json()).data.map((model) => model.id), ['modelo-local']);

  const allModelsResponse = await fetch(`${baseUrl}/models`, { headers: { authorization: 'Bearer external-key' } });
  const allModels = (await allModelsResponse.json()).data;
  assert.deepEqual(allModels.map((model) => model.id), ['modelo-local', 'cloud/org/modelo-cloud']);
  assert.equal(allModels[1].owned_by, 'Cloud IA');
  assert.equal(externalAuthorization, 'Bearer cloud-secret');

  const forbidden = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST', headers: { authorization: 'Bearer local-key', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'cloud/org/modelo-cloud', messages: [] })
  });
  assert.equal(forbidden.status, 403);

  const completion = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST', headers: { authorization: 'Bearer external-key', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'cloud/org/modelo-cloud', messages: [{ role: 'user', content: 'Hola' }] })
  });
  assert.equal(completion.status, 200);
  assert.equal(externalBody.model, 'org/modelo-cloud');
  assert.equal(externalAuthorization, 'Bearer cloud-secret');
  assert.equal(metrics[0].model, 'cloud/org/modelo-cloud');
  assert.equal(metrics[0].provider, 'cloud');
});

test('el filtro de proveedores visibles por clave limita modelos y enrutado sin consultar lo no marcado', async (t) => {
  const local = express();
  local.get('/v1/models', (_req, res) => res.json({ object: 'list', data: [{ id: 'modelo-local', object: 'model' }] }));
  const localServer = local.listen(0, '127.0.0.1');
  await new Promise((resolve) => localServer.once('listening', resolve));
  t.after(() => new Promise((resolve) => localServer.close(resolve)));

  let cloudModelCalls = 0;
  let otherModelCalls = 0;
  let chatTarget = '';
  const cloud = express();
  cloud.use(express.json());
  cloud.get('/v1/models', (_req, res) => { cloudModelCalls += 1; res.json({ object: 'list', data: [{ id: 'org/modelo-cloud' }] }); });
  cloud.post('/v1/chat/completions', (req, res) => {
    chatTarget = 'cloud';
    res.json({ choices: [{ message: { content: 'Desde cloud' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
  });
  const cloudServer = cloud.listen(0, '127.0.0.1');
  await new Promise((resolve) => cloudServer.once('listening', resolve));
  t.after(() => new Promise((resolve) => cloudServer.close(resolve)));

  const other = express();
  other.get('/v1/models', (_req, res) => { otherModelCalls += 1; res.json({ object: 'list', data: [{ id: 'b/modelo-otro' }] }); });
  const otherServer = other.listen(0, '127.0.0.1');
  await new Promise((resolve) => otherServer.once('listening', resolve));
  t.after(() => new Promise((resolve) => otherServer.close(resolve)));

  const settings = {
    externalProviders: [
      { id: 'cloud', name: 'Cloud IA', baseUrl: `http://127.0.0.1:${cloudServer.address().port}`, apiKey: '' },
      { id: 'other', name: 'Otro', baseUrl: `http://127.0.0.1:${otherServer.address().port}`, apiKey: '' }
    ]
  };
  const store = {
    getSettings: () => settings,
    findKeyByToken: (token) => {
      if (token === 'filtered-key') return { id: 'filtered', name: 'Filtrada', allowExternalProviders: true, externalProviderIds: ['cloud'] };
      if (token === 'all-key') return { id: 'all', name: 'Todos', allowExternalProviders: true };
      return { id: 'local', name: 'Local', allowExternalProviders: false };
    },
    recordMetric: async () => {}
  };
  const gateway = createGatewayApp({
    config: { upstreamBaseUrl: `http://127.0.0.1:${localServer.address().port}`, upstreamApiKey: '', requestTimeoutMs: 5000 },
    store
  });
  const gatewayServer = gateway.listen(0, '127.0.0.1');
  await new Promise((resolve) => gatewayServer.once('listening', resolve));
  t.after(() => new Promise((resolve) => gatewayServer.close(resolve)));
  const baseUrl = `http://127.0.0.1:${gatewayServer.address().port}/v1`;

  const filteredModels = await fetch(`${baseUrl}/models`, { headers: { authorization: 'Bearer filtered-key' } });
  assert.deepEqual((await filteredModels.json()).data.map((model) => model.id), ['modelo-local', 'cloud/org/modelo-cloud']);
  assert.equal(cloudModelCalls, 1);
  assert.equal(otherModelCalls, 0, 'no debe consultar un proveedor que la clave no marcó');

  const allModels = await fetch(`${baseUrl}/models`, { headers: { authorization: 'Bearer all-key' } });
  assert.deepEqual((await allModels.json()).data.map((model) => model.id), ['modelo-local', 'cloud/org/modelo-cloud', 'other/b/modelo-otro']);

  const forbidden = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST', headers: { authorization: 'Bearer filtered-key', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'other/b/modelo-otro', messages: [{ role: 'user', content: 'Hola' }] })
  });
  assert.equal(forbidden.status, 403);
  assert.equal((await forbidden.json()).error.code, 'external_provider_forbidden');

  const allowed = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST', headers: { authorization: 'Bearer filtered-key', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'cloud/org/modelo-cloud', messages: [{ role: 'user', content: 'Hola' }] })
  });
  assert.equal(allowed.status, 200);
  assert.equal(chatTarget, 'cloud');
});

test('una fuente externa caída no retiene la lista de modelos durante su timeout completo', async (t) => {
  const local = express();
  local.get('/v1/models', (_req, res) => res.json({ object: 'list', data: [{ id: 'modelo-local' }] }));
  const localServer = local.listen(0, '127.0.0.1');
  await new Promise((resolve) => localServer.once('listening', resolve));
  t.after(() => new Promise((resolve) => localServer.close(resolve)));

  const unavailable = express();
  unavailable.get('/v1/models', () => {});
  const unavailableServer = unavailable.listen(0, '127.0.0.1');
  await new Promise((resolve) => unavailableServer.once('listening', resolve));
  t.after(() => new Promise((resolve) => unavailableServer.close(resolve)));

  const store = {
    getSettings: () => ({ externalProviders: [{ id: 'slow', name: 'Lento', baseUrl: `http://127.0.0.1:${unavailableServer.address().port}`, apiKey: '' }] }),
    findKeyByToken: () => ({ id: 'external', name: 'Externo', allowExternalProviders: true }),
    recordMetric: async () => {}
  };
  const gateway = createGatewayApp({
    config: { upstreamBaseUrl: `http://127.0.0.1:${localServer.address().port}`, upstreamApiKey: '', requestTimeoutMs: 5000 },
    store
  });
  const gatewayServer = gateway.listen(0, '127.0.0.1');
  await new Promise((resolve) => gatewayServer.once('listening', resolve));
  t.after(() => new Promise((resolve) => gatewayServer.close(resolve)));

  const startedAt = performance.now();
  const response = await fetch(`http://127.0.0.1:${gatewayServer.address().port}/v1/models`, { headers: { authorization: 'Bearer external-key' } });
  const elapsedMs = performance.now() - startedAt;
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data.map((model) => model.id), ['modelo-local']);
  assert.ok(elapsedMs < 1_500, `La respuesta tardó ${elapsedMs} ms`);
  assert.equal(response.headers.get('x-benzia-provider-errors'), 'slow');
});

test('registra la telemetría final del proveedor en streaming', async (t) => {
  const upstream = express();
  upstream.use(express.json());
  upstream.post('/v1/chat/completions', (_req, res) => {
    res.type('text/event-stream');
    res.write('data: {"choices":[{"delta":{"content":"Hola "}}]}\n\n');
    res.write('data: {"choices":[{"delta":{"content":"mundo"}}]}\n\n');
    res.end('data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2,"prompt_tokens_details":{"cached_tokens":8}},"stats":{"tokens_per_second":42}}\n\n');
  });
  const upstreamServer = upstream.listen(0, '127.0.0.1');
  await new Promise((resolve) => upstreamServer.once('listening', resolve));
  t.after(() => new Promise((resolve) => upstreamServer.close(resolve)));

  const metrics = [];
  const store = {
    getSettings: () => ({}),
    findKeyByToken: () => ({ id: 'key-1', name: 'Pruebas' }),
    recordMetric: async (metric) => metrics.push(metric)
  };
  const gateway = createGatewayApp({
    config: { upstreamBaseUrl: `http://127.0.0.1:${upstreamServer.address().port}`, upstreamApiKey: '', requestTimeoutMs: 5000 },
    store
  });
  const gatewayServer = gateway.listen(0, '127.0.0.1');
  await new Promise((resolve) => gatewayServer.once('listening', resolve));
  t.after(() => new Promise((resolve) => gatewayServer.close(resolve)));

  const response = await fetch(`http://127.0.0.1:${gatewayServer.address().port}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: 'Bearer valid-key', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'modelo', stream: true, messages: [{ role: 'user', content: 'Hola' }] })
  });
  await response.text();
  assert.equal(response.headers.get('x-lm-gateway-cache'), null);
  assert.equal(metrics[0].lmCachedInputTokens, 8);
  assert.equal(metrics[0].tokensPerSecond, 42);
  assert.equal(metrics[0].throughputSource, 'upstream');
});

test('mantiene el timeout durante todo el stream y registra la interrupción', async (t) => {
  const upstream = express();
  upstream.use(express.json());
  upstream.post('/v1/chat/completions', (_req, res) => {
    res.type('text/event-stream');
    res.flushHeaders();
    res.write('data: {"choices":[{"delta":{"content":"Inicio"}}]}\n\n');
    res.on('close', () => res.end());
  });
  const upstreamServer = upstream.listen(0, '127.0.0.1');
  await new Promise((resolve) => upstreamServer.once('listening', resolve));
  t.after(() => new Promise((resolve) => upstreamServer.close(resolve)));

  const metrics = [];
  const store = {
    getSettings: () => ({}),
    findKeyByToken: () => ({ id: 'key-1', name: 'Pruebas' }),
    recordMetric: async (metric) => metrics.push(metric)
  };
  const gateway = createGatewayApp({
    config: { upstreamBaseUrl: `http://127.0.0.1:${upstreamServer.address().port}`, upstreamApiKey: '', requestTimeoutMs: 80 },
    store
  });
  const gatewayServer = gateway.listen(0, '127.0.0.1');
  await new Promise((resolve) => gatewayServer.once('listening', resolve));
  t.after(() => new Promise((resolve) => gatewayServer.close(resolve)));

  const response = await fetch(`http://127.0.0.1:${gatewayServer.address().port}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: 'Bearer valid-key', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'modelo', stream: true, messages: [{ role: 'user', content: 'Hola' }] })
  });
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(body, /Inicio/);
  assert.match(body, /upstream_timeout/);
  assert.equal(metrics[0].status, 504);
  assert.equal(metrics[0].stream, true);
});

test('hace visible y registra un corte prematuro del proveedor', async (t) => {
  const upstream = express();
  upstream.use(express.json());
  upstream.post('/v1/chat/completions', (_req, res) => {
    res.type('text/event-stream');
    res.flushHeaders();
    res.write('data: {"choices":[{"delta":{"content":"Parcial"}}]}\n\n');
    setTimeout(() => res.socket?.destroy(), 10);
  });
  const upstreamServer = upstream.listen(0, '127.0.0.1');
  await new Promise((resolve) => upstreamServer.once('listening', resolve));
  t.after(() => new Promise((resolve) => upstreamServer.close(resolve)));

  const metrics = [];
  const store = {
    getSettings: () => ({}),
    findKeyByToken: () => ({ id: 'key-1', name: 'Pruebas' }),
    recordMetric: async (metric) => metrics.push(metric)
  };
  const gateway = createGatewayApp({
    config: { upstreamBaseUrl: `http://127.0.0.1:${upstreamServer.address().port}`, upstreamApiKey: '', requestTimeoutMs: 5000 },
    store
  });
  const gatewayServer = gateway.listen(0, '127.0.0.1');
  await new Promise((resolve) => gatewayServer.once('listening', resolve));
  t.after(() => new Promise((resolve) => gatewayServer.close(resolve)));

  const response = await fetch(`http://127.0.0.1:${gatewayServer.address().port}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: 'Bearer valid-key', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'modelo', stream: true, messages: [{ role: 'user', content: 'Hola' }] })
  });
  const body = await response.text();

  assert.match(body, /Parcial/);
  assert.match(body, /upstream_interrupted/);
  assert.equal(metrics[0].status, 502);
});

test('autentica un token real y persiste únicamente la caché reportada por el proveedor', async (t) => {
  const testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'benzia-proxy-cache-'));
  const store = new SqliteStore(testDir);
  await store.init();
  const access = await store.createKey('Integración de caché');
  t.after(async () => {
    store.close();
    await fs.rm(testDir, { recursive: true, force: true });
  });

  let upstreamCalls = 0;
  const upstream = express();
  upstream.use(express.json());
  upstream.post('/v1/responses', (_req, res) => {
    upstreamCalls += 1;
    res.json({
      id: `response-${upstreamCalls}`,
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'Respuesta' }] }],
      usage: {
        input_tokens: 8,
        output_tokens: 2,
        input_tokens_details: { cached_tokens: upstreamCalls >= 2 ? 6 : 0 }
      }
    });
  });
  const upstreamServer = upstream.listen(0, '127.0.0.1');
  await new Promise((resolve) => upstreamServer.once('listening', resolve));
  t.after(() => new Promise((resolve) => upstreamServer.close(resolve)));

  const gateway = createGatewayApp({
    config: { upstreamBaseUrl: `http://127.0.0.1:${upstreamServer.address().port}`, upstreamApiKey: '', requestTimeoutMs: 5000 },
    store
  });
  const gatewayServer = gateway.listen(0, '127.0.0.1');
  await new Promise((resolve) => gatewayServer.once('listening', resolve));
  t.after(() => new Promise((resolve) => gatewayServer.close(resolve)));

  const url = `http://127.0.0.1:${gatewayServer.address().port}/v1/responses`;
  const request = (input) => fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${access.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'modelo', input })
  });

  const unauthorized = await fetch(url, { method: 'POST' });
  assert.equal(unauthorized.status, 401);

  const lmFirst = await request('prompt cache LM'); await lmFirst.text();
  const lmSecond = await request('prompt cache LM'); await lmSecond.text();

  assert.equal(lmFirst.headers.get('x-lm-gateway-cache'), null);
  assert.equal(lmSecond.headers.get('x-lm-gateway-cache'), null);
  assert.equal(upstreamCalls, 2);

  const metrics = store.getMetrics();
  assert.deepEqual(metrics.map((metric) => metric.lmCachedInputTokens), [0, 6]);
  assert.ok(metrics.every((metric) => !('cacheStatus' in metric)));
  assert.ok(metrics.every((metric) => metric.keyId === access.id));
});
