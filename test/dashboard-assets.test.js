import assert from 'node:assert/strict';
import test from 'node:test';
import { createAdminApp } from '../src/admin.js';

test('dashboard module imports the API helper with a versioned URL and serves it without long-lived cache', async (t) => {
  const store = { getSettings: () => ({}), storageStats: () => null };
  const app = createAdminApp({ config: { adminToken: 'test', gatewayPort: 3401 }, store });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const script = await fetch(`${base}/app.js`);
  assert.equal(script.status, 200);
  const source = await script.text();
  const match = source.match(/from '\.\/api-client\.js\?v=(\d+)'/);
  assert.ok(match, 'el módulo auxiliar debe cambiar de URL entre versiones para evitar caché antigua');
  const helper = await fetch(`${base}/api-client.js?v=${match[1]}`);
  assert.equal(helper.status, 200);
  assert.match(await helper.text(), /export function providerFilterOptions/);
  assert.match(helper.headers.get('cache-control') || '', /no-(?:store|cache)|max-age=0/);
});
