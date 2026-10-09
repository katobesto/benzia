import test from 'node:test';
import assert from 'node:assert/strict';
import { parseApiResponse, providerFilterOptions } from '../public/api-client.js';

test('provider filter includes published Codex and retains the openai grant', () => {
  const settings = { externalProviders: [{ id: 'cloud', name: 'Cloud IA', baseUrl: 'https://example.com' }], codexOpenAI: { connected: true, selectedModel: 'codex-model' } };
  assert.deepEqual(providerFilterOptions(settings).map(({ id }) => id), ['cloud', 'openai']);
  assert.deepEqual(providerFilterOptions({ ...settings, codexOpenAI: { connected: false, selectedModel: '' } }).map(({ id }) => id), ['cloud']);
  assert.deepEqual(providerFilterOptions({ ...settings, externalProviders: [{ id: 'openai', name: 'OpenAI API' }] }).map(({ id }) => id), ['openai']);
});


test('non-JSON API responses report status and content type rather than a parser exception', async () => {
  const response = new Response('<!DOCTYPE html><html></html>', {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' }
  });
  await assert.rejects(parseApiResponse(response), /no es JSON válido.*HTTP 200.*text\/html/i);
});

test('non-JSON gateway failures identify the edge request without exposing the response body', async () => {
  const response = new Response('<html>secret</html>', { status: 502, headers: { 'content-type': 'text/html', 'cf-ray': 'ray-123' } });
  await assert.rejects(parseApiResponse(response), (error) => error.message.includes('ray-123') && !error.message.includes('secret'));
});


test('API parser preserves JSON error messages and accepts pending responses', async () => {
  const failed = new Response(JSON.stringify({ error: 'Codex no disponible' }), {
    status: 502,
    headers: { 'content-type': 'application/json', 'x-request-id': 'req-456' }
  });
  await assert.rejects(parseApiResponse(failed), /Codex no disponible.*req-456/);
  const pending = new Response(JSON.stringify({ pending: true }), {
    status: 202,
    headers: { 'content-type': 'application/json' }
  });
  assert.deepEqual(await parseApiResponse(pending), { pending: true });
});
