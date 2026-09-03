import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createAdminApp } from '../src/admin.js';
import { SqliteStore } from '../src/store.js';

test('el panel pausa y reanuda una clave sin cambiar su token', async (t) => {
  const testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'benzIA-admin-keys-'));
  const store = new SqliteStore(testDir, 30);
  await store.init();
  const created = await store.createKey('Acceso temporal');
  const app = createAdminApp({
    config: {
      adminToken: 'admin-secret',
      upstreamBaseUrl: 'http://127.0.0.1:1234',
      upstreamApiKey: '',
      publicGatewayUrl: 'http://127.0.0.1:3401',
      gatewayPort: 3401,
      adminPort: 3400,
      metricsRetentionDays: 30
    },
    store
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    await fs.rm(testDir, { recursive: true, force: true });
  });

  const endpoint = `http://127.0.0.1:${server.address().port}/admin/api/keys/${created.id}/access`;
  const updateAccess = (paused, pausedMessage) => fetch(endpoint, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-admin-token': 'admin-secret' },
    body: JSON.stringify({ paused, ...(pausedMessage === undefined ? {} : { pausedMessage }) })
  });

  const pauseResponse = await updateAccess(true, 'Regulariza el pago para recuperar el acceso.');
  assert.equal(pauseResponse.status, 200);
  const pausedKey = (await pauseResponse.json()).key;
  assert.ok(pausedKey.pausedAt);
  assert.equal(pausedKey.pausedMessage, 'Regulariza el pago para recuperar el acceso.');
  assert.equal(store.findKeyByToken(created.token), null);
  assert.ok(store.findKeyByToken(created.token, { includeInactive: true }).pausedAt);

  const editResponse = await updateAccess(true, 'Contacta con Benzo para revisar tu cuenta.');
  assert.equal(editResponse.status, 200);
  const editedKey = (await editResponse.json()).key;
  assert.equal(editedKey.pausedAt, pausedKey.pausedAt);
  assert.equal(editedKey.pausedMessage, 'Contacta con Benzo para revisar tu cuenta.');

  const tooLongResponse = await updateAccess(true, 'x'.repeat(501));
  assert.equal(tooLongResponse.status, 400);

  const resumeResponse = await updateAccess(false);
  assert.equal(resumeResponse.status, 200);
  const resumedKey = (await resumeResponse.json()).key;
  assert.equal(resumedKey.pausedAt, null);
  assert.equal(resumedKey.pausedMessage, 'Contacta con Benzo para revisar tu cuenta.');
  assert.equal(store.findKeyByToken(created.token).id, created.id);
});
