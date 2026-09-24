import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { createAdminApp } from '../src/admin.js';
import { CAPABILITIES_FILENAME, annotateModel, annotateModels, loadModelCapabilities, sanitizeModelCapabilities } from '../src/model-capabilities.js';
import { createGatewayApp } from '../src/proxy.js';
import { SqliteStore } from '../src/store.js';

test('sanitiza el mapa de capacidades y aplica los defectos', () => {
  const result = sanitizeModelCapabilities({
    'modelo-local': { input: ['text'] },
    'vision-local': { input: ['image', 'text', 'text'], output: ['text'] },
    'modelo-sin-output': {}
  });
  assert.deepEqual(result, {
    'modelo-local': { input: ['text'], output: ['text'] },
    'vision-local': { input: ['image', 'text'], output: ['text'] },
    'modelo-sin-output': { input: ['text'], output: ['text'] }
  });
  assert.deepEqual(sanitizeModelCapabilities(undefined), {});
  assert.deepEqual(sanitizeModelCapabilities(null), {});
  assert.deepEqual(sanitizeModelCapabilities({}), {});
});

test('rechaza mapas de capacidades no válidos', () => {
  assert.throws(() => sanitizeModelCapabilities(['a']), /objeto JSON/);
  assert.throws(() => sanitizeModelCapabilities({ ' ' : { input: ['text'] } }), /ID de modelo/);
  assert.throws(() => sanitizeModelCapabilities({ 'a': { input: ['texto'] } }), /modalidad no válida/);
  assert.throws(() => sanitizeModelCapabilities({ 'a': { input: [] } }), /no pueden estar vacías/);
  assert.throws(() => sanitizeModelCapabilities({ 'a': { input: ['image'] } }), /incluir "text"/);
  assert.throws(() => sanitizeModelCapabilities({ 'a': 'texto' }), /deben ser un objeto/);
  const many = Object.fromEntries(Array.from({ length: 201 }, (_, index) => [`m${index}`, { input: ['text'] }]));
  assert.throws(() => sanitizeModelCapabilities(many), /hasta 200/);
});

test('lee el archivo de capacidades del directorio de datos', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'benzia-capabilities-'));
  t.after(async () => fs.rm(dir, { recursive: true, force: true }));

  assert.deepEqual(await loadModelCapabilities(undefined), {});
  assert.deepEqual(await loadModelCapabilities(dir), {}, 'un directorio sin archivo no declara capacidades');

  await fs.writeFile(path.join(dir, CAPABILITIES_FILENAME), JSON.stringify({ 'v': { input: ['text', 'image'] } }));
  assert.deepEqual(await loadModelCapabilities(dir), { v: { input: ['text', 'image'], output: ['text'] } });

  await fs.writeFile(path.join(dir, CAPABILITIES_FILENAME), '{ no es json');
  assert.deepEqual(await loadModelCapabilities(dir), {}, 'un archivo corrupto degrada en lugar de romper /v1/models');
});

test('anota modelos locales y externos por su ID público o original', () => {
  const capabilities = {
    'modelo-local': { input: ['text'], output: ['text'] },
    'org/modelo-externo': { input: ['text', 'image'], output: ['text'] },
    'otro-externo': { input: ['text', 'image'], output: ['text'] }
  };
  const local = { id: 'modelo-local', object: 'model' };
  const annotatedLocal = annotateModel(local, capabilities);
  assert.deepEqual(annotatedLocal, { id: 'modelo-local', object: 'model', input_modalities: ['text'], output_modalities: ['text'] });
  assert.notEqual(annotatedLocal, local);
  assert.equal(local.input_modalities, undefined, 'el modelo original no se muta');

  const externalFull = { id: 'cloud/org/modelo-externo', object: 'model', benzIA_provider: { id: 'cloud', external: true } };
  assert.deepEqual(annotateModel(externalFull, capabilities).input_modalities, ['text', 'image']);

  const externalRaw = { id: 'cloud/otro-externo', object: 'model', benzIA_provider: { id: 'cloud', external: true } };
  assert.deepEqual(annotateModel(externalRaw, capabilities).input_modalities, ['text', 'image'], 'una clave sin prefijo cubre al modelo externo');

  const untouched = { id: 'sin-declarar', object: 'model' };
  assert.equal(annotateModel(untouched, capabilities), untouched);
  assert.deepEqual(annotateModels([local, untouched], capabilities).map((model) => model.id), ['modelo-local', 'sin-declarar']);
});

