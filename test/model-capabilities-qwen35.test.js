import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

import { annotateModel, reasoningEffortsForModel } from '../src/model-capabilities.js';

const QWEN35 = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];

test('detecta Qwen 3.5 y ofrece el esfuerzo comprobado contra el upstream', () => {
  assert.deepEqual(reasoningEffortsForModel('qwen3.5-2b-mtp'), QWEN35);
  assert.deepEqual(reasoningEffortsForModel('unsloth/qwen3.5-9b-gguf/qwen3.5-9b-ud-q4_k_s.gguf'), QWEN35);
  assert.deepEqual(reasoningEffortsForModel('Qwen3.5-27B-Instruct'), QWEN35);
  assert.deepEqual(reasoningEffortsForModel('qwen-3.5-4b'), QWEN35);
  // "max" no lo acepta el upstream de Qwen 3.5.
  assert.ok(!reasoningEffortsForModel('qwen3.5-2b-mtp').includes('max'));
});

test('no confunde Qwen 3.5 con Qwen 3 de 5B ni con Qwen 3.8', () => {
  assert.deepEqual(reasoningEffortsForModel('qwen3-5b-instruct'), []);
  assert.deepEqual(reasoningEffortsForModel('qwen3-30b-a3b'), []);
  assert.deepEqual(reasoningEffortsForModel('llama-3.1-8b'), []);
  assert.deepEqual(reasoningEffortsForModel('qwen3.8-27b'), ['none', 'low', 'medium', 'xhigh']);
});

test('las capacidades declaradas siguen teniendo prioridad sobre la familia', () => {
  const declared = { 'qwen3.5-2b-mtp': { input: ['text'], output: ['text'], reasoning_effort: ['none', 'low'] } };
  assert.deepEqual(reasoningEffortsForModel('qwen3.5-2b-mtp', declared), ['none', 'low']);
});

test('el gateway anota qwen3.5 con reasoning_effort para el chat', () => {
  const annotated = annotateModel({ id: 'qwen3.5-2b-mtp', object: 'model' }, {});
  assert.ok(annotated.supported_parameters.includes('reasoning_effort'));
  assert.deepEqual(annotated.benzIA_supported_parameters.reasoning_effort.enum, QWEN35);
});

test('el chat muestra el tick de pensamiento junto al esfuerzo', async () => {
  const [html, client, styles] = await Promise.all([
    fs.readFile(new URL('../chat-public/index.html', import.meta.url), 'utf8'),
    fs.readFile(new URL('../chat-public/chat.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../chat-public/chat.css', import.meta.url), 'utf8')
  ]);
  assert.match(html, /type="checkbox" id="reasoning-thinking" checked/);
  assert.match(html, /<span>Pensamiento<\/span>/);
  assert.match(client, /THINKING_DISABLED_KEY/);
  assert.match(client, /function thinkingDisabled/);
  assert.match(client, /function reasoningEffortSelection/);
  assert.ok(client.includes('qwen[\\s._-]*3[\\s._-]*5'));
  assert.match(client, /reasoning_effort: reasoningEffort/);
  assert.match(styles, /\.reasoning-effort-control \.thinking-toggle/);
});
