import assert from 'node:assert/strict';
import test from 'node:test';

import express from 'express';

import { createGatewayApp } from '../src/proxy.js';
import { LiveActivity } from '../src/live-activity.js';
import { reasoningEffortsForModel } from '../src/model-capabilities.js';

async function listen(t, app) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

async function fixture(t) {
  const received = [];
  const upstream = express();
  upstream.use(express.json());
  upstream.use((req, res) => {
    received.push({ path: req.path, body: req.body });
    if (req.path === '/v1/responses') {
      return res.json({ id: 'resp_1', object: 'response', status: 'completed', model: req.body.model, output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '4' }] }], usage: { input_tokens: 10, output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 } } });
    }
    return res.json({ id: 'cmpl_1', object: 'chat.completion', model: req.body.model, choices: [{ index: 0, message: { role: 'assistant', content: '4' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 1 } });
  });
  const baseUrl = await listen(t, upstream);
  const store = {
    getSettings: () => ({}),
    findKeyByToken: () => ({ id: 'k-1', name: 'Prueba', allowExternalProviders: false }),
    recordMetric: async () => {}
  };
  const gateway = await listen(t, createGatewayApp({
    config: { upstreamBaseUrl: baseUrl, upstreamApiKey: '', requestTimeoutMs: 1000 },
    store, liveActivity: new LiveActivity()
  }));
  const send = (path, body) => fetch(`${gateway}${path}`, {
    method: 'POST',
    headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { received, send };
}

test('Responses API: traslada el esfuerzo al campo reasoning.effort del proveedor local', async t => {
  const f = await fixture(t);
  const response = await f.send('/v1/responses', { model: 'qwen3.5-2b-mtp', input: 'hola', reasoning_effort: 'none' });
  assert.equal(response.status, 200);
  assert.equal(f.received[0].body.reasoning?.effort, 'none');
});

test('Responses API: no pisa un reasoning.effort ya enviado por el cliente', async t => {
  const f = await fixture(t);
  const response = await f.send('/v1/responses', { model: 'qwen3.5-2b-mtp', input: 'hola', reasoning: { effort: 'low' } });
  assert.equal(response.status, 200);
  assert.equal(f.received[0].body.reasoning.effort, 'low');
});

test('Chat Completions: acepta el esfuerzo en reasoning.effort y lo normaliza', async t => {
  const f = await fixture(t);
  const response = await f.send('/v1/chat/completions', { model: 'qwen3.5-2b-mtp', messages: [{ role: 'user', content: 'hola' }], reasoning: { effort: 'none' } });
  assert.equal(response.status, 200);
  assert.equal(f.received[0].body.reasoning_effort, 'none');
});

test('rechaza esfuerzos que el modelo no admite, venga por la via que venga', async t => {
  const f = await fixture(t);
  const viaChat = await f.send('/v1/chat/completions', { model: 'qwen3.5-2b-mtp', messages: [{ role: 'user', content: 'hola' }], reasoning_effort: 'max' });
  assert.equal(viaChat.status, 400);
  const chatError = await viaChat.json();
  assert.equal(chatError.error.param, 'reasoning_effort');
  assert.match(chatError.error.message, /no es válido/);
  assert.match(chatError.error.message, /none, minimal, low, medium, high, xhigh/);

  const viaResponses = await f.send('/v1/responses', { model: 'qwen3.5-2b-mtp', input: 'hola', reasoning: { effort: 'max' } });
  assert.equal(viaResponses.status, 400);
  assert.equal((await viaResponses.json()).error.param, 'reasoning.effort');
});

// Regresion de Qwen 3.8: ya funcionaba con reasoning_effort y no debe cambiar.
test('Qwen 3.8 en Chat Completions: el cuerpo llega intacto, sin objeto reasoning', async t => {
  const f = await fixture(t);
  const body = { model: 'qwen3.8-27b', messages: [{ role: 'user', content: 'hola' }], reasoning_effort: 'medium', max_tokens: 512 };
  const response = await f.send('/v1/chat/completions', body);
  assert.equal(response.status, 200);
  assert.deepEqual(f.received[0].body, body);
});

test('Qwen 3.8 en Responses API: conserva reasoning_effort y solo se añade el complemento', async t => {
  const f = await fixture(t);
  const response = await f.send('/v1/responses', { model: 'qwen3.8-27b', input: 'hola', reasoning_effort: 'xhigh', max_output_tokens: 4096 });
  assert.equal(response.status, 200);
  assert.equal(f.received[0].body.reasoning_effort, 'xhigh');
  assert.equal(f.received[0].body.reasoning.effort, 'xhigh');
  assert.equal(f.received[0].body.max_output_tokens, 4096);
});

test('Qwen 3.8 conserva su lista de esfuerzos y no gana "minimal" ni "high"', async () => {
  assert.deepEqual(reasoningEffortsForModel('qwen3.8-27b'), ['none', 'low', 'medium', 'xhigh']);
  assert.deepEqual(reasoningEffortsForModel('unsloth/qwen3.8-27b-gguf/qwen3.8-27b-ud-q4_k_s.gguf'), ['none', 'low', 'medium', 'xhigh']);
});

test('un reasoning de Chat Completions con mas campos no se elimina', async t => {
  const f = await fixture(t);
  const response = await f.send('/v1/chat/completions', { model: 'qwen3.5-2b-mtp', messages: [{ role: 'user', content: 'hola' }], reasoning: { effort: 'low', summary: 'auto' } });
  assert.equal(response.status, 200);
  assert.equal(f.received[0].body.reasoning_effort, 'low');
  assert.deepEqual(f.received[0].body.reasoning, { effort: 'low', summary: 'auto' });
});
