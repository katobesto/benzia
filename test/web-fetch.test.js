import assert from 'node:assert/strict';
import test from 'node:test';

import { extractReadableText, isPrivateAddress } from '../src/web-fetch.js';

test('bloquea direcciones privadas, loopback y reservadas (SSRF)', () => {
  for (const address of [
    '127.0.0.1', '127.5.5.5', '10.10.0.9', '172.16.3.4', '192.168.1.254',
    '169.254.169.254', '0.0.0.0', '100.64.0.1', '224.0.0.5', '240.0.0.1',
    '::1', '::', 'fe80::1', 'fc00::12', 'fd12:3456::78', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:192.168.0.1', 'not-an-ip'
  ]) {
    assert.equal(isPrivateAddress(address), true, `${address} debería bloquearse`);
  }
});

test('permite direcciones públicas', () => {
  for (const address of ['8.8.8.8', '93.184.216.34', '2606:4700:4700::1111', '2a00:1450:4001:82b::200e']) {
    assert.equal(isPrivateAddress(address), false, `${address} debería permitirse`);
  }
});

test('extrae texto legible de HTML eliminando scripts, estilos y etiquetas', () => {
  const html = `<!doctype html><html><head><title>Mi &amp; p&#225;gina</title>
    <script>var secreto = 1;</script><style>body{color:red}</style></head>
    <body><nav>Menú de navegación</nav><h1>Título</h1><p>Párrafo uno.</p><p>Párrafo&nbsp;dos.</p></body></html>`;
  const result = extractReadableText(html, 1000);
  assert.equal(result.title, 'Mi & página');
  assert.doesNotMatch(result.text, /secreto|color:red/);
  assert.match(result.text, /Título/);
  assert.match(result.text, /Párrafo uno\.\s*\n?\s*Párrafo dos\./);
  assert.equal(result.truncated, false);
});

test('trunca el texto extraído al límite indicado', () => {
  const html = `<p>${'a'.repeat(500)}</p>`;
  const result = extractReadableText(html, 100);
  assert.equal(result.text.length, 100);
  assert.equal(result.truncated, true);
});
