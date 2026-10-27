import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createAdminApp } from '../src/admin.js';
import { SqliteStore } from '../src/store.js';

test('el panel guarda los modelos visibles de un proveedor externo', async (t) => {
  const testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'benzIA-provider-models-'));
  const store = new SqliteStore(testDir, 30);
  await store.init();
  await store.updateSettings({ externalProviders: [
    { id: 'cloud', name: 'Cloud IA', baseUrl: 'https://api.example.com', apiKey: 'secreto', visibleModels: null },
    { id: 'groq', name: 'Groq', baseUrl: 'https://api.groq.com', apiKey: '' }
  ] });
  const app = createAdminApp({
    config: {
      adminToken: 'admin-secret',
      upstreamBaseUrl: 'http://127.0.0.1:1234',
      upstreamApiKey: '',
      publicGatewayUrl: 'http://127.0.0.1:3401',
      gatewayPort: 3401,
      adminPort: 3400,
      metricsRetentionDays: 30
    },
    store
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    await fs.rm(testDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}/admin/api`;
  const patch = (providerId, visibleModels) => fetch(`${base}/external-providers/${providerId}/visible-models`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-admin-token': 'admin-secret' },
    body: JSON.stringify({ visibleModels })
  });

  const unauthorized = await fetch(`${base}/external-providers/cloud/visible-models`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ visibleModels: ['a'] })
  });
  assert.equal(unauthorized.status, 401);

  const saved = await patch('cloud', ['modelo-a', 'modelo-b']);
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), { updated: true, visibleModels: ['modelo-a', 'modelo-b'] });
  let providers = store.getSettings().externalProviders;
  assert.deepEqual(providers.find((provider) => provider.id === 'cloud').visibleModels, ['modelo-a', 'modelo-b']);
  assert.equal(providers.find((provider) => provider.id === 'groq').visibleModels, undefined);
  assert.equal(providers.find((provider) => provider.id === 'cloud').apiKey, 'secreto');

  const cleared = await patch('cloud', null);
  assert.equal(cleared.status, 200);
  assert.equal(store.getSettings().externalProviders.find((provider) => provider.id === 'cloud').visibleModels, null);

  const hidden = await patch('cloud', []);
  assert.equal(hidden.status, 200);
  assert.deepEqual(store.getSettings().externalProviders.find((provider) => provider.id === 'cloud').visibleModels, []);

  const unknown = await patch('inexistente', ['a']);
  assert.equal(unknown.status, 404);
  const invalid = await patch('cloud', 'no-es-lista');
  assert.equal(invalid.status, 400);
  const tooMany = await patch('cloud', Array(501).fill('m'));
  assert.equal(tooMany.status, 400);

  const settings = await fetch(`${base}/settings`, { headers: { 'x-admin-token': 'admin-secret' } });
  assert.equal(settings.status, 200);
  const payload = await settings.json();
  const cloud = payload.externalProviders.find((provider) => provider.id === 'cloud');
  assert.deepEqual(cloud.visibleModels, []);
  assert.equal(cloud.hasApiKey, true);
  assert.equal('apiKey' in cloud, false);
});
