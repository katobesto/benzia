import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { createAdminApp } from '../src/admin.js';
import { createGatewayApp } from '../src/proxy.js';
import { SqliteStore } from '../src/store.js';
import { LiveActivity } from '../src/live-activity.js';

async function listen(t, app) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  return server.address().port;
}

// --- Almacenamiento -------------------------------------------------------

test('el acceso local es por defecto verdadero y las claves antiguas no cambian', async (t) => {
  const testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'benzIA-local-access-store-'));
  const store = new SqliteStore(testDir, 30);
  await store.init();
  t.after(async () => { store.close(); await fs.rm(testDir, { recursive: true, force: true }); });

  const defecto = await store.createKey('Defecto');
  assert.equal(defecto.localModelAllowed, true);
  assert.equal(store.findKeyByToken(defecto.token).localModelAllowed, true);
  assert.equal(store.listKeys().find((key) => key.id === defecto.id).localModelAllowed, true);

  const soloExtranjeros = await store.createKey('Solo externos', { allowExternalProviders: true, localModelAllowed: false });
  assert.equal(soloExtranjeros.localModelAllowed, false);
  assert.equal(store.findKeyByToken(soloExtranjeros.token).localModelAllowed, false);

  // Pedir "sin local y sin externos" se rechaza en lugar de activar un origen.
  await assert.rejects(() => store.createKey('Sin origen', { localModelAllowed: false }), /al menos el proveedor local o los externos/);
  assert.equal(store.listKeys().some((key) => key.name === 'Sin origen'), false);
});

test('cambiar el nivel de acceso conserva el otro flag y rechaza quedarse sin origen', async (t) => {
  const testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'benzIA-local-access-set-'));
  const store = new SqliteStore(testDir, 30);
  await store.init();
  t.after(async () => { store.close(); await fs.rm(testDir, { recursive: true, force: true }); });

  const key = await store.createKey('Mixta', { allowExternalProviders: true });
  assert.equal(key.localModelAllowed, true);
  assert.equal(key.allowExternalProviders, true);

  const soloExtranjeros = await store.setKeyExternalAccess(key.id, undefined, undefined, false);
  assert.equal(soloExtranjeros.localModelAllowed, false);
  assert.equal(soloExtranjeros.allowExternalProviders, true, 'los externos no se tocan al quitar el local');

  const sinNada = await store.setKeyExternalAccess(key.id, false, undefined, false);
  assert.equal(sinNada, null, 'no se puede dejar la clave sin ningun origen');
  const intacta = store.listKeys().find((item) => item.id === key.id);
  assert.equal(intacta.localModelAllowed, false);
  assert.equal(intacta.allowExternalProviders, true);

  const vueltaLocal = await store.setKeyExternalAccess(key.id, false, undefined, true);
  assert.equal(vueltaLocal.localModelAllowed, true);
  assert.equal(vueltaLocal.allowExternalProviders, false);
});

// --- API administrativa ---------------------------------------------------

