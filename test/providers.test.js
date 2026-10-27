import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeProviderBaseUrl, normalizeVisibleModels, publicExternalProviders, routeForModel, sanitizeExternalProviders } from '../src/providers.js';

test('normaliza proveedores externos y conserva un secreto al renombrar su ID', () => {
  const previous = [{ id: 'anterior', name: 'Anterior', baseUrl: 'https://example.com', apiKey: 'secreto' }];
  const [provider] = sanitizeExternalProviders([{
    id: 'nuevo', originalId: 'anterior', name: 'Proveedor nuevo', baseUrl: 'https://api.example.com/v1/', keepApiKey: true
  }], previous);
  assert.deepEqual(provider, { id: 'nuevo', name: 'Proveedor nuevo', baseUrl: 'https://api.example.com', apiKey: 'secreto', visibleModels: null });
  assert.equal(normalizeProviderBaseUrl('https://example.com/compatible/v1'), 'https://example.com/compatible');
});

test('valida y conserva la lista de modelos visibles de un proveedor externo', () => {
  const previous = [{ id: 'cloud', name: 'Cloud', baseUrl: 'https://api.example.com', apiKey: '', visibleModels: ['a', 'b'] }];
  const [kept] = sanitizeExternalProviders([{ id: 'cloud', name: 'Cloud', baseUrl: 'https://api.example.com' }], previous);
  assert.deepEqual(kept.visibleModels, ['a', 'b']);
  const [updated] = sanitizeExternalProviders([{ id: 'cloud', name: 'Cloud', baseUrl: 'https://api.example.com', visibleModels: [' b ', 'a', 'a'] }], previous);
  assert.deepEqual(updated.visibleModels, ['b', 'a']);
  const [all] = sanitizeExternalProviders([{ id: 'cloud', name: 'Cloud', baseUrl: 'https://api.example.com', visibleModels: null }], previous);
  assert.equal(all.visibleModels, null);
  const [hidden] = sanitizeExternalProviders([{ id: 'cloud', name: 'Cloud', baseUrl: 'https://api.example.com', visibleModels: [] }], previous);
  assert.deepEqual(hidden.visibleModels, []);
  assert.throws(() => sanitizeExternalProviders([{ id: 'cloud', name: 'Cloud', baseUrl: 'https://api.example.com', visibleModels: 'a' }], previous), /no es válida/);
  assert.throws(() => sanitizeExternalProviders([{ id: 'cloud', name: 'Cloud', baseUrl: 'https://api.example.com', visibleModels: [''] }], previous), /ID de 1 a 200/);
  assert.throws(() => normalizeVisibleModels(Array(501).fill('m')), /hasta 500/);
  assert.deepEqual(publicExternalProviders([{ id: 'cloud', name: 'Cloud', baseUrl: 'https://api.example.com', apiKey: 'x', visibleModels: ['a'] }]),
    [{ id: 'cloud', name: 'Cloud', baseUrl: 'https://api.example.com', hasApiKey: true, visibleModels: ['a'] }]);
  assert.deepEqual(publicExternalProviders([{ id: 'cloud', name: 'Cloud', baseUrl: 'https://api.example.com', apiKey: '' }]),
    [{ id: 'cloud', name: 'Cloud', baseUrl: 'https://api.example.com', hasApiKey: false, visibleModels: null }]);
});

test('resuelve el prefijo externo y conserva barras dentro del ID real del modelo', () => {
  const provider = { id: 'cloud', name: 'Cloud' };
  assert.deepEqual(routeForModel('cloud/organization/model', [provider]), { provider, upstreamModel: 'organization/model' });
  assert.equal(routeForModel('modelo-local', [provider]), null);
});
