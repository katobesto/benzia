import assert from 'node:assert/strict';
import test from 'node:test';

import { ResponseCache } from '../src/cache.js';

test('la caché expulsa la entrada menos reciente', () => {
  const cache = new ResponseCache({ ttlSeconds: 60, maxEntries: 2 });
  cache.set('a', { value: 1 });
  cache.set('b', { value: 2 });
  assert.equal(cache.get('a').value, 1);
  cache.set('c', { value: 3 });
  assert.equal(cache.get('b'), null);
  assert.equal(cache.get('a').value, 1);
  assert.equal(cache.get('c').value, 3);
});

test('la clave de caché depende de la ruta y del cuerpo', () => {
  const cache = new ResponseCache({ ttlSeconds: 60, maxEntries: 5 });
  assert.equal(cache.keyFor('/v1/chat/completions', { model: 'a' }), cache.keyFor('/v1/chat/completions', { model: 'a' }));
  assert.notEqual(cache.keyFor('/v1/chat/completions', { model: 'a' }), cache.keyFor('/v1/chat/completions', { model: 'b' }));
});