test('la API acepta y valida el nivel de acceso al proveedor local', async (t) => {
  const testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'benzIA-local-access-admin-'));
  const store = new SqliteStore(testDir, 30);
  await store.init();
  const created = await store.createKey('Equipo', { allowExternalProviders: true });
  const app = createAdminApp({
    config: { adminToken: 'admin-secret', upstreamBaseUrl: 'http://127.0.0.1:1234', upstreamApiKey: '', publicGatewayUrl: 'http://127.0.0.1:3401', gatewayPort: 3401, adminPort: 3400, metricsRetentionDays: 30 },
    store
  });
  const port = await listen(t, app);
  t.after(async () => { store.close(); await fs.rm(testDir, { recursive: true, force: true }); });

  const patch = (body) => fetch(`http://127.0.0.1:${port}/admin/api/keys/${created.id}/providers`, {
    method: 'PATCH', headers: { 'content-type': 'application/json', 'x-admin-token': 'admin-secret' }, body: JSON.stringify(body)
  });
  const post = (body) => fetch(`http://127.0.0.1:${port}/admin/api/keys`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-token': 'admin-secret' }, body: JSON.stringify(body)
  });

  const soloExtranjeros = await patch({ localModelAllowed: false, allowExternalProviders: true });
  assert.equal(soloExtranjeros.status, 200);
  const updated = (await soloExtranjeros.json()).key;
  assert.equal(updated.localModelAllowed, false);
  assert.equal(updated.allowExternalProviders, true);

  const sinOrigen = await patch({ localModelAllowed: false, allowExternalProviders: false });
  assert.equal(sinOrigen.status, 400);
  assert.match((await sinOrigen.json()).error, /al menos el proveedor local o los externos/);

  const tipoInvalido = await patch({ localModelAllowed: 'si' });
  assert.equal(tipoInvalido.status, 400);

  const nuevaSoloExtranjeros = await post({ name: 'Externa', localModelAllowed: false, allowExternalProviders: true });
  assert.equal(nuevaSoloExtranjeros.status, 201);
  assert.equal((await nuevaSoloExtranjeros.json()).key.localModelAllowed, false);

  const nuevaSinOrigen = await post({ name: 'Sin origen', localModelAllowed: false });
  assert.equal(nuevaSinOrigen.status, 400);
});

// --- Gateway: listado e inferencia ---------------------------------------

