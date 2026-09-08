import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('las barras de consumo no inyectan estilos inline bloqueados por CSP', async () => {
  const source = await fs.readFile(path.join(projectRoot, 'public/app.js'), 'utf8');
  assert.doesNotMatch(source, /class="bar-input" style=/);
  assert.doesNotMatch(source, /class="bar-output" style=/);
  assert.match(source, /<svg class="bar-track"/);
});
