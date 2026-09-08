import assert from 'node:assert/strict';
import test from 'node:test';

import { formatBraveContext, normalizeBraveEndpoint, validateSearchQuery } from '../src/brave-search.js';

test('valida el endpoint y la consulta de Brave antes de hacer peticiones externas', () => {
  assert.equal(normalizeBraveEndpoint('https://api.search.brave.com/res/v1/web/search/'), 'https://api.search.brave.com/res/v1/web/search');
  assert.throws(() => normalizeBraveEndpoint('http://api.search.brave.com/res/v1/web/search'), /HTTPS/);
  assert.equal(validateSearchQuery('  últimas noticias de IA  '), 'últimas noticias de IA');
  assert.throws(() => validateSearchQuery(''), /consulta/);
});

test('reduce la respuesta de Brave a fuentes web seguras y acotadas', () => {
  const result = formatBraveContext({
    web: { results: [
      { title: 'Fuente fiable', url: 'https://example.com/informe', description: 'Dato útil.' },
      { title: 'No válida', url: 'javascript:alert(1)', description: 'Nunca se incluye.' },
      { title: 'Duplicada', url: 'https://example.com/informe', description: 'Duplicada.' }
    ] }
  });
  assert.deepEqual(result.sources, [{ title: 'Fuente fiable', url: 'https://example.com/informe', hostname: 'example.com' }]);
  assert.match(result.context, /\[1\] Fuente fiable/);
  assert.doesNotMatch(result.context, /Nunca se incluye/);
});
