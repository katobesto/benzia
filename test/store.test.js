import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { SqliteStore } from '../src/store.js';

test('las claves se validan por hash y dejan de funcionar al revocarse', async (t) => {
  const testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'benzIA-store-'));
  const store = new SqliteStore(testDir, 30);
  t.after(async () => { store.close(); await fs.rm(testDir, { recursive: true, force: true }); });
  await store.init();
  const created = await store.createKey('Pruebas');
  assert.ok(created.token.startsWith('lmg_'));
  assert.equal(store.findKeyByToken(created.token).name, 'Pruebas');
  assert.equal(JSON.stringify(store.listKeys()).includes(created.token), false);
  await store.revokeKey(created.id);
  assert.equal(store.findKeyByToken(created.token), null);
});

test('migra los streams históricos de miss a bypass', async (t) => {
  const testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'benzIA-store-migration-'));
  let store;
  t.after(async () => { store?.close(); await fs.rm(testDir, { recursive: true, force: true }); });
  await fs.writeFile(path.join(testDir, 'gateway.json'), JSON.stringify({
    version: 1,
    settings: {},
    keys: [],
    metrics: [
      { id: 'metric-1', at: new Date().toISOString(), keyId: 'key-1', status: 200, inputTokens: 1, outputTokens: 1, latencyMs: 10, stream: true, cacheStatus: 'miss' },
      { id: 'metric-2', at: new Date().toISOString(), keyId: 'key-1', status: 200, inputTokens: 10, outputTokens: 50, latencyMs: 2000, stream: true, cacheStatus: 'bypass', tokensPerSecond: 200, throughputSource: 'estimated' }
    ]
  }));
  store = new SqliteStore(testDir, 30);
  await store.init();
  const metrics = store.getMetrics();
  assert.equal(metrics.find((metric) => metric.id === 'metric-1').cacheStatus, 'bypass');
  assert.equal(metrics.find((metric) => metric.id === 'metric-2').tokensPerSecond, 25);
  assert.equal(metrics.find((metric) => metric.id === 'metric-2').throughputSource, 'estimated_end_to_end');
  assert.match(store.filePath, /gateway\.sqlite$/);
  assert.equal(await fs.readFile(path.join(testDir, 'gateway.json.migrated'), 'utf8').then(Boolean), true);
});
