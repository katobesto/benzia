import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const [html, client, styles] = await Promise.all([
  fs.readFile(new URL('../chat-public/index.html', import.meta.url), 'utf8'),
  fs.readFile(new URL('../chat-public/chat.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../chat-public/chat.css', import.meta.url), 'utf8')
]);

test('el chat permite regenerar sustituyendo la última respuesta', () => {
  assert.match(client, /function regenerateLastResponse\(\)/);
  assert.match(client, /conversation\.messages\.pop\(\)/);
  assert.match(client, /regenerate-message/);
  assert.match(client, /Regenerar la última respuesta/);
  assert.match(styles, /\.regenerate-message/);
});

test('Qwen 3.8 27B muestra el esfuerzo y lo envía en ambos protocolos', () => {
  assert.match(html, /id="reasoning-effort-control"/);
  assert.match(html, /<span>Esfuerzo<\/span>/);
  assert.match(html, /value="low"/);
  assert.match(html, /value="medium"/);
  assert.match(html, /value="xhigh"/);
  assert.match(client, /function supportsQwen38ReasoningEffort/);
  assert.match(client, /reasoning_effort: reasoningEffort/);
  assert.match(styles, /\.reasoning-effort-control/);
  assert.match(styles, /\.reasoning-effort-control select option \{ background: #242424; color: #f2f2f2;/);
});

test('benzIA Chat muestra el total estimado de contexto, pensamiento y respuesta', () => {
  assert.match(client, /generatedTokenEstimate/);
  assert.match(client, /inputEstimate \+ generatedEstimate/);
  assert.match(client, /totalTokens: inputTokens \+ outputTokens/);
  assert.match(client, /reasoningTokensEstimated/);
  assert.match(client, /statChip\('total'/);
});
