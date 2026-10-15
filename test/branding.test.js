import assert from 'node:assert/strict';
import test from 'node:test';

import { createAdminApp } from '../src/admin.js';
import { createChatApp } from '../src/chat.js';

async function listen(app) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

const pngLogo = `data:image/png;base64,${Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64')}`;

test('el branding se guarda, valida el logotipo y conserva los valores por defecto', async (t) => {
  const store = {
    settings: {},
    getSettings() { return this.settings; },
    async updateSettings(patch) { this.settings = { ...this.settings, ...structuredClone(patch) }; return this.settings; },
    storageStats: () => null
  };
  const app = createAdminApp({ config: { adminToken: 'admin-secret' }, store });
  const { server, baseUrl } = await listen(app);
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const settingsUrl = `${baseUrl}/admin/api/settings`;
  const getSettings = () => fetch(settingsUrl, { headers: { 'x-admin-token': 'admin-secret' } });
  const save = (branding) => fetch(settingsUrl, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-admin-token': 'admin-secret' },
    body: JSON.stringify({ branding })
  });

  const defaults = await getSettings();
  assert.equal(defaults.status, 200);
  assert.deepEqual((await defaults.json()).branding, { name: 'benzIA', logoDataUrl: null });

  const saved = await save({ name: '  Mi marca  ', logoDataUrl: pngLogo });
  assert.equal(saved.status, 200);
  assert.deepEqual(store.getSettings().branding, { name: 'Mi marca', logoDataUrl: pngLogo });

  const nameOnly = await save({ name: 'Otra marca' });
  assert.equal(nameOnly.status, 200);
  assert.deepEqual(store.getSettings().branding, { name: 'Otra marca', logoDataUrl: pngLogo });

  assert.equal((await save({ name: ' ' })).status, 400);
  assert.equal((await save({ name: 'Logo inseguro', logoDataUrl: 'data:image/svg+xml,<svg onload=alert(1)>' })).status, 400);
  assert.equal((await save({ name: 'Formato incorrecto', logoDataUrl: 'data:image/png;base64,Zm9v' })).status, 400);
  assert.equal((await save({ name: 'Grande', logoDataUrl: `data:image/png;base64,${'A'.repeat(850_001)}` })).status, 400);

  const reset = await save({ name: 'Otra marca', logoDataUrl: null });
  assert.equal(reset.status, 200);
  assert.deepEqual(store.getSettings().branding, { name: 'Otra marca', logoDataUrl: null });
});

test('el chat publica la identidad configurada con los valores originales como reserva', async (t) => {
  const store = { getSettings: () => ({ branding: { name: 'Mi marca', logoDataUrl: pngLogo } }) };
  const app = createChatApp({ config: {}, store });
  const { server, baseUrl } = await listen(app);
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const response = await fetch(`${baseUrl}/api/branding`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control'), /no-store/);
  assert.deepEqual(await response.json(), { name: 'Mi marca', logoDataUrl: pngLogo });

  store.getSettings = () => ({});
  const defaults = await fetch(`${baseUrl}/api/branding`);
  assert.deepEqual(await defaults.json(), { name: 'benzIA', logoDataUrl: null });
});
