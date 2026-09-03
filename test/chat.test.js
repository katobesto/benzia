import assert from 'node:assert/strict';
import test from 'node:test';

import { createChatApp } from '../src/chat.js';

async function listen(app) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

test('sirve la interfaz de chat sin exponer su configuración', async (t) => {
  const store = {
    getSettings: () => ({ publicGatewayUrl: 'https://gateway.example.test' }),
    findKeyByToken: (token) => token === 'valid-user-token'
      ? { id: 'key-1', name: 'Equipo QA', pausedAt: null, revokedAt: null }
      : token === 'paused-user-token'
        ? { id: 'key-2', name: 'Equipo pausado', pausedAt: new Date().toISOString(), revokedAt: null }
        : null
  };
  const app = createChatApp({ config: { publicGatewayUrl: 'http://localhost:3401' }, store });
  const { server, baseUrl } = await listen(app);
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const page = await fetch(`${baseUrl}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /benzIA Chat/);

  const stylesheet = await fetch(`${baseUrl}/chat.css`);
  assert.equal(stylesheet.status, 200);

  const chatClient = await fetch(`${baseUrl}/chat.js`);
  assert.equal(chatClient.status, 200);
  const chatSource = await chatClient.text();
  assert.match(chatSource, /endpoint}\/responses/);
  assert.match(chatSource, /store: false/);
  assert.match(chatSource, /localStorage\.setItem\(TOKEN_KEY, token\)/);
  assert.doesNotMatch(chatSource, /sessionStorage\.setItem\(TOKEN_KEY, token\)/);

  const marked = await fetch(`${baseUrl}/vendor/marked.umd.js`);
  assert.equal(marked.status, 200);
  assert.match(await marked.text(), /marked v18/);

  const purifier = await fetch(`${baseUrl}/vendor/purify.min.js`);
  assert.equal(purifier.status, 200);
  assert.match(await purifier.text(), /DOMPurify/);

  const blocked = await fetch(`${baseUrl}/api/config`);
  assert.equal(blocked.status, 401);

  const blockedUpload = await fetch(`${baseUrl}/api/attachments/extract`, { method: 'POST' });
  assert.equal(blockedUpload.status, 401);

  const rejected = await fetch(`${baseUrl}/api/config`, { headers: { authorization: 'Bearer wrong-token' } });
  assert.equal(rejected.status, 401);

  const paused = await fetch(`${baseUrl}/api/config`, { headers: { authorization: 'Bearer paused-user-token' } });
  assert.equal(paused.status, 200);
  assert.deepEqual(await paused.json(), {
    endpoint: 'https://gateway.example.test/v1',
    identity: { id: 'key-2', name: 'Equipo pausado' }
  });

  const allowed = await fetch(`${baseUrl}/api/config`, { headers: { authorization: 'Bearer valid-user-token' } });
  assert.equal(allowed.status, 200);
  assert.deepEqual(await allowed.json(), {
    endpoint: 'https://gateway.example.test/v1',
    identity: { id: 'key-1', name: 'Equipo QA' }
  });

  const form = new FormData();
  form.append('file', new Blob(['Texto adjunto de prueba'], { type: 'text/plain' }), 'prueba.txt');
  const extracted = await fetch(`${baseUrl}/api/attachments/extract`, {
    method: 'POST',
    headers: { authorization: 'Bearer valid-user-token' },
    body: form
  });
  assert.equal(extracted.status, 200);
  assert.deepEqual(await extracted.json(), {
    name: 'prueba.txt',
    type: 'text/plain',
    size: 23,
    text: 'Texto adjunto de prueba',
    truncated: false,
    kind: 'txt'
  });
});
