import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeSearchProvider, resolveSearchProvider } from '../src/web-search.js';
import { parseDuckDuckGoResults, formatDuckDuckGoContext } from '../src/duckduckgo-search.js';

test('resuelve el proveedor de búsqueda según la configuración y la clave de Brave', () => {
  assert.equal(resolveSearchProvider({ provider: 'auto', hasBraveKey: true }), 'brave');
  assert.equal(resolveSearchProvider({ provider: 'auto', hasBraveKey: false }), 'duckduckgo');
  assert.equal(resolveSearchProvider({ provider: 'duckduckgo', hasBraveKey: true }), 'duckduckgo');
  assert.equal(resolveSearchProvider({ provider: 'brave', hasBraveKey: false }), 'brave');
  assert.equal(resolveSearchProvider({ provider: 'inexistente', hasBraveKey: false }), 'duckduckgo');
  assert.equal(normalizeSearchProvider('  DuckDuckGo '), 'duckduckgo');
  assert.equal(normalizeSearchProvider(undefined), 'auto');
});

test('analiza los resultados HTML de DuckDuckGo y decodifica los enlaces de redirección', () => {
  const html = `
    <div class="result">
      <div class="result__body">
        <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Finforme&rut=abc">Informe &amp; datos</a></h2>
        <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Finforme">Un <b>extracto</b> útil.</a>
      </div>
    </div>
    <div class="result">
      <div class="result__body">
        <h2><a class="result__a" href="https://otro.example/pagina">Otra fuente</a></h2>
        <a class="result__snippet">Segundo extracto.</a>
      </div>
    </div>
    <div class="result">
      <div class="result__body">
        <a class="result__a" href="javascript:alert(1)">Enlace inseguro</a>
      </div>
    </div>`;
  const sources = parseDuckDuckGoResults(html);
  assert.equal(sources.length, 2);
  assert.equal(sources[0].url, 'https://example.com/informe');
  assert.equal(sources[0].title, 'Informe & datos');
  assert.deepEqual(sources[0].snippets, ['Un extracto útil.']);
  assert.equal(sources[1].url, 'https://otro.example/pagina');

  const formatted = formatDuckDuckGoContext(sources);
  assert.match(formatted.context, /\[1\] Informe & datos\nURL: https:\/\/example.com\/informe/);
  assert.deepEqual(formatted.sources[0], { title: 'Informe & datos', url: 'https://example.com/informe', hostname: 'example.com' });
});

test('un HTML sin resultados produce una lista vacía sin errores', () => {
  assert.deepEqual(parseDuckDuckGoResults('<html><body>sin resultados</body></html>'), []);
  assert.deepEqual(parseDuckDuckGoResults(''), []);
});
