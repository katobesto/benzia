import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAdminApp } from '../src/admin.js';

test('device login completion arriving before start response remains observable', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'benzia-login-race-'));
  const listeners = new Set();
  const codex = {
    readAccount: async () => ({ account: null, requiresOpenaiAuth: true }),
    on: (_event, cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    startDeviceLogin: async () => {
      for (const listener of listeners) listener({ method: 'account/login/completed', params: { loginId: 'race-id', success: false, error: 'denied' } });
      return { type: 'chatgptDeviceCode', loginId: 'race-id', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'FAKE-CODE' };
    }
  };
  const store = { getSettings: () => ({}), updateSettings: async () => {}, storageStats: () => null };
  const app = createAdminApp({ config: { adminToken: 'test', dataDir, codexAppServer: codex }, store });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { app.locals.shutdown(); await new Promise(resolve => server.close(resolve)); await fs.rm(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}/admin/api/codex/login`;
  const headers = { 'x-admin-token': 'test', 'content-type': 'application/json' };
  const started = await fetch(`${base}/start`, { method: 'POST', headers, body: '{}' });
  assert.match(started.headers.get('x-request-id') || '', /^[a-f0-9-]{36}$/);
  assert.equal(started.status, 200);
  const status = await fetch(`${base}/race-id`, { headers });
  assert.equal(status.status, 502);
  assert.match((await status.json()).error, /autorizar/);
});
