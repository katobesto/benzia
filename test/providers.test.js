import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeProviderBaseUrl, routeForModel, sanitizeExternalProviders } from '../src/providers.js';

test('normaliza proveedores externos y conserva un secreto al renombrar su ID', () => {
  const previous = [{ id: 'anterior', name: 'Anterior', baseUrl: 'https://example.com', apiKey: 'secreto' }];
  const [provider] = sanitizeExternalProviders([{
    id: 'nuevo', originalId: 'anterior', name: 'Proveedor nuevo', baseUrl: 'https://api.example.com/v1/', keepApiKey: true
  }], previous);
  assert.deepEqual(provider, { id: 'nuevo', name: 'Proveedor nuevo', baseUrl: 'https://api.example.com', apiKey: 'secreto' });
  assert.equal(normalizeProviderBaseUrl('https://example.com/compatible/v1'), 'https://example.com/compatible');
});

test('resuelve el prefijo externo y conserva barras dentro del ID real del modelo', () => {
  const provider = { id: 'cloud', name: 'Cloud' };
  assert.deepEqual(routeForModel('cloud/organization/model', [provider]), { provider, upstreamModel: 'organization/model' });
  assert.equal(routeForModel('modelo-local', [provider]), null);
});
