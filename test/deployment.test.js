import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

test('la imagen Docker usa el runtime soportado e incluye las interfaces públicas', async () => {
  const dockerfile = await fs.readFile(new URL('../Dockerfile', import.meta.url), 'utf8');

  assert.match(dockerfile, /^FROM node:24-alpine$/m);
  assert.match(dockerfile, /^COPY public \.\/public$/m);
  assert.match(dockerfile, /^COPY chat-public \.\/chat-public$/m);
});
