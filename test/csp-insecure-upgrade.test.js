import assert from 'node:assert/strict';
import test from 'node:test';

import { createChatApp } from '../src/chat.js';
import { createStatusApp } from '../src/status.js';

async function listen(app) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

const store = {
  getSettings: () => ({}),
  findKeyByToken: () => ({ id: 'key-1', name: 'Equipo QA', pausedAt: null, revokedAt: null })
};

test('el chat por HTTP no envía upgrade-insecure-requests y la CSS se puede cargar', async (t) => {
  const app = createChatApp({ config: { cspUpgradeInsecureRequests: false }, store });
  const { server, baseUrl } = await listen(app);
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const page = await fetch(`${baseUrl}/`);
  assert.equal(page.status, 200);
  const csp = page.headers.get('content-security-policy') || '';
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /style-src 'self'/);
  assert.doesNotMatch(csp, /upgrade-insecure-requests/);

  const css = await fetch(`${baseUrl}/chat.css`);
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type') || '', /text\/css/);
});

test('la directiva se conserva cuando el gateway publica HTTPS', async (t) => {
  const app = createChatApp({ config: { cspUpgradeInsecureRequests: true }, store });
  const { server, baseUrl } = await listen(app);
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const page = await fetch(`${baseUrl}/`);
  const csp = page.headers.get('content-security-policy') || '';
  assert.match(csp, /upgrade-insecure-requests/);
});

test('el estado público sigue la misma regla que el chat', async (t) => {
  const app = createStatusApp({ config: { cspUpgradeInsecureRequests: false }, store, liveActivity: { snapshot: () => ({}) } });
  const { server, baseUrl } = await listen(app);
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const page = await fetch(`${baseUrl}/`);
  assert.equal(page.status, 200);
  const csp = page.headers.get('content-security-policy') || '';
  assert.match(csp, /default-src 'self'/);
  assert.doesNotMatch(csp, /upgrade-insecure-requests/);
});
