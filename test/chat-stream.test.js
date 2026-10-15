import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

const source = await fs.readFile(new URL('../chat-public/chat.js', import.meta.url), 'utf8');
// Run the actual pure stream helpers without booting the browser-only UI.
const context = vm.createContext({ TextDecoder });
for (const [start, end] of [
  ['function estimateTokens(', 'function estimateContextInputTokens('],
  ['function consumeSse(', 'function webGroundingInstruction(']
]) vm.runInContext(source.slice(source.indexOf(start), source.indexOf(end)), context);

test('la estimación incremental conserva exactamente la estimación de texto completo', () => {
  const texts = ['', '  ', '\nHola café 👋 世界\n', 'const value = 42;\n'.repeat(300), '\u2003a\u00a0 b \t\n'];
  for (const text of texts) {
    for (const width of [1, 2, 3, 7, 100]) {
      const estimate = context.incrementalTokenEstimate();
      let result = 0;
      for (let i = 0; i < text.length; i += width) {
        result = estimate(text.slice(i, i + width));
        assert.equal(result, context.estimateTokens(text.slice(0, i + width)));
      }
      assert.equal(result, context.estimateTokens(text));
    }
  }
});

test('el lector SSE conserva UTF-8 fragmentado, CRLF, datos multilínea y el evento final sin delimitador', async () => {
  const encoded = new TextEncoder().encode(': ping\r\ndata: {"delta":\r\ndata: "¡Sí! 👋"}\r\n\r\ndata: nope\n\ndata: [DONE]\n\ndata: {"usage":42}');
  let offset = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (offset === encoded.length) return controller.close();
      controller.enqueue(encoded.slice(offset, ++offset));
    }
  });
  const events = [];
  await context.readSse({ body: stream }, event => events.push(JSON.parse(JSON.stringify(event))));
  assert.deepEqual(events, [{ delta: '¡Sí! 👋' }, { usage: 42 }]);
});

test('los errores de investigación se propagan y cancelan el lector', async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('data: {"type":"research.error"}\n\n')); },
    cancel() { cancelled = true; }
  });
  await assert.rejects(context.readSse({ body: stream }, () => { throw new Error('Sin fuentes'); }), /Sin fuentes/);
  assert.equal(cancelled, true);
  assert.equal(stream.locked, false);
});

test('el worker usa las librerías locales para Markdown y sintaxis sin ejecutar el HTML generado', async () => {
  const [worker, marked, highlight] = await Promise.all([
    fs.readFile(new URL('../chat-public/render-worker.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../node_modules/marked/lib/marked.umd.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../node_modules/@highlightjs/cdn-assets/highlight.min.js', import.meta.url), 'utf8')
  ]);
  const replies = [];
  const workerContext = vm.createContext({ postMessage: result => replies.push(result) });
  workerContext.self = workerContext;
  workerContext.importScripts = path => vm.runInContext(path.includes('marked') ? marked : highlight, workerContext);
  vm.runInContext(worker, workerContext);
  workerContext.onmessage({ data: { id: 1, type: 'markdown', text: '**Hola**\n\n- uno' } });
  assert.match(replies[0].html, /<strong>Hola<\/strong>/);
  workerContext.onmessage({ data: { id: 2, type: 'highlight', text: 'Dim value As Integer = 42', language: 'vbnet' } });
  assert.match(replies[1].html, /hljs-keyword/);
  workerContext.onmessage({ data: { id: 3, type: 'highlight', text: '<script>alert(1)</script>', language: 'xml' } });
  assert.doesNotMatch(replies[2].html, /<script>/);
});
