import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { adminAuth } from '../src/admin-auth.js';
import { ResponseCache } from '../src/cache.js';
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
    cache: new ResponseCache({ ttlSeconds: 60, maxEntries: 2 }),
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
    store,
    cache: new ResponseCache({ ttlSeconds: 0, maxEntries: 0 })
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

test('clasifica streams como bypass y registra la telemetría final de Proveedor IA Local', async (t) => {
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
    store,
    cache: new ResponseCache({ ttlSeconds: 60, maxEntries: 10 })
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
  assert.equal(response.headers.get('x-lm-gateway-cache'), 'BYPASS');
  assert.equal(metrics[0].cacheStatus, 'bypass');
  assert.equal(metrics[0].lmCachedInputTokens, 8);
  assert.equal(metrics[0].tokensPerSecond, 42);
  assert.equal(metrics[0].throughputSource, 'upstream');
});

test('distingue miss, hit y bypass en la caché de respuestas', async (t) => {
  let upstreamCalls = 0;
  const upstream = express();
  upstream.use(express.json());
  upstream.post('/v1/chat/completions', (_req, res) => {
    upstreamCalls += 1;
    res.json({ choices: [{ message: { content: 'Respuesta' } }], usage: { prompt_tokens: 4, completion_tokens: 2 } });
  });
  const upstreamServer = upstream.listen(0, '127.0.0.1');
  await new Promise((resolve) => upstreamServer.once('listening', resolve));
  t.after(() => new Promise((resolve) => upstreamServer.close(resolve)));

  const metrics = [];
  const gateway = createGatewayApp({
    config: { upstreamBaseUrl: `http://127.0.0.1:${upstreamServer.address().port}`, upstreamApiKey: '', requestTimeoutMs: 5000 },
    store: {
      getSettings: () => ({}),
      findKeyByToken: () => ({ id: 'key-1', name: 'Pruebas' }),
      recordMetric: async (metric) => metrics.push(metric)
    },
    cache: new ResponseCache({ ttlSeconds: 60, maxEntries: 10 })
  });
  const gatewayServer = gateway.listen(0, '127.0.0.1');
  await new Promise((resolve) => gatewayServer.once('listening', resolve));
  t.after(() => new Promise((resolve) => gatewayServer.close(resolve)));
  const url = `http://127.0.0.1:${gatewayServer.address().port}/v1/chat/completions`;
  const request = (headers = {}) => fetch(url, {
    method: 'POST',
    headers: { authorization: 'Bearer valid-key', 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ model: 'modelo', messages: [{ role: 'user', content: 'Hola' }] })
  });

  const miss = await request(); await miss.text();
  const hit = await request(); await hit.text();
  const bypass = await request({ 'cache-control': 'no-cache' }); await bypass.text();
  assert.deepEqual([
    miss.headers.get('x-lm-gateway-cache'),
    hit.headers.get('x-lm-gateway-cache'),
    bypass.headers.get('x-lm-gateway-cache')
  ], ['MISS', 'HIT', 'BYPASS']);
  assert.equal(upstreamCalls, 2);
  assert.deepEqual(metrics.map((metric) => metric.cacheStatus), ['miss', 'hit', 'bypass']);
});

test('autentica un token real y persiste las dos capas de caché', async (t) => {
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
        input_tokens_details: { cached_tokens: upstreamCalls >= 3 ? 6 : 0 }
      }
    });
  });
  const upstreamServer = upstream.listen(0, '127.0.0.1');
  await new Promise((resolve) => upstreamServer.once('listening', resolve));
  t.after(() => new Promise((resolve) => upstreamServer.close(resolve)));

  const gateway = createGatewayApp({
    config: { upstreamBaseUrl: `http://127.0.0.1:${upstreamServer.address().port}`, upstreamApiKey: '', requestTimeoutMs: 5000 },
    store,
    cache: new ResponseCache({ ttlSeconds: 60, maxEntries: 10 })
  });
  const gatewayServer = gateway.listen(0, '127.0.0.1');
  await new Promise((resolve) => gatewayServer.once('listening', resolve));
  t.after(() => new Promise((resolve) => gatewayServer.close(resolve)));

  const url = `http://127.0.0.1:${gatewayServer.address().port}/v1/responses`;
  const request = (input, headers = {}) => fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${access.token}`, 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ model: 'modelo', input })
  });

  const unauthorized = await fetch(url, { method: 'POST' });
  assert.equal(unauthorized.status, 401);

  const miss = await request('respuesta cacheable'); await miss.text();
  const hit = await request('respuesta cacheable'); await hit.text();
  const lmFirst = await request('prompt cache LM', { 'cache-control': 'no-cache' }); await lmFirst.text();
  const lmSecond = await request('prompt cache LM', { 'cache-control': 'no-cache' }); await lmSecond.text();

  assert.deepEqual([
    miss.headers.get('x-lm-gateway-cache'),
    hit.headers.get('x-lm-gateway-cache'),
    lmFirst.headers.get('x-lm-gateway-cache'),
    lmSecond.headers.get('x-lm-gateway-cache')
  ], ['MISS', 'HIT', 'BYPASS', 'BYPASS']);
  assert.equal(upstreamCalls, 3);

  const metrics = store.getMetrics();
  assert.deepEqual(metrics.map((metric) => metric.cacheStatus), ['miss', 'hit', 'bypass', 'bypass']);
  assert.deepEqual(metrics.map((metric) => metric.lmCachedInputTokens), [0, null, 0, 6]);
  assert.ok(metrics.every((metric) => metric.keyId === access.id));
});
