import assert from 'node:assert/strict';
import test from 'node:test';
import { createGatewayApp } from '../src/proxy.js';

test('filtered token sees Codex only when openai is granted and cannot infer otherwise', async (t) => {
  const settings = { codexOpenAI: { connected: true, selectedModel: 'codex-model', models: [{ id: 'codex-model', name: 'Codex' }] } };
  const store = {
    getSettings: () => settings,
    findKeyByToken: (token) => token === 'denied' ? { id: 'denied', allowExternalProviders: true, externalProviderIds: ['cloud'] }
      : token === 'allowed' ? { id: 'allowed', allowExternalProviders: true, externalProviderIds: ['openai'] } : null,
    recordMetric: async () => {}
  };
  const gateway = createGatewayApp({ config: { upstreamBaseUrl: 'http://127.0.0.1:1', requestTimeoutMs: 1000 }, store });
  const server = gateway.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  const models = async (token) => fetch(`${base}/models`, { headers: { authorization: `Bearer ${token}` } });
  const denied = await models('denied');
  assert.equal(denied.status, 502);
  assert.deepEqual((await denied.json()).data, undefined);
  const allowed = await models('allowed');
  assert.equal(allowed.status, 200);
  assert.deepEqual((await allowed.json()).data.map(model => model.id), ['openai/codex-model']);
  const completion = await fetch(`${base}/chat/completions`, { method: 'POST', headers: { authorization: 'Bearer denied', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'openai/codex-model', messages: [{ role: 'user', content: 'Hola' }] }) });
  assert.equal(completion.status, 403);
});
