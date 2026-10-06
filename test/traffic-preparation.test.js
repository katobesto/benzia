import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createChatApp } from '../src/chat.js';
import { fetchProviderModels, clearProviderModelsCache } from '../src/providers.js';

async function serve(t, app) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('accesos válidos no agotan cuota IP y claves revocadas son rechazadas', async t => {
  const store = { getSettings: () => ({}), findKeyByToken: token => token === 'valid' ? { id:'a', name:'Equipo' } : token === 'revoked' ? { id:'b', revokedAt:'now' } : null };
  const app = createChatApp({ config:{ rateLimitAuthPerMinute:1, publicGatewayUrl:'http://localhost' }, store });
  const base = await serve(t, app);
  for (let index=0; index<3; index++) assert.equal((await fetch(base+'/api/config', { headers:{ authorization:'Bearer valid' } })).status,200);
  assert.equal((await fetch(base+'/api/config', { headers:{ authorization:'Bearer revoked' } })).status,401);
  assert.equal((await fetch(base+'/api/config', { headers:{ authorization:'Bearer wrong' } })).status,429);
});

test('catálogo comparte solicitudes en curso y vuelve a consultar al invalidarlo', async t => {
  clearProviderModelsCache();
  let requests=0;
  const upstream=express();
  upstream.get('/v1/models', async (_req,res) => { requests++; await new Promise(resolve=>setTimeout(resolve,10)); res.json({data:[{id:'model'}]}); });
  const baseUrl=await serve(t,upstream);
  const provider={baseUrl};
  await Promise.all([fetchProviderModels(provider),fetchProviderModels(provider)]);
  assert.equal(requests,1);
  const models=await fetchProviderModels(provider); models[0].id='changed';
  assert.equal((await fetchProviderModels(provider))[0].id,'model');
  clearProviderModelsCache();
  await fetchProviderModels(provider);
  assert.equal(requests,2);
});
