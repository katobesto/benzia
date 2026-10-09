import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCodexChatCompletion, normalizeCodexDeviceLogin, normalizeCodexModels, CodexAppServer } from '../src/codex-provider.js';

test('stdio startup sends initialize without waiting on its own startup promise', async () => {
  const { EventEmitter } = await import('node:events');
  const { PassThrough } = await import('node:stream');
  const codex = new CodexAppServer({ codexPath: 'fake-codex', spawnProcess: () => {
    const proc = new EventEmitter(); proc.exitCode = null;
    proc.stdout = new PassThrough(); proc.stderr = new PassThrough();
    proc.stdin = { write(line, callback) {
      const message = JSON.parse(line);
      if (message.method === 'initialize') queueMicrotask(() => proc.stdout.write(JSON.stringify({ id: message.id, result: {} }) + String.fromCharCode(10)));
      callback?.(); return true;
    } };
    proc.kill = () => { proc.exitCode = 0; proc.emit('exit', 0); };
    queueMicrotask(() => proc.emit('spawn'));
    return proc;
  } });
  await Promise.race([codex.ensureStarted(), new Promise((_, reject) => setTimeout(() => reject(new Error('startup deadlocked')), 100))]);
  await codex.close();
});

test('device-code login starts via app-server and publishes returned URL and code', async () => {
  const calls = [];
  const codex = new CodexAppServer({ request: async (method, params) => {
    calls.push({ method, params });
    return { type: 'chatgptDeviceCode', loginId: 'login-1', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-1234' };
  } });
  assert.deepEqual(await codex.startDeviceLogin(), { type: 'chatgptDeviceCode', loginId: 'login-1', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-1234' });
  assert.deepEqual(calls, [{ method: 'account/login/start', params: { type: 'chatgptDeviceCode' } }]);
});

test('device login response retains only safe public fields', () => {
  assert.deepEqual(normalizeCodexDeviceLogin({ type: 'chatgptDeviceCode', loginId: 'abc', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-1234', token: 'secret' }), {
    type: 'chatgptDeviceCode', loginId: 'abc', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-1234'
  });
});

test('model catalog pagination returns available non-hidden Codex models', async () => {
  let page = 0;
  const codex = new CodexAppServer({ request: async (method, params) => {
    assert.equal(method, 'model/list'); assert.equal(params.includeHidden, false); page += 1;
    return page === 1 ? { data: [{ id: 'gpt-codex-a', displayName: 'Codex A', hidden: false }, { id: 'secret-hidden', hidden: true }], nextCursor: 'next' }
      : { data: [{ id: 'gpt-codex-b', displayName: 'Codex B', hidden: false }], nextCursor: null };
  } });
  assert.deepEqual(await codex.listModels(), [{ id: 'gpt-codex-a', name: 'Codex A' }, { id: 'gpt-codex-b', name: 'Codex B' }]);
});

test('public catalog contains only the single selected OpenAI model', () => {
  assert.deepEqual(normalizeCodexModels([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], 'b'), [{ id: 'openai/b', object: 'model', owned_by: 'OpenAI Codex', name: 'B' }]);
  assert.deepEqual(normalizeCodexModels([{ id: 'a' }], ''), []);
});

test('client cancellation interrupts the active Codex turn', async () => {
  const calls = [];
  const codex = new CodexAppServer({ request: async (method, params) => {
    calls.push({ method, params });
    if (method === 'thread/start') return { thread: { id: 'thread-cancel' } };
    if (method === 'turn/start') return { turn: { id: 'turn-cancel' } };
    return {};
  } });
  const controller = new AbortController();
  const result = await codex.generate({ model: 'openai/model', messages: [{ role: 'user', content: 'cancel me' }] }, { signal: controller.signal });
  controller.abort(new Error('client disconnected'));
  await assert.rejects(result.completion, /client disconnected/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(calls.some(({ method, params }) => method === 'turn/interrupt' && params.threadId === 'thread-cancel' && params.turnId === 'turn-cancel'));
});

test('late turn/start response is interrupted when the client already disconnected', async () => {
  const calls = [];
  let resolveTurnStart;
  const codex = new CodexAppServer({ request: async (method, params) => {
    calls.push({ method, params });
    if (method === 'thread/start') return { thread: { id: 'thread-late-cancel' } };
    if (method === 'turn/start') return new Promise((resolve) => { resolveTurnStart = resolve; });
    return {};
  } });
  const controller = new AbortController();
  const generation = codex.generate({ model: 'openai/model', messages: [{ role: 'user', content: 'cancel while starting' }] }, { signal: controller.signal });
  while (!resolveTurnStart) await new Promise((resolve) => setImmediate(resolve));
  controller.abort(new Error('client disconnected during turn/start'));
  resolveTurnStart({ turn: { id: 'turn-late-cancel' } });
  const result = await generation;
  await assert.rejects(result.completion, (error) => error.message === 'client disconnected during turn/start');
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(calls.some(({ method, params }) => method === 'turn/interrupt' && params.threadId === 'thread-late-cancel' && params.turnId === 'turn-late-cancel'));
});

test('OpenAI chat request becomes a read-only Codex turn and returns generated text', async () => {
  const calls = [];
  const codex = new CodexAppServer({ request: async (method, params) => {
    calls.push({ method, params });
    if (method === 'thread/start') return { thread: { id: 'thread-1' } };
    if (method === 'turn/start') {
      codex.emit('notification', { method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', delta: 'Hi' } });
      codex.emit('notification', { method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } });
      return { turn: { id: 'turn-1' } };
    }
    throw new Error(`Unexpected RPC ${method}`);
  } });
  const deltas = [];
  const result = await codex.generate({ model: 'openai/gpt-codex-a', messages: [{ role: 'user', content: 'Hello' }] }, { onDelta: (delta) => deltas.push(delta) });
  assert.deepEqual(calls.map(({ method }) => method), ['thread/start', 'turn/start']);
  assert.equal(calls[0].params.approvalPolicy, 'never');
  assert.equal(calls[0].params.sandbox, 'read-only');
  assert.equal(calls[1].params.input[0].text, 'user: Hello');
  codex.emit('notification', { method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', delta: 'Hi' } });
  codex.emit('notification', { method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } });
  assert.equal(await result.completion, 'Hi');
  assert.deepEqual(deltas, ['Hi']);
});
