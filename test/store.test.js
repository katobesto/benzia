import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { DatabaseSync } from 'node:sqlite';

import { hashToken, SqliteStore } from '../src/store.js';

test('las claves pueden pausarse, reanudarse y revocarse definitivamente', async (t) => {
  const testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'benzIA-store-'));
  const store = new SqliteStore(testDir, 30);
  t.after(async () => { store.close(); await fs.rm(testDir, { recursive: true, force: true }); });
  await store.init();
  const created = await store.createKey('Pruebas');
  assert.ok(created.token.startsWith('lmg_'));
  assert.equal(store.findKeyByToken(created.token).name, 'Pruebas');
  assert.equal(JSON.stringify(store.listKeys()).includes(created.token), false);
  const paused = await store.setKeyPaused(created.id, true, 'Pago pendiente. Contacta con soporte.');
  assert.ok(paused.pausedAt);
  assert.equal(paused.pausedMessage, 'Pago pendiente. Contacta con soporte.');
  assert.equal(store.findKeyByToken(created.token), null);
  assert.ok(store.findKeyByToken(created.token, { includeInactive: true }).pausedAt);
  const resumed = await store.setKeyPaused(created.id, false);
  assert.equal(resumed.pausedAt, null);
  assert.equal(resumed.pausedMessage, 'Pago pendiente. Contacta con soporte.');
  assert.equal(store.findKeyByToken(created.token).name, 'Pruebas');
  await store.revokeKey(created.id);
  assert.equal(store.findKeyByToken(created.token), null);
  assert.equal(await store.setKeyPaused(created.id, false), null);
});

test('limita cada clave al proveedor local hasta habilitar expresamente los externos', async (t) => {
  const testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'benzIA-store-provider-access-'));
  const store = new SqliteStore(testDir, 30);
  t.after(async () => { store.close(); await fs.rm(testDir, { recursive: true, force: true }); });
  await store.init();
  const localOnly = await store.createKey('Solo local');
  const external = await store.createKey('Con externos', { allowExternalProviders: true });
  assert.equal(store.findKeyByToken(localOnly.token).allowExternalProviders, false);
  assert.equal(store.findKeyByToken(external.token).allowExternalProviders, true);
  assert.equal((await store.setKeyExternalAccess(localOnly.id, true)).allowExternalProviders, true);
});

test('conserva el filtro de proveedores externos por clave y lo limpia al deshabilitar', async (t) => {
  const testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'benzIA-store-provider-filter-'));
  const store = new SqliteStore(testDir, 30);
  t.after(async () => { store.close(); await fs.rm(testDir, { recursive: true, force: true }); });
  await store.init();
  const all = await store.createKey('Todos los externos');
  assert.equal(store.findKeyByToken(all.token).externalProviderIds, null);
  const filtered = await store.createKey('Filtrada', { allowExternalProviders: true, externalProviderIds: ['openai', 'groq'] });
  assert.deepEqual(store.findKeyByToken(filtered.token).externalProviderIds, ['openai', 'groq']);
  const narrowed = await store.setKeyExternalAccess(filtered.id, true, ['openai']);
  assert.deepEqual(narrowed.externalProviderIds, ['openai']);
  const kept = await store.setKeyExternalAccess(filtered.id, true);
  assert.deepEqual(kept.externalProviderIds, ['openai']);
  const disabled = await store.setKeyExternalAccess(filtered.id, false);
  assert.equal(disabled.allowExternalProviders, false);
  assert.equal(disabled.externalProviderIds, null);
});

test('añade el filtro de proveedores a una base SQLite existente sin perder claves', async (t) => {
  const testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'benzIA-store-provider-schema-'));
  const databasePath = path.join(testDir, 'gateway.sqlite');
  const legacyDb = new DatabaseSync(databasePath);
  legacyDb.exec(`
    CREATE TABLE access_keys (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      prefix TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      paused_at TEXT,
      paused_message TEXT,
      revoked_at TEXT,
      last_used_at TEXT,
      allow_external_providers INTEGER NOT NULL DEFAULT 0
    );
  `);
  legacyDb.prepare(`
    INSERT INTO access_keys (id, name, prefix, token_hash, created_at, revoked_at, last_used_at, allow_external_providers)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1)
  `).run('legacy-external', 'Clave con externos', 'lmg_legacy', hashToken('legacy-token'), new Date().toISOString(), null, null);
  legacyDb.close();

  const store = new SqliteStore(testDir, 30);
  t.after(async () => { store.close(); await fs.rm(testDir, { recursive: true, force: true }); });
  await store.init();
  const migrated = store.listKeys()[0];
  assert.equal(migrated.allowExternalProviders, true);
  assert.equal(migrated.externalProviderIds, null);
  const updated = await store.setKeyExternalAccess('legacy-external', true, ['openai']);
  assert.deepEqual(updated.externalProviderIds, ['openai']);
  assert.deepEqual(store.findKeyByToken('legacy-token').externalProviderIds, ['openai']);
});

test('añade el estado de pausa a una base SQLite existente sin perder claves', async (t) => {
  const testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'benzIA-store-schema-'));
  const databasePath = path.join(testDir, 'gateway.sqlite');
  const legacyDb = new DatabaseSync(databasePath);
  legacyDb.exec(`
    CREATE TABLE access_keys (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      prefix TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      revoked_at TEXT,
      last_used_at TEXT
    );
  `);
  legacyDb.prepare(`
    INSERT INTO access_keys (id, name, prefix, token_hash, created_at, revoked_at, last_used_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('legacy-key', 'Clave existente', 'lmg_legacy', hashToken('legacy-token'), new Date().toISOString(), null, null);
  legacyDb.close();

  const store = new SqliteStore(testDir, 30);
  t.after(async () => { store.close(); await fs.rm(testDir, { recursive: true, force: true }); });
  await store.init();
  assert.equal(store.listKeys()[0].pausedAt, null);
  assert.equal(store.listKeys()[0].pausedMessage, null);
  assert.ok((await store.setKeyPaused('legacy-key', true)).pausedAt);
  assert.equal(store.findKeyByToken('legacy-token'), null);
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
