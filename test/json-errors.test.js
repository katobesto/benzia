import assert from 'node:assert/strict';
import test from 'node:test';

import { createAdminApp } from '../src/admin.js';
import { createChatApp } from '../src/chat.js';
import { createGatewayApp } from '../src/proxy.js';

async function listen(app) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

const malformedJson = {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{"model":"modelo",'
};

test('rechaza JSON malformado de forma controlada en todas las superficies', async (t) => {
  const store = {
    getSettings: () => ({}),
    findKeyByToken: () => ({ id: 'key-1', name: 'Pruebas' }),
    recordMetric: async () => {}
  };
  const apps = [
    createGatewayApp({
      config: { upstreamBaseUrl: 'http://127.0.0.1:1', upstreamApiKey: '', requestTimeoutMs: 1000 },
      store
    }),
    createChatApp({ config: { publicGatewayUrl: 'http://localhost:3401' }, store }),
    createAdminApp({ config: { adminToken: 'admin-secret' }, store })
  ];
  const instances = await Promise.all(apps.map(listen));
  instances.forEach(({ server }) => t.after(() => new Promise((resolve) => server.close(resolve))));

  for (const { url } of instances) {
    const response = await fetch(url, malformedJson);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: { message: 'El cuerpo JSON no es válido o está incompleto.', type: 'invalid_json', code: 'invalid_json', param: null }
    });
  }
});
