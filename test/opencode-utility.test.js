import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { createAdminApp, extractOpenAiModels, normalizeOpenCodeBaseUrl } from '../src/admin.js';
import { SqliteStore } from '../src/store.js';

test('normaliza una base OpenAI-compatible al endpoint /v1/models', () => {
  assert.equal(normalizeOpenCodeBaseUrl('http://127.0.0.1:1234'), 'http://127.0.0.1:1234/v1');
  assert.equal(normalizeOpenCodeBaseUrl('https://llm.example.com/custom/v1/'), 'https://llm.example.com/custom/v1');
  assert.throws(() => normalizeOpenCodeBaseUrl('ftp://models.example.com'));
  assert.throws(() => normalizeOpenCodeBaseUrl('https://secret@example.com/v1'));
  assert.deepEqual(extractOpenAiModels({ data: [{ id: 'vision' }, { id: 'vision' }, { id: 'text', name: 'Texto' }] }), [
    { id: 'vision', name: 'vision' }, { id: 'text', name: 'Texto' }
  ]);
});

test('descubre modelos desde el backend sin devolver el token del usuario', async (t) => {
  let authorization = null;
  const upstream = express();
  upstream.get('/v1/models', (req, res) => {
    authorization = req.get('authorization');
    res.json({ object: 'list', data: [{ id: 'modelo-texto' }, { id: 'modelo-vision', name: 'Modelo Vision' }] });
  });
  const upstreamServer = upstream.listen(0, '127.0.0.1');
  await new Promise((resolve) => upstreamServer.once('listening', resolve));
  t.after(() => new Promise((resolve) => upstreamServer.close(resolve)));

  const testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'benzIA-opencode-'));
  const store = new SqliteStore(testDir, 30);
  await store.init();
  const app = createAdminApp({
    config: { adminToken: 'admin-secret', upstreamBaseUrl: 'http://127.0.0.1:1234', upstreamApiKey: '', publicGatewayUrl: 'http://127.0.0.1:3401', gatewayPort: 3401, adminPort: 3400, metricsRetentionDays: 30 },
    store
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    await fs.rm(testDir, { recursive: true, force: true });
  });

  const token = 'access-token-that-must-not-be-returned';
  const response = await fetch(`http://127.0.0.1:${server.address().port}/admin/api/opencode/discover-models`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-token': 'admin-secret' },
    body: JSON.stringify({ baseUrl: `http://127.0.0.1:${upstreamServer.address().port}`, apiKey: token })
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(authorization, `Bearer ${token}`);
  assert.deepEqual(payload.models, [{ id: 'modelo-texto', name: 'modelo-texto' }, { id: 'modelo-vision', name: 'Modelo Vision' }]);
  assert.equal(JSON.stringify(payload).includes(token), false);

  const unauthorized = await fetch(`http://127.0.0.1:${server.address().port}/admin/api/opencode/discover-models`, { method: 'POST' });
  assert.equal(unauthorized.status, 401);
});
