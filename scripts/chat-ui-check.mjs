import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import express from 'express';
import { createChatApp } from '../src/chat.js';

// Use an installed Playwright, or the desktop runtime without adding a runtime
// dependency to the application: PLAYWRIGHT_MODULE_PATH=/.../playwright/index.mjs.
const modulePath = process.env.PLAYWRIGHT_MODULE_PATH;
const { chromium } = await import(modulePath ? pathToFileURL(modulePath).href : 'playwright');
let browser;
let server;
let baseUrl;
const requests = [];
const savedAt = '2026-10-15T08:00:00.000Z';
const image = { kind: 'image', name: 'pixel.png', size: 68, type: 'image/png', dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=' };
const document = { kind: 'document', name: 'nota.txt', size: 10, type: 'text/plain', documentKind: 'txt', text: 'Documento conservado' };
const finalCode = '\n\n```vb.net\nDim valor As Integer = 42\n```\n\n```html\n<!doctype html><html><body>Vista previa</body></html>\n```\n\n<img src=x onerror="alert(1)"><script>alert(1)</script>\n[enlace](javascript:alert(1))';

before(async () => {
  const app = express();
  app.use(express.json({ limit: '20mb' }));
  app.get('/v1/models', (_req, res) => res.json({ data: [{ id: 'test-model', meta: { n_ctx: 262144 }, benzIA_supported_parameters: { reasoning_effort: { enum: ['none', 'low', 'medium', 'xhigh'] } } }, { id: 'fallback-model', context_window: 1048576, max_output_tokens: 393216 }] }));
  app.post('/chat/api/research/stream', (_req, res) => {
    res.set('content-type', 'text/event-stream');
    const sources = [{ url: 'https://example.com/evidence', title: 'Fuente de prueba', hostname: 'example.com' }];
    for (const event of [
      { type: 'research.status', step: 'planning', label: 'Planificando' },
      { type: 'research.plan', topic: 'Prueba', queries: ['consulta'], shouldSearch: true },
      { type: 'research.search', index: 1, total: 1, query: 'consulta', sources: 1 },
      { type: 'research.sources', sources },
      { type: 'research.complete', sources, context: 'DOSSIER_TEMPORAL_DE_PRUEBA [1]' }
    ]) res.write(`data: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  app.post(['/v1/responses', '/v1/chat/completions'], async (req, res) => {
    requests.push({ path: req.path, body: req.body });
    if (req.body.model === 'fallback-model' && req.path === '/v1/responses') return res.status(404).json({ error: 'Unsupported /v1/responses' });
    const responses = req.path.endsWith('/responses');
    res.set({ 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.flushHeaders();
    const write = payload => res.write(`data: ${JSON.stringify(payload)}\n\n`);
    const thought = 'Comprobando el contexto. '; // hidden and expanded reasoning are both tested.
    write(responses ? { type: 'response.reasoning_text.delta', delta: thought } : { choices: [{ delta: { reasoning_content: thought } }] });
    const chunks = ['Primer párrafo estable. [1]\n\n', ...Array.from({ length: 36 }, (_, i) => `Párrafo ${i}: **texto** y contexto conservado.\n\n`), finalCode];
    for (const delta of chunks) {
      if (res.destroyed) return;
      write(responses ? { type: 'response.output_text.delta', delta } : { choices: [{ delta: { content: delta } }] });
      await new Promise(resolve => setTimeout(resolve, 18));
    }
    // Intentionally omit the final SSE separator.
    res.end(`data: ${JSON.stringify(responses ? { type: 'response.completed', response: { usage: { input_tokens: 44, output_tokens: 222 } } } : { choices: [], usage: { prompt_tokens: 44, completion_tokens: 222 } })}`);
  });
  app.use('/chat', createChatApp({ config: {}, store: {
    getSettings: () => ({ braveSearchApiKey: 'qa-brave-placeholder' }), findKeyByToken: token => token === 'qa-token' ? { id: 'qa', name: 'Pruebas' } : null
  } }));
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
});

after(async () => {
  await browser?.close();
  server?.closeAllConnections();
  if (server) await new Promise(resolve => server.close(resolve));
});

async function openChat({ long = false, workers = true } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(({ long, workers, image, document, savedAt }) => {
    if (top !== self) return;
    if (!workers) window.Worker = class { constructor() { throw new Error('Workers disabled for test'); } };
    // Seed only the first navigation; reload must exercise the real saved data.
    if (localStorage.getItem('qa-seeded')) return;
    localStorage.setItem('qa-seeded', 'true');
    localStorage.setItem('benzIA_chat_access_token', 'qa-token');
    const messages = long ? Array.from({ length: 120 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `Mensaje ${i}\n\n${'Contenido de historial **conservado**. '.repeat(8)}` })) : [];
    if (long) {
      messages.splice(10, 0, { role: 'system', content: 'Sistema guardado' });
      messages[0].attachments = [image, document];
    }
    localStorage.setItem('benzIA_chat_conversations_v1', JSON.stringify([{ id: 'saved', title: 'Chat guardado', model: 'test-model', createdAt: savedAt, updatedAt: savedAt, instructions: { preset: 'ciencia', custom: 'Responde en español.' }, messages }]));
    localStorage.setItem('benzIA_chat_active_v1', 'saved');
  }, { long, workers, image, document, savedAt });
  await page.goto(`${baseUrl}/chat`);
  await page.waitForFunction(() => !document.querySelector('#send-button').disabled);
  return { context, page, errors };
}

async function send(page, text = 'Nueva pregunta') {
  await page.locator('#message-input').fill(text);
  await page.locator('#send-button').click();
  await page.waitForFunction(() => document.querySelector('.message.pending .message-content')?.textContent.includes('Primer párrafo estable'));
}

async function complete(page, highlight = false) {
  await page.waitForFunction(() => !document.querySelector('.message.pending'));
  if (highlight) {
    await page.locator('.message:last-child pre code').first().scrollIntoViewIfNeeded();
    await page.waitForFunction(() => document.querySelector('.message:last-child pre code.hljs span'));
  }
}

test('historial largo: actualiza con mensajes de sistema, conserva el DOM y envía todo el contexto', async t => {
  const { context, page, errors } = await openChat({ long: true });
  t.after(() => context.close());
  await page.evaluate(() => { window.originalArticle = document.querySelector('.message'); });
  const offset = requests.length;
  await send(page);
  await page.evaluate(() => { window.firstParagraph = document.querySelector('.message.pending .message-content p'); });
  await page.waitForFunction(() => document.querySelector('.message.pending .message-content')?.textContent.includes('Párrafo 8'));
  assert.equal(await page.evaluate(() => firstParagraph === document.querySelector('.message.pending .message-content p')), true);
  await complete(page, true);
  assert.equal(await page.evaluate(() => firstParagraph === document.querySelector('.message:last-child .message-content p')), true);
  assert.equal(await page.evaluate(() => originalArticle === document.querySelector('.message')), true);
  assert.equal(await page.locator('.message').count(), 122);
  assert.match(await page.locator('.message:last-child .message-stats').textContent(), /266 tokens/);
  assert.equal(await page.locator('.message:last-child .message-content img, .message:last-child .message-content script, .message:last-child a[href^="javascript:"]').count(), 0);
  assert.equal(await page.locator('.message:last-child .code-preview').count(), 1);
  await page.locator('.message:last-child .code-toolbar button').filter({ hasText: 'Copiar código' }).first().click();
  assert.equal(await page.evaluate(async () => (await navigator.clipboard.readText()).replace(/\r\n/g, '\n')), 'Dim valor As Integer = 42\n');
  const body = requests[offset].body;
  assert.equal(body.store, false);
  assert.equal(body.reasoning_effort, 'medium');
  assert.ok(body.input.some(item => item.role === 'system' && item.content.includes('Responde en español.')));
  assert.ok(body.input.some(item => item.role === 'system' && item.content === 'Sistema guardado'));
  assert.match(JSON.stringify(body.input), /Documento conservado/);
  assert.match(JSON.stringify(body.input), /data:image\/png;base64/);
  await page.reload();
  await page.waitForFunction(() => !document.querySelector('#send-button').disabled);
  assert.equal(await page.locator('.message').count(), 122);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('benzIA_chat_conversations_v1'))[0]);
  assert.equal(saved.createdAt, savedAt);
  assert.equal(saved.messages[0].attachments[1].text, document.text);
  assert.equal(saved.instructions.custom, 'Responde en español.');
  assert.equal(saved.messages.at(-1).stats.outputTokens, 222);
  assert.deepEqual(errors, []);
});

test('el streaming sigue el final y respeta al usuario cuando vuelve a leer arriba', async t => {
  const { context, page, errors } = await openChat({ long: true });
  t.after(() => context.close());
  await send(page);
  await page.evaluate(() => { document.querySelector('#conversation').scrollTop = 0; });
  await complete(page);
  assert.ok(await page.locator('#conversation').evaluate(element => element.scrollTop < 10));
  assert.equal(await page.locator('#jump-to-latest').isVisible(), true);
  await page.locator('#jump-to-latest').click();
  await page.waitForFunction(() => { const v = document.querySelector('#conversation'); return v.scrollHeight - v.clientHeight - v.scrollTop < 4; });
  await send(page);
  await complete(page);
  await page.waitForFunction(() => { const v = document.querySelector('#conversation'); return v.scrollHeight - v.clientHeight - v.scrollTop < 4; });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => { const v = document.querySelector('#conversation'); return v.scrollHeight - v.clientHeight - v.scrollTop < 4; });
  assert.deepEqual(errors, []);
});

test('detener conserva la respuesta parcial y regenerar la sustituye', async t => {
  const { context, page, errors } = await openChat();
  t.after(() => context.close());
  await send(page);
  await page.locator('#stop-button').click();
  await page.waitForFunction(() => !document.querySelector('.message.pending'));
  assert.match(await page.locator('.message:last-child .message-content').textContent(), /Primer párrafo estable/);
  assert.equal(await page.locator('.message').count(), 2);
  await page.locator('.regenerate-message').click();
  await complete(page);
  assert.equal(await page.locator('.message').count(), 2);
  assert.deepEqual(errors, []);
});

test('recuerda temporalmente un Responses incompatible sin perder controles ni historial', async t => {
  const { context, page, errors } = await openChat();
  t.after(() => context.close());
  await page.locator('#model-select').selectOption('fallback-model');
  const offset = requests.length;
  await send(page, 'Pregunta uno');
  await complete(page);
  await send(page, 'Pregunta dos');
  await complete(page);
  const calls = requests.slice(offset);
  assert.deepEqual(calls.map(call => call.path), ['/v1/responses', '/v1/chat/completions', '/v1/chat/completions']);
  assert.ok(calls[2].body.messages.some(message => message.content.includes('Pregunta uno')));
  assert.match(calls[2].body.messages[0].content, /Responde en español/);
  assert.equal(calls[2].body.stream_options.include_usage, true);
  assert.deepEqual(errors, []);
});

test('sin workers mantiene Markdown, sintaxis y razonamiento desplegable', async t => {
  const { context, page, errors } = await openChat({ workers: false });
  t.after(() => context.close());
  await send(page);
  await page.locator('.message.pending .thinking-toggle').click();
  assert.match(await page.locator('.message.pending .thinking-content').textContent(), /Comprobando/);
  await complete(page, true);
  assert.match(await page.locator('.message:last-child .thinking-content').textContent(), /Comprobando/);
  assert.deepEqual(errors, []);
});

test('lee los límites de llama.cpp/NInfer y distingue el máximo de salida del presupuesto del chat', async t => {
  const { context, page, errors } = await openChat();
  t.after(() => context.close());
  const note = page.locator('#model-limit-note');
  assert.match(await note.textContent(), /Contexto 262k · salida no publicada · petición 32/);
  assert.match((await note.getAttribute('title')).replace(/[^\d]/g, ''), /262144/);
  assert.match(await note.getAttribute('title'), /no publica un límite independiente/);
  await page.locator('#model-select').selectOption('fallback-model');
  assert.match(await note.textContent(), /Contexto 1M · salida máx. 393k · petición 32/);
  await send(page);
  await complete(page);
  assert.equal(requests.at(-1).body.max_tokens, 32768);
  assert.deepEqual(errors, []);
});

test('la investigación conserva fuentes y citas, y el dossier solo viaja en su turno', async t => {
  const { context, page, errors } = await openChat();
  t.after(() => context.close());
  const offset = requests.length;
  await page.locator('#web-search-button').click();
  await send(page, 'Consulta con fuentes');
  await complete(page);
  assert.equal(await page.locator('.message:last-child .source-citation').getAttribute('href'), 'https://example.com/evidence');
  assert.match(JSON.stringify(requests[offset].body), /DOSSIER_TEMPORAL_DE_PRUEBA/);
  await page.locator('#web-search-button').click();
  await send(page, 'Pregunta sin búsqueda');
  await complete(page);
  assert.doesNotMatch(JSON.stringify(requests[offset + 1].body), /DOSSIER_TEMPORAL_DE_PRUEBA/);
  assert.deepEqual(errors, []);
});

test('el compositor y todos los controles caben en móvil, tableta, portátil y con teclado reducido', async t => {
  const { context, page, errors } = await openChat();
  t.after(() => context.close());
  for (const [width, height] of [[320, 640], [390, 844], [768, 740], [1024, 768], [1440, 900], [390, 400]]) {
    await page.setViewportSize({ width, height });
    await page.waitForFunction(() => Math.abs(document.querySelector('.chat-stage').getBoundingClientRect().height - visualViewport.height) < 2);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `horizontal overflow at ${width}`);
    for (const selector of ['#model-select', '#model-health-button', '#instructions-button', '#change-token', '#message-input', '#web-search-button', '#attach-button', '#reasoning-effort', '#send-button']) {
      const box = await page.locator(selector).boundingBox();
      const fits = box && box.width > 12 && box.x >= 0 && box.x + box.width <= width + 1 && box.y + box.height <= height + 1;
      assert.ok(fits, `${selector} outside ${width}×${height}: ${JSON.stringify(box)}`);
    }
  }
  await page.locator('#mobile-rail').click();
  assert.equal(await page.evaluate(() => document.body.classList.contains('rail-open')), true);
  await page.locator('#rail-close').click();
  assert.equal(await page.evaluate(() => document.body.classList.contains('rail-open')), false);
  assert.deepEqual(errors, []);
});

