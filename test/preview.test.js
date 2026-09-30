import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

import { createChatApp } from '../src/chat.js';

async function listen(app) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

const DOCUMENT = '<!doctype html><html lang="es"><head><style>h1{color:red}</style></head><body><h1>Hola</h1><script>var p=1</script></body></html>';

test('la vista previa HTML guarda el documento y lo sirve en un marco aislado', async (t) => {
  const store = {
    getSettings: () => ({}),
    findKeyByToken: (token) => token === 'valid-user-token'
      ? { id: 'key-1', name: 'Equipo QA', pausedAt: null, revokedAt: null }
      : null
  };
  const app = createChatApp({ config: {}, store });
  const { server, baseUrl } = await listen(app);
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const chatPage = await fetch(`${baseUrl}/`);
  assert.equal(chatPage.status, 200);
  assert.match(chatPage.headers.get('content-security-policy') || '', /default-src 'self'/);

  const blocked = await fetch(`${baseUrl}/api/preview`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: DOCUMENT });
  assert.equal(blocked.status, 401);

  const rejected = await fetch(`${baseUrl}/api/preview`, {
    method: 'POST',
    headers: { authorization: 'Bearer wrong-token', 'content-type': 'text/plain' },
    body: DOCUMENT
  });
  assert.equal(rejected.status, 401);

  const created = await fetch(`${baseUrl}/api/preview`, {
    method: 'POST',
    headers: { authorization: 'Bearer valid-user-token', 'content-type': 'text/plain' },
    body: DOCUMENT
  });
  assert.equal(created.status, 200);
  const { doc } = await created.json();
  assert.match(doc, /^[0-9a-f]{36}$/);

  const wrapper = await fetch(`${baseUrl}/api/preview?doc=${doc}`);
  assert.equal(wrapper.status, 200);
  assert.match(wrapper.headers.get('content-type'), /text\/html/);
  assert.match(wrapper.headers.get('cache-control'), /no-store/);
  const wrapperCsp = wrapper.headers.get('content-security-policy') || '';
  assert.match(wrapperCsp, /script-src 'none'/);
  assert.match(wrapperCsp, /frame-src 'self'/);
  const wrapperHtml = await wrapper.text();
  assert.match(wrapperHtml, /sandbox="allow-scripts"/);
  assert.doesNotMatch(wrapperHtml, /var p=1/);
  assert.doesNotMatch(wrapperHtml, /<h1/);
  const frameUrl = wrapperHtml.match(/src="((?:preview-frame\?doc=)[^"]*)"/)?.[1];
  assert.ok(frameUrl);

  const frame = await fetch(new URL(frameUrl, `${baseUrl}/api/preview`).toString());
  assert.equal(frame.status, 200);
  assert.match(frame.headers.get('content-type'), /text\/html/);
  assert.match(frame.headers.get('cache-control'), /no-store/);
  const frameCsp = frame.headers.get('content-security-policy') || '';
  assert.match(frameCsp, /default-src 'none'/);
  assert.match(frameCsp, /script-src 'unsafe-inline' https:/);
  assert.match(frameCsp, /img-src data: https: blob:/);
  assert.equal(await frame.text(), DOCUMENT);

  const missing = await fetch(`${baseUrl}/api/preview?doc=${'a'.repeat(36)}`);
  assert.equal(missing.status, 404);
  assert.match(await missing.text(), /no disponible o expirada/);

  const malformed = await fetch(`${baseUrl}/api/preview-frame?doc=${doc.slice(0, 10)}`);
  assert.equal(malformed.status, 404);

  const withoutDoc = await fetch(`${baseUrl}/api/preview`);
  assert.equal(withoutDoc.status, 404);

  const oversized = await fetch(`${baseUrl}/api/preview`, {
    method: 'POST',
    headers: { authorization: 'Bearer valid-user-token', 'content-type': 'text/plain' },
    body: `x`.repeat(1_300_000)
  });
  assert.equal(oversized.status, 413);

  const empty = await fetch(`${baseUrl}/api/preview`, {
    method: 'POST',
    headers: { authorization: 'Bearer valid-user-token', 'content-type': 'text/plain' },
    body: '   '
  });
  assert.equal(empty.status, 400);
});

test('el chat ofrece el ojo de vista previa en los bloques HTML', async () => {
  const [html, client, styles] = await Promise.all([
    fs.readFile(new URL('../chat-public/index.html', import.meta.url), 'utf8'),
    fs.readFile(new URL('../chat-public/chat.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../chat-public/chat.css', import.meta.url), 'utf8')
  ]);

  assert.match(html, /id="preview-overlay"/);
  assert.match(html, /id="preview-frame"/);
  assert.match(html, /id="preview-close"/);
  assert.match(html, /sandbox="allow-scripts"/);
  assert.match(html, /role="dialog"/);
  assert.match(client, /code-preview/);
  assert.match(client, /fetch\('\/chat\/api\/preview'/);
  assert.match(client, /\/chat\/api\/preview\?doc=/);
  assert.match(client, /closeHtmlPreview/);
  assert.match(client, /'Escape'/);
  assert.match(client, /<!doctype\\s\+html/i);
  assert.match(styles, /\.preview-overlay/);
  assert.match(styles, /\.preview-modal/);
  assert.match(styles, /\.code-toolbar \.code-preview/);
  assert.match(styles, /@media \(max-width: 620px\)/);
});