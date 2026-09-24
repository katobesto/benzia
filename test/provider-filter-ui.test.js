import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('claves API expone el filtro de proveedores externos visibles por clave', async () => {
  const html = await fs.readFile(path.join(projectRoot, 'public/index.html'), 'utf8');
  const app = await fs.readFile(path.join(projectRoot, 'public/app.js'), 'utf8');
  assert.match(html, /id="provider-dialog"/);
  assert.match(html, /id="provider-filter-list"/);
  assert.match(html, /id="provider-filter-form"/);
  assert.match(app, /function openProviderFilter\(/);
  assert.match(app, /provider-filter/);
  assert.match(app, /providerIds/);
  assert.match(app, /method: 'PATCH'/);
  // El botón solo debe aparecer cuando la clave permite externos.
  assert.match(app, /key\.allowExternalProviders\s*\n?\s*\?/);
});