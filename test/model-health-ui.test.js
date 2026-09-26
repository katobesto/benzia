import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const [html, client, styles] = await Promise.all([
  fs.readFile(new URL('../chat-public/index.html', import.meta.url), 'utf8'),
  fs.readFile(new URL('../chat-public/chat.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../chat-public/chat.css', import.meta.url), 'utf8')
]);

test('benzIA Chat permite probar modelos y descartar los que no responden', () => {
  assert.match(html, /id="model-health-button"/);
  assert.match(html, /Descartar modelos caídos/);
  assert.match(html, /model-health-status/);
  assert.match(html, /\/chat\/model-health\.js/);
  assert.match(client, /BenziaModelHealth\.probeModels/);
  assert.match(client, /\/chat\/api\/config/);
  assert.match(client, /config\.paused/);
  assert.match(client, /hideFailedModels/);
  assert.ok((client.match(/fetch\('\/chat\/api\/config'/g) || []).length >= 3);
  const accessReset = client.slice(client.indexOf('function showAccess'), client.indexOf('function instructionsSummary'));
  assert.match(accessReset, /replaceChildren\(\)/);
  assert.match(accessReset, /updateModelHealthButton\(\)/);
  assert.match(styles, /\.model-health-button/);
  assert.match(styles, /@media \(max-width: 620px\)/);
});
