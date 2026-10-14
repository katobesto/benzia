import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';

import express from 'express';

import { createGatewayApp } from '../src/proxy.js';
import { LiveActivity } from '../src/live-activity.js';
import { StreamMetrics } from '../src/stream-metrics.js';
import { estimateTokens } from '../src/usage.js';

async function listen(t, app) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

async function fixture(t, handler, { external = false } = {}) {
  const received = [];
  const metrics = [];
  const upstream = express();
  upstream.use(express.json({ verify(req, _res, buffer) { req.rawBody = buffer.toString('utf8'); } }));
  upstream.use((req, res) => {
    received.push({ path: req.path, body: req.body, rawBody: req.rawBody, headers: req.headers });
    return handler(req, res, received.length);
  });
  const baseUrl = await listen(t, upstream);
  const liveActivity = new LiveActivity();
  const store = {
    getSettings: () => external ? { externalProviders: [{ id: 'remote', name: 'Remote', baseUrl }] } : {},
    findKeyByToken: () => ({ id: 'cache-test', name: 'Cache test', allowExternalProviders: external }),
    recordMetric: async metric => metrics.push(metric)
  };
  const gateway = await listen(t, createGatewayApp({
    config: { upstreamBaseUrl: baseUrl, upstreamApiKey: '', requestTimeoutMs: 1000 },
    store, liveActivity
  }));
  return {
    received, metrics, liveActivity,
    send: (path, body) => fetch(`${gateway}${path}`, {
      method: 'POST', headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
  };
}

const history = [
  { role: 'system', content: '  Instrucciones estables\r\nSQL y español 日本語.\n' },
  { role: 'user', content: [{ type: 'text', text: 'Consulta exacta\tcon espacios  ' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA', detail: 'auto' } }] },
  { role: 'assistant', content: '', reasoning_content: 'Razonamiento anterior\n sin normalizar  ', tool_calls: [{ id: 'call_stable', type: 'function', function: { name: 'query', arguments: '{ "z":2, "a":1 }' } }] },
  { role: 'tool', tool_call_id: 'call_stable', content: '{ "rows": [1,2] }' },
  { role: 'assistant', content: 'Resultado exacto.', reasoning: 'Otra forma de historial de razonamiento' },
  { role: 'user', content: 'Continúa.' }
];

function cachedRequest() {
  return {
    model: 'qwen3.8-27b', messages: structuredClone(history),
    tools: [{ type: 'function', function: { name: 'query', parameters: { type: 'object', properties: { z: { type: 'integer' }, a: { type: 'integer' } } } } }],
    tool_choice: 'auto', parallel_tool_calls: false,
    reasoning_effort: 'medium', preserve_thinking: true,
    chat_template_kwargs: { preserve_thinking: true },
    cache_prompt: true, prompt_cache_key: 'stable-prefix', prompt_cache_retention: 'in_memory',
    id_slot: 3, n_keep: 512, session_id: 'stable-session',
    max_tokens: 32768, seed: 42, stream: true, stream_options: { include_usage: true }
  };
}

const cachedSse = Buffer.from(': keep-alive\r\n\r\n' +
  'data: {"choices":[{"delta":{"content":"Español 日本語 🙂"}}]}\r\n\r\n' +
  'data: {"choices":[],"usage":{"prompt_tokens":86040,"completion_tokens":142,"prompt_tokens_details":{"cached_tokens":85973}}}\r\n\r\n' +
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\r\n\r\n' +
  'data: [DONE]\r\n\r\n');

test('el proxy conserva byte a byte el historial y controles KV, y no confunde métricas con caché', async t => {
  const f = await fixture(t, async (_req, res) => {
    res.type('text/event-stream');
    // Split UTF-8 characters and CRLF delimiters across transport chunks.
    for (let offset = 0; offset < cachedSse.length; offset += 7) {
      res.write(cachedSse.subarray(offset, offset + 7));
      await setImmediate();
    }
    res.end();
  });
  const body = cachedRequest();
  for (let turn = 0; turn < 2; turn++) {
    const response = await f.send('/v1/chat/completions', body);
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), cachedSse);
    assert.equal(f.received[turn].rawBody, JSON.stringify(body));
    assert.equal(f.metrics[turn].lmCachedInputTokens, 85973);
    assert.equal(f.metrics[turn].inputTokens, 86040);
    assert.equal(f.metrics[turn].usageSource, 'upstream');
    assert.equal(f.liveActivity.snapshot().activeStreams, 0);
    body.messages.push({ role: 'assistant', content: 'Respuesta nueva', reasoning_content: 'Pensamiento nuevo' }, { role: 'user', content: 'Otro turno' });
  }
  assert.deepEqual(f.received[1].body.messages.slice(0, history.length), history);
  assert.equal(f.received.length, 2, 'una inferencia por turno; ninguna llamada auxiliar al modelo');
});

test('Responses conserva input, instrucciones, identidad de caché y continuidad sin convertir protocolos', async t => {
  const f = await fixture(t, (_req, res) => res.json({ output: [], usage: { input_tokens: 12, output_tokens: 1, input_tokens_details: { cached_tokens: 10 } } }));
  const body = {
    model: 'qwen3.8-27b', instructions: '  prefijo estable\n',
    previous_response_id: 'resp_previous', prompt_cache_key: 'stable-cache',
    preserve_thinking: true, reasoning: { effort: 'medium' },
    input: [
      { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'Pensamiento previo' }], encrypted_content: 'opaque-content' },
      { type: 'function_call_output', call_id: 'call_1', output: '{ "z":2, "a":1 }' }
    ],
    store: false, max_output_tokens: 32768, stream: false
  };
  const response = await f.send('/v1/responses', body);
  await response.text();
  assert.equal(response.status, 200);
  assert.equal(f.received.length, 1);
  assert.equal(f.received[0].path, '/v1/responses');
  assert.equal(f.received[0].rawBody, JSON.stringify(body));
  assert.equal(f.metrics[0].lmCachedInputTokens, 10);
});

test('el enrutado externo cambia exclusivamente el identificador público del modelo', async t => {
  const f = await fixture(t, (_req, res) => res.type('text/event-stream').end(cachedSse), { external: true });
  const body = cachedRequest();
  body.model = 'remote/qwen3.8-27b';
  const response = await f.send('/v1/chat/completions', body);
  await response.text();
  assert.equal(f.received[0].rawBody, JSON.stringify({ ...body, model: 'qwen3.8-27b' }));
});

test('la negociación de include_usage conserva el prefijo y todos los controles KV', async t => {
  const f = await fixture(t, (req, res) => {
    if (req.body.stream_options?.include_usage) return res.status(400).json({ error: { param: 'stream_options.include_usage', message: 'Unsupported parameter' } });
    return res.type('text/event-stream').end(cachedSse);
  });
  const body = cachedRequest();
  body.stream_options.vendor_option = 'keep';
  const compatible = { ...body, stream_options: { vendor_option: 'keep' } };
  for (let turn = 0; turn < 2; turn++) {
    const response = await f.send('/v1/chat/completions', body);
    assert.equal(response.status, 200);
    await response.text();
  }
  assert.equal(f.received.length, 3);
  assert.equal(f.received[0].rawBody, JSON.stringify(body));
  assert.equal(f.received[1].rawBody, JSON.stringify(compatible));
  assert.equal(f.received[2].rawBody, JSON.stringify(compatible));
});

test('un error de contexto no repite el prefill aunque incluya una copia de la petición', async t => {
  const f = await fixture(t, (req, res) => res.status(400).json({ error: { message: 'Context too long', request: req.body } }));
  const response = await f.send('/v1/chat/completions', cachedRequest());
  assert.equal(response.status, 400);
  assert.match(await response.text(), /Context too long/);
  assert.equal(f.received.length, 1);
});

test('los controles de caché y de uso desactivados por el cliente se conservan', async t => {
  const f = await fixture(t, (_req, res) => res.type('text/event-stream').end(cachedSse));
  const body = cachedRequest();
  body.cache_prompt = false;
  body.stream_options.include_usage = false;
  const response = await f.send('/v1/chat/completions', body);
  await response.text();
  assert.equal(f.received[0].rawBody, JSON.stringify(body));
  assert.equal(f.received.length, 1);
});

test('el observador no duplica snapshots ni borra la caché reportada al recibir un stop', () => {
  const observer = new StreamMetrics();
  const events = [
    { type: 'response.output_text.delta', delta: 'España 日本語 🙂' },
    { type: 'response.completed', response: { output: [{ content: [{ text: 'España 日本語 🙂' }] }], usage: { input_tokens: 100, output_tokens: 5, input_tokens_details: { cached_tokens: 90 } } } },
    { type: 'response.done' }
  ];
  const bytes = Buffer.from(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
  for (const byte of bytes) observer.write(Uint8Array.of(byte));
  observer.end();
  assert.equal(observer.estimator.tokens, estimateTokens('España 日本語 🙂'));
  assert.equal(observer.payload.usage.input_tokens_details.cached_tokens, 90);
  assert.equal(observer.payload.usage.output_tokens, 5);
});
