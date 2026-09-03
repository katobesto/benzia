import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('el dashboard conserva el token administrativo en el navegador', async () => {
  const source = await fs.readFile(path.join(projectRoot, 'public/app.js'), 'utf8');
  assert.match(source, /localStorage\.setItem\(ADMIN_TOKEN_KEY, state\.token\)/);
  assert.match(source, /localStorage\.removeItem\(ADMIN_TOKEN_KEY\)/);
  assert.doesNotMatch(source, /sessionStorage\.setItem\(ADMIN_TOKEN_KEY, state\.token\)/);
});
