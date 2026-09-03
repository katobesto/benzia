import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createAdminApp } from '../src/admin.js';
import { SqliteStore } from '../src/store.js';

const config = {
  adminToken: 'admin-secret',
  upstreamBaseUrl: 'http://127.0.0.1:1234',
  upstreamApiKey: '',
  publicGatewayUrl: 'http://127.0.0.1:3401',
  gatewayPort: 3401,
  adminPort: 3400,
  metricsRetentionDays: 30
};

test('la actividad se filtra conjuntamente por intervalo de fechas y token', async (t) => {
  const testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'benzIA-admin-overview-'));
  const store = new SqliteStore(testDir, 30);
  await store.init();
  const alpha = await store.createKey('Equipo Alpha');
  const beta = await store.createKey('Equipo Beta');
  const metric = (id, at, keyId, outputTokens) => ({
    id,
    at,
    keyId,
    path: '/v1/responses',
    model: 'test-model',
    status: 200,
    latencyMs: 250,
    inputTokens: 20,
    outputTokens,
    lmCachedInputTokens: 10,
    lmCacheSource: 'upstream',
    stream: false
  });
  await store.recordMetric(metric('alpha-in-range', '2026-09-02T10:00:00.000Z', alpha.id, 5));
  await store.recordMetric(metric('beta-in-range', '2026-09-02T11:00:00.000Z', beta.id, 7));
  await store.recordMetric(metric('alpha-outside-range', '2026-09-03T10:00:00.000Z', alpha.id, 9));

  const app = createAdminApp({ config, store });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    await fs.rm(testDir, { recursive: true, force: true });
  });

  const query = new URLSearchParams({
    from: '2026-09-02T00:00:00.000Z',
    to: '2026-09-02T23:59:59.999Z',
    keyId: alpha.id
  });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/admin/api/overview?${query}`, {
    headers: { 'x-admin-token': 'admin-secret' }
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.deepEqual(payload.recent.map((item) => item.id), ['alpha-in-range']);
  assert.equal(payload.totals.requests, 1);
  assert.equal(payload.totals.outputTokens, 5);
  assert.equal(payload.totals.lmCachedInputTokens, 10);
});
