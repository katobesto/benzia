import test from 'node:test';
import assert from 'node:assert/strict';
import { parseApiResponse } from '../public/api-client.js';

test('non-JSON API responses report status and content type rather than a parser exception', async () => {
  const response = new Response('<!DOCTYPE html><html></html>', {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' }
  });
  await assert.rejects(parseApiResponse(response), /no es JSON válido.*HTTP 200.*text\/html/i);
});

test('API parser preserves JSON error messages and accepts pending responses', async () => {
  const failed = new Response(JSON.stringify({ error: 'Codex no disponible' }), {
    status: 502,
    headers: { 'content-type': 'application/json' }
  });
  await assert.rejects(parseApiResponse(failed), /Codex no disponible/);
  const pending = new Response(JSON.stringify({ pending: true }), {
    status: 202,
    headers: { 'content-type': 'application/json' }
  });
  assert.deepEqual(await parseApiResponse(pending), { pending: true });
});