async function gatewayFixture(t, accessKeyExtras) {
  const local = express();
  local.use(express.json());
  local.get('/v1/models', (_req, res) => res.json({ object: 'list', data: [{ id: 'modelo-local', object: 'model' }] }));
  local.post('/v1/chat/completions', (req, res) => res.json({ id: 'local', object: 'chat.completion', model: req.body.model, choices: [{ index: 0, message: { role: 'assistant', content: 'respuesta local' }, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 3 } }));
  const localPort = await listen(t, local);

  const external = express();
  external.use(express.json());
  external.get('/v1/models', (_req, res) => res.json({ object: 'list', data: [{ id: 'modelo-nube', object: 'model' }] }));
  external.post('/v1/chat/completions', (req, res) => res.json({ id: 'cloud', object: 'chat.completion', model: req.body.model, choices: [{ index: 0, message: { role: 'assistant', content: 'respuesta nube' }, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 3 } }));
  const externalPort = await listen(t, external);

  const store = {
    getSettings: () => ({ externalProviders: [{ id: 'nube', name: 'Nube', baseUrl: `http://127.0.0.1:${externalPort}`, apiKey: '' }] }),
    findKeyByToken: () => ({ id: 'k-1', name: 'Prueba', allowExternalProviders: true, ...accessKeyExtras }),
    recordMetric: async () => {}
  };
  const gatewayPort = await listen(t, createGatewayApp({
    config: { upstreamBaseUrl: `http://127.0.0.1:${localPort}`, upstreamApiKey: '', requestTimeoutMs: 2000 },
    store, liveActivity: new LiveActivity()
  }));
  const base = `http://127.0.0.1:${gatewayPort}`;
  const headers = { authorization: 'Bearer test-token', 'content-type': 'application/json' };
  return {
    models: async () => {
      const res = await fetch(`${base}/v1/models`, { headers });
      return { status: res.status, ids: (await res.json()).data.map((model) => model.id) };
    },
    infer: async (model) => {
      const res = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hola' }] }) });
      return { status: res.status, body: await res.json() };
    }
  };
}

test('con acceso local permitido se listan y usan local y externos', async (t) => {
  const f = await gatewayFixture(t, { localModelAllowed: true });
  const listed = await f.models();
  assert.deepEqual(listed.ids, ['modelo-local', 'nube/modelo-nube']);
  assert.equal((await f.infer('modelo-local')).status, 200);
  assert.equal((await f.infer('nube/modelo-nube')).status, 200);
});

test('"Solo externos" oculta el modelo local y bloquea invocarlo a mano', async (t) => {
  const f = await gatewayFixture(t, { localModelAllowed: false });
  const listed = await f.models();
  assert.deepEqual(listed.ids, ['nube/modelo-nube'], 'el modelo local no debe aparecer en el listado');

  const blocked = await f.infer('modelo-local');
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.error.code, 'local_provider_forbidden');

  assert.equal((await f.infer('nube/modelo-nube')).status, 200);
});

test('las claves sin la columna nueva siguen accediendo al modelo local', async (t) => {
  const f = await gatewayFixture(t, {});
  assert.deepEqual((await f.models()).ids, ['modelo-local', 'nube/modelo-nube']);
  assert.equal((await f.infer('modelo-local')).status, 200);
});

// --- Panel ---------------------------------------------------------------

test('el planificador de busqueda tampoco usa el local si el token no puede', async () => {
  const { canPlanWithExternalProvider, canPlanWithLocalProvider } = await import('../src/research.js');
  assert.equal(canPlanWithLocalProvider({ localModelAllowed: true }), true);
  assert.equal(canPlanWithLocalProvider({}), true, 'sin la propiedad se mantiene el comportamiento anterior');
  assert.equal(canPlanWithLocalProvider({ localModelAllowed: false }), false);
  // Ruta local (sin proveedor externo) delega en la comprobacion de acceso local.
  assert.equal(canPlanWithExternalProvider(null, { localModelAllowed: false }), false);
  assert.equal(canPlanWithExternalProvider(null, { localModelAllowed: true }), true);
  // Las rutas externas siguen gobernadas por su propio filtro.
  assert.equal(canPlanWithExternalProvider({ provider: { id: 'nube' }, upstreamModel: 'm' }, { localModelAllowed: false, allowExternalProviders: true }), true);
});

test('el panel muestra el combo de tres niveles y envia los dos flags', async () => {
  const [html, app, client] = await Promise.all([
    fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../public/api-client.js', import.meta.url), 'utf8')
  ]);
  assert.match(html, /<option value="local-only">Solo proveedor local<\/option>/);
  assert.match(html, /<option value="both">Permitir proveedores externos<\/option>/);
  assert.match(html, /<option value="external-only">Solo externos<\/option>/);
  assert.match(app, /keyProviderAccessPayload\(/);
  assert.match(client, /export function keyProviderAccessLevel/);
  assert.match(client, /export function keyProviderAccessPayload/);
});

test('el combo traduce cada nivel a los flags correctos', async () => {
  const { keyProviderAccessLevel, keyProviderAccessPayload, keyProviderAccessMarkup } = await import('../public/api-client.js');
  assert.equal(keyProviderAccessLevel({ localModelAllowed: true, allowExternalProviders: false }), 'local-only');
  assert.equal(keyProviderAccessLevel({ localModelAllowed: true, allowExternalProviders: true }), 'both');
  assert.equal(keyProviderAccessLevel({ localModelAllowed: false, allowExternalProviders: true }), 'external-only');
  // Claves anteriores sin la propiedad: comportamiento historico (local).
  assert.equal(keyProviderAccessLevel({ allowExternalProviders: false }), 'local-only');
  assert.equal(keyProviderAccessLevel({ allowExternalProviders: true }), 'both');

  assert.deepEqual(keyProviderAccessPayload('local-only'), { localModelAllowed: true, allowExternalProviders: false });
  assert.deepEqual(keyProviderAccessPayload('both'), { localModelAllowed: true, allowExternalProviders: true });
  assert.deepEqual(keyProviderAccessPayload('external-only'), { localModelAllowed: false, allowExternalProviders: true });

  assert.match(keyProviderAccessMarkup({ localModelAllowed: false, allowExternalProviders: true }), /value="external-only" selected/);
});
