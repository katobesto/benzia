import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

const source = await fs.readFile(new URL('../chat-public/chat.js', import.meta.url), 'utf8');
const metadata = {};
const context = vm.createContext({ state: { modelMetadata: metadata }, DEFAULT_MAX_OUTPUT_TOKENS: 65536, selectedModel: () => 'model' });
vm.runInContext(source.slice(source.indexOf('function positiveTokenLimit('), source.indexOf('function compactTokenCount(')), context);
const limits = () => JSON.parse(JSON.stringify(context.modelTokenLimits()));

test('Qwen Flash Next lee el contexto anunciado por NInfer en meta.n_ctx sin inventar un máximo de salida', () => {
  metadata.model = { id: 'qwen3.8-flash-next-iq3_s', meta: { n_ctx: 262144 } };
  assert.deepEqual(limits(), { contextLength: 262144, loadedContext: 262144, outputLimit: null });
  assert.equal(context.outputTokenBudget(), 65536);
});

test('distingue contexto teórico y cargado y conserva los formatos compatibles existentes', () => {
  metadata.model = { max_context_length: 262144, loaded_context_length: 180000, top_provider: { max_completion_tokens: 16384 } };
  assert.deepEqual(limits(), { contextLength: 262144, loadedContext: 180000, outputLimit: 16384 });
  assert.equal(context.outputTokenBudget(), 16384);
  metadata.model = { meta: { n_ctx_train: 1048576, n_ctx: 262144 } };
  assert.deepEqual(limits(), { contextLength: 1048576, loadedContext: 262144, outputLimit: null });
});

test('un valor inválido no oculta límites válidos y el máximo del proveedor no cambia el presupuesto del chat', () => {
  metadata.model = { max_context_length: 0, context_window: 1048576, top_provider: { max_completion_tokens: -1 }, max_output_tokens: 393216 };
  assert.deepEqual(limits(), { contextLength: 1048576, loadedContext: null, outputLimit: 393216 });
  assert.equal(context.outputTokenBudget(), 65536);
  metadata.model = {};
  assert.deepEqual(limits(), { contextLength: null, loadedContext: null, outputLimit: null });
});
