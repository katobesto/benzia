import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

const source = await fs.readFile(new URL('../chat-public/model-health.js', import.meta.url), 'utf8');
const sandbox = { module: { exports: {} }, AbortController, DOMException, setTimeout, clearTimeout };
vm.runInNewContext(source, sandbox, { filename: 'model-health.js' });
const { probeModels } = sandbox.module.exports;

function response(status) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => ({ id: 'chatcmpl-test', choices: [{ message: { role: 'assistant', content: 'O' } }] }),
    body: { cancel: async () => {} }
  };
}

function hostRealm(value) {
  return JSON.parse(JSON.stringify(value));
}

test('probea chat completions con el cuerpo mínimo y conserva el orden de resultados', async () => {
  const calls = [];
  const progress = [];
  const results = await probeModels({
    models: ['alpha', 'beta'],
    endpoint: 'https://gateway.example.test/v1/',
    token: 'test-token',
    concurrency: 1,
    fetchImpl: async (url, options) => {
      calls.push({ url, options, body: JSON.parse(options.body) });
      return response(200);
    },
    onProgress: (item) => progress.push(item)
  });

  assert.deepEqual(hostRealm(results.map(({ model, status }) => ({ model, status }))), [
    { model: 'alpha', status: 'online' },
    { model: 'beta', status: 'online' }
  ]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://gateway.example.test/v1/chat/completions');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers.authorization, 'Bearer test-token');
  assert.deepEqual(calls[0].body, {
    model: 'alpha',
    messages: [{ role: 'user', content: 'OK' }],
    max_tokens: 1,
    temperature: 0,
    stream: false
  });
  assert.deepEqual(progress.map(({ completed, total }) => [completed, total]), [[1, 2], [2, 2]]);
});

test('sólo un error 404 explícito del modelo o timeout se marca caído', async () => {
  const canceled = [];
  const results = await probeModels({
    models: ['healthy', 'missing', 'vendor/alpha.v1', 'generic', 'route', 'limited', 'forbidden', 'upstream', 'paused'],
    endpoint: 'https://gateway.example.test/v1',
    token: 'test-token',
    fetchImpl: async (_url, options) => {
      const model = JSON.parse(options.body).model;
      if (model === 'paused') {
        return { ...response(200), json: async () => ({ id: 'chatcmpl-disabled_probe', choices: [{ message: { role: 'assistant', content: 'paused' } }] }), body: { cancel: async () => canceled.push(model) } };
      }
      if (model === 'missing') {
        return { ...response(404), json: async () => ({ error: { code: 'model_not_found', message: 'The model missing was not found' } }), body: { cancel: async () => canceled.push(model) } };
      }
      if (model === 'vendor/alpha.v1') {
        return { ...response(404), json: async () => ({ error: { message: 'The model vendor/alpha.v1 was not found' } }), body: { cancel: async () => canceled.push(model) } };
      }
      if (model === 'generic') {
        return { ...response(404), json: async () => ({ error: { code: 'model_not_found', message: 'Model not found' } }), body: { cancel: async () => canceled.push(model) } };
      }
      if (model === 'route') {
        return { ...response(404), json: async () => ({ error: { message: 'Chat completions route not found' } }), body: { cancel: async () => canceled.push(model) } };
      }
      const status = model === 'healthy' ? 200 : model === 'limited' ? 429 : model === 'forbidden' ? 403 : 502;
      return { ...response(status), body: { cancel: async () => canceled.push(model) } };
    }
  });

  assert.deepEqual(hostRealm(results.map(({ model, status }) => ({ model, status }))), [
    { model: 'healthy', status: 'online' },
    { model: 'missing', status: 'down' },
    { model: 'vendor/alpha.v1', status: 'down' },
    { model: 'generic', status: 'unknown' },
    { model: 'route', status: 'unknown' },
    { model: 'limited', status: 'unknown' },
    { model: 'forbidden', status: 'unknown' },
    { model: 'upstream', status: 'unknown' },
    { model: 'paused', status: 'unknown' }
  ]);
  assert.deepEqual(canceled, ['limited', 'forbidden', 'upstream']);
});

test('acota la concurrencia y considera caída una petición que supera el timeout', async () => {
  let active = 0;
  let maxActive = 0;
  const results = await probeModels({
    models: ['a', 'b', 'c', 'd', 'e'],
    endpoint: 'https://gateway.example.test/v1',
    token: 'test-token',
    concurrency: 2,
    timeoutMs: 8,
    fetchImpl: async (_url, { signal }) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 2);
        signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
      }).finally(() => { active -= 1; });
      return response(200);
    }
  });
  assert.equal(maxActive, 2);
  assert.ok(results.every(({ status }) => status === 'online'));

  const timedOut = await probeModels({
    models: ['slow'],
    endpoint: 'https://gateway.example.test/v1',
    token: 'test-token',
    timeoutMs: 5,
    fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    })
  });
  assert.deepEqual(hostRealm(timedOut.map(({ status, reason }) => ({ status, reason }))), [{ status: 'down', reason: 'timeout' }]);

  const lateResponse = await probeModels({
    models: ['late'],
    endpoint: 'https://gateway.example.test/v1',
    token: 'test-token',
    timeoutMs: 10,
    fetchImpl: async () => new Promise((resolve) => setTimeout(() => resolve(response(200)), 30))
  });
  assert.deepEqual(hostRealm(lateResponse.map(({ status, reason }) => ({ status, reason }))), [{ status: 'down', reason: 'timeout' }]);

  const networkFailure = await probeModels({
    models: ['intermittent'],
    endpoint: 'https://gateway.example.test/v1',
    token: 'test-token',
    fetchImpl: async () => { throw new TypeError('network disconnected'); }
  });
  assert.deepEqual(hostRealm(networkFailure.map(({ status, reason }) => ({ status, reason }))), [{ status: 'unknown', reason: 'network_error' }]);
});

test('abortar el análisis no marca los modelos como caídos', async () => {
  const controller = new AbortController();
  controller.abort(new DOMException('cancelled', 'AbortError'));
  await assert.rejects(probeModels({
    models: ['a'], endpoint: 'https://gateway.example.test/v1', token: 'test-token', signal: controller.signal,
    fetchImpl: async () => response(200)
  }), { name: 'AbortError' });
});
