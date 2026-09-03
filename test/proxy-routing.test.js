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

test('publica el dashboard antes de autenticar las rutas de inferencia', async (t) => {
  const adminApp = express();
  adminApp.get('/dashboard', (_req, res) => res.type('html').send('<h1>Dashboard</h1>'));
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

  const dashboard = await fetch(`http://127.0.0.1:${address.port}/dashboard`);
  assert.equal(dashboard.status, 200);
  assert.equal(dashboard.headers.get('www-authenticate'), null);
  assert.match(await dashboard.text(), /Dashboard/);

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
  assert.match(streamBody, new RegExp(PAUSED_TOKEN_MESSAGE.replace(/[.*+?^$\{\}()|[\]\\]/g, '\\$&')));

  const responsesJson = await fetch(`${baseUrl}/responses`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: 'modelo-local', input: 'Hola' })
  });
  assert.equal(responsesJson.status, 200);
  assert.equal((await responsesJson.json()).output[0].content[0].text, PAUSED_TOKEN_MESSAGE);

  const chatCompletion = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: 'modelo-local', messages: [{ role: 'user', content: 'Hola' }] })
  });
  assert.equal(chatCompletion.status, 200);
  assert.equal((await chatCompletion.json()).choices[0].message.content, PAUSED_TOKEN_MESSAGE);

  const chatStream = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: 'modelo-local', messages: [{ role: 'user', content: 'Hola' }], stream: true })
  });
  assert.equal(chatStream.status, 200);
  assert.match(chatStream.headers.get('content-type'), /text\/event-stream/);
  assert.match(await chatStream.text(), new RegExp(PAUSED_TOKEN_MESSAGE.replace(/[.*+?^$\{\}()|[\]\\]/g, '\\$&')));
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