test('el gateway publica las modalidades declaradas en /v1/models', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'benzia-gateway-caps-'));
  t.after(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  await fs.writeFile(path.join(dataDir, CAPABILITIES_FILENAME), JSON.stringify({
    'modelo-local': { input: ['text'], output: ['text'] },
    'org/modelo-cloud': { input: ['text', 'image'], output: ['text'] }
  }));

  const local = express();
  local.get('/v1/models', (_req, res) => res.json({ object: 'list', data: [{ id: 'modelo-local', object: 'model' }, { id: 'otro-local', object: 'model' }] }));
  const localServer = local.listen(0, '127.0.0.1');
  await new Promise((resolve) => localServer.once('listening', resolve));
  t.after(() => new Promise((resolve) => localServer.close(resolve)));

  const external = express();
  external.get('/v1/models', (_req, res) => res.json({ object: 'list', data: [{ id: 'org/modelo-cloud', object: 'model' }] }));
  const externalServer = external.listen(0, '127.0.0.1');
  await new Promise((resolve) => externalServer.once('listening', resolve));
  t.after(() => new Promise((resolve) => externalServer.close(resolve)));

  const store = {
    getSettings: () => ({ externalProviders: [{ id: 'cloud', name: 'Cloud IA', baseUrl: `http://127.0.0.1:${externalServer.address().port}`, apiKey: '' }] }),
    findKeyByToken: () => ({ id: 'external', name: 'Externo', allowExternalProviders: true })
  };
  const gateway = createGatewayApp({
    config: { dataDir, upstreamBaseUrl: `http://127.0.0.1:${localServer.address().port}`, upstreamApiKey: '', requestTimeoutMs: 5000 },
    store
  });
  const gatewayServer = gateway.listen(0, '127.0.0.1');
  await new Promise((resolve) => gatewayServer.once('listening', resolve));
  t.after(() => new Promise((resolve) => gatewayServer.close(resolve)));

  const models = (await (await fetch(`http://127.0.0.1:${gatewayServer.address().port}/v1/models`, { headers: { authorization: 'Bearer external-key' } })).json()).data;
  const byId = new Map(models.map((model) => [model.id, model]));

  assert.deepEqual(byId.get('modelo-local').input_modalities, ['text']);
  assert.deepEqual(byId.get('modelo-local').output_modalities, ['text']);
  assert.equal(byId.get('otro-local').input_modalities, undefined, 'un modelo sin declaración no recibe campos');
  assert.deepEqual(byId.get('cloud/org/modelo-cloud').input_modalities, ['text', 'image']);
});

test('el panel lee y escribe el mapa de capacidades por API', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'benzia-admin-caps-'));
  const store = new SqliteStore(dataDir);
  await store.init();
  t.after(async () => {
    store.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  const app = createAdminApp({
    config: { adminToken: 'admin-secret', dataDir, upstreamBaseUrl: 'http://127.0.0.1:1234' },
    store
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}/admin/api/model-capabilities`;
  const adminHeaders = { 'x-admin-token': 'admin-secret', 'content-type': 'application/json' };

  const unauthorized = await fetch(baseUrl);
  assert.equal(unauthorized.status, 401);

  const empty = await fetch(baseUrl, { headers: adminHeaders });
  assert.equal(empty.status, 200);
  const emptyBody = await empty.json();
  assert.equal(emptyBody.count, 0);
  assert.equal(emptyBody.file, CAPABILITIES_FILENAME);

  const invalid = await fetch(baseUrl, {
    method: 'PUT',
    headers: adminHeaders,
    body: JSON.stringify({ capabilities: { 'a': { input: ['texto'] } } })
  });
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error, /modalidad no válida/);
  assert.equal(await fs.stat(path.join(dataDir, CAPABILITIES_FILENAME)).then(() => true, () => false), false, 'un mapa inválido no toca el archivo');

  const valid = await fetch(baseUrl, {
    method: 'PUT',
    headers: adminHeaders,
    body: JSON.stringify({ capabilities: { 'modelo-vision': { input: ['text', 'image'] } } })
  });
  assert.equal(valid.status, 200);
  assert.deepEqual(await valid.json(), { updated: true, count: 1 });

  const persisted = JSON.parse(await fs.readFile(path.join(dataDir, CAPABILITIES_FILENAME), 'utf8'));
  assert.deepEqual(persisted, { 'modelo-vision': { input: ['text', 'image'], output: ['text'] } });

  const roundTrip = await fetch(baseUrl, { headers: adminHeaders });
  assert.equal((await roundTrip.json()).count, 1);
});

test('el mapa de capacidades aplica sin reiniciar al reescribirse', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'benzia-hot-caps-'));
  t.after(async () => fs.rm(dataDir, { recursive: true, force: true }));

  const upstream = express();
  upstream.get('/v1/models', (_req, res) => res.json({ object: 'list', data: [{ id: 'modelo-local' }] }));
  const upstreamServer = upstream.listen(0, '127.0.0.1');
  await new Promise((resolve) => upstreamServer.once('listening', resolve));
  t.after(() => new Promise((resolve) => upstreamServer.close(resolve)));

  const store = {
    getSettings: () => ({}),
    findKeyByToken: () => ({ id: 'key-1', name: 'Pruebas' })
  };
  const gateway = createGatewayApp({
    config: { dataDir, upstreamBaseUrl: `http://127.0.0.1:${upstreamServer.address().port}`, upstreamApiKey: '', requestTimeoutMs: 5000 },
    store
  });
  const gatewayServer = gateway.listen(0, '127.0.0.1');
  await new Promise((resolve) => gatewayServer.once('listening', resolve));
  t.after(() => new Promise((resolve) => gatewayServer.close(resolve)));
  const url = `http://127.0.0.1:${gatewayServer.address().port}/v1/models`;
  const headers = { authorization: 'Bearer valid-key' };

  let models = (await (await fetch(url, { headers })).json()).data;
  assert.equal(models[0].input_modalities, undefined, 'sin archivo no hay capacidades');

  await fs.writeFile(path.join(dataDir, CAPABILITIES_FILENAME), JSON.stringify({ 'modelo-local': { input: ['text', 'image'] } }));
  models = (await (await fetch(url, { headers })).json()).data;
  assert.deepEqual(models[0].input_modalities, ['text', 'image'], 'el gateway lee el archivo en cada consulta');
});