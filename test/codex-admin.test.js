import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createAdminApp } from '../src/admin.js';

test('Codex admin endpoints expose device code and keep credentials out of settings', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'benzia-codex-admin-'));
  const settings = {};
  let authorized = false;
  const notifications = new Set();
  const codex = {
    homeDir: '',
    readAccount: async () => ({ account: authorized ? { type: 'chatgpt' } : null, requiresOpenaiAuth: true }),
    startDeviceLogin: async () => ({ type: 'chatgptDeviceCode', loginId: 'login-1', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-1234' }),
    on: (_event, handler) => { notifications.add(handler); return () => notifications.delete(handler); },
    listModels: async () => [{ id: 'gpt-codex-a', name: 'Codex A' }],
    readRateLimits: async () => ({ fiveHour: { usedPercent: 29, resetsAt: 1770000000 }, weekly: { usedPercent: 72, resetsAt: 1770500000 } }),
    logout: async () => {}, cancelDeviceLogin: async () => {}
  };
  const store = {
    getSettings: () => structuredClone(settings),
    updateSettings: async (patch) => Object.assign(settings, structuredClone(patch)),
    storageStats: () => null
  };
  const app = createAdminApp({ config: { adminToken: 'admin-secret', dataDir, upstreamBaseUrl: 'http://127.0.0.1:1234', upstreamApiKey: '', braveSearchEndpoint: '', braveSearchApiKey: '', publicGatewayUrl: 'http://127.0.0.1:3401', gatewayPort: 3401, adminPort: 3400, metricsRetentionDays: 30, codexAppServer: codex }, store });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); await fs.rm(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}/admin/api`;
  const auth = { 'x-admin-token': 'admin-secret', 'content-type': 'application/json' };
  assert.equal((await fetch(`${base}/codex/rate-limits`, { headers: auth })).status, 404);
  assert.equal((await fetch(`${base}/codex/rate-limits`)).status, 401);

  const started = await fetch(`${base}/codex/login/start`, { method: 'POST', headers: auth, body: '{}' });
  assert.equal(started.status, 200);
  assert.deepEqual(await started.json(), { type: 'chatgptDeviceCode', loginId: 'login-1', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-1234' });

  const pending = await fetch(`${base}/codex/login/login-1`, { headers: auth });
  assert.equal(pending.status, 202);
  assert.deepEqual(await pending.json(), { pending: true });
  authorized = true;
  await Promise.all([...notifications].map((notify) => notify({ method: 'account/login/completed', params: { loginId: 'login-1', success: true } })));
  const completed = await fetch(`${base}/codex/login/login-1`, { headers: auth });
  assert.equal(completed.status, 200);
  assert.deepEqual(await completed.json(), { authorized: true });

  const modelsResponse = await fetch(`${base}/codex/models`, { method: 'POST', headers: auth, body: '{}' });
  assert.equal(modelsResponse.status, 200);
  assert.deepEqual(await modelsResponse.json(), { models: [{ id: 'gpt-codex-a', name: 'Codex A' }] });

  settings.codexOpenAI = { connected: true, selectedModel: '', models: [{ id: 'gpt-codex-a', name: 'Codex A' }], accessToken: 'DO-NOT-RETURN' };
  const usageResponse = await fetch(`${base}/codex/rate-limits`, { headers: auth });
  assert.equal(usageResponse.status, 200);
  assert.deepEqual(await usageResponse.json(), { fiveHour: { usedPercent: 29, resetsAt: 1770000000 }, weekly: { usedPercent: 72, resetsAt: 1770500000 } });
  const settingsResponse = await fetch(`${base}/settings`, { headers: auth });
  const exposed = await settingsResponse.json();
  assert.deepEqual(exposed.codexOpenAI, { connected: true, selectedModel: '', models: [{ id: 'gpt-codex-a', name: 'Codex A' }] });
  assert.equal(JSON.stringify(exposed).includes('DO-NOT-RETURN'), false);
});

test('Codex usage endpoint returns a safe error when app-server is unavailable', async (t) => {
  const app = createAdminApp({
    config: { adminToken: 'test', gatewayPort: 3401, codexAppServer: { readRateLimits: async () => { throw new Error('sensitive backend diagnostic'); } } },
    store: { getSettings: () => ({ codexOpenAI: { connected: true } }), storageStats: () => null }
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/admin/api/codex/rate-limits`, { headers: { 'x-admin-token': 'test' } });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'No se pudieron consultar los límites de Codex.' });
});

test('Codex model selection rejects IDs not present in the authorized catalog', async (t) => {
  const settings = { codexOpenAI: { connected: true, selectedModel: '', models: [{ id: 'gpt-codex-a', name: 'Codex A' }] } };
  const store = { getSettings: () => structuredClone(settings), updateSettings: async (patch) => Object.assign(settings, structuredClone(patch)), storageStats: () => null };
  const app = createAdminApp({ config: { adminToken: 'admin-secret', dataDir: os.tmpdir(), upstreamBaseUrl: 'http://127.0.0.1:1234', upstreamApiKey: '', braveSearchEndpoint: '', braveSearchApiKey: '', publicGatewayUrl: 'http://127.0.0.1:3401', gatewayPort: 3401, adminPort: 3400, metricsRetentionDays: 30, codexAppServer: {} }, store });
  const server = app.listen(0, '127.0.0.1'); await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/admin/api/settings`, { method: 'PATCH', headers: { 'x-admin-token': 'admin-secret', 'content-type': 'application/json' }, body: JSON.stringify({ codexSelectedModel: 'not-available' }) });
  assert.equal(response.status, 400);
});

test('cancelar autorización Codex limpia su listener y finaliza el estado pendiente', async (t) => {
  const notifications = new Set();
  const codex = {
    readAccount: async () => ({ requiresOpenaiAuth: true }),
    startDeviceLogin: async () => ({ type: 'chatgptDeviceCode', loginId: 'login-cancel', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-1234' }),
    on: (_event, handler) => { notifications.add(handler); return () => notifications.delete(handler); },
    cancelDeviceLogin: async () => {}
  };
  const store = { getSettings: () => ({}), updateSettings: async () => {}, storageStats: () => null };
  const app = createAdminApp({ config: { adminToken: 'admin-secret', dataDir: os.tmpdir(), upstreamBaseUrl: 'http://127.0.0.1:1234', upstreamApiKey: '', braveSearchEndpoint: '', braveSearchApiKey: '', publicGatewayUrl: 'http://127.0.0.1:3401', gatewayPort: 3401, adminPort: 3400, metricsRetentionDays: 30, codexAppServer: codex }, store });
  const server = app.listen(0, '127.0.0.1'); await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/admin/api/codex`;
  const headers = { 'x-admin-token': 'admin-secret', 'content-type': 'application/json' };
  await fetch(`${base}/login/start`, { method: 'POST', headers, body: '{}' });
  assert.equal(notifications.size, 1);
  const cancelled = await fetch(`${base}/login/cancel`, { method: 'POST', headers, body: JSON.stringify({ loginId: 'login-cancel' }) });
  assert.equal(cancelled.status, 200);
  assert.equal(notifications.size, 0);
  const status = await fetch(`${base}/login/login-cancel`, { headers });
  assert.equal(status.status, 404);
});
