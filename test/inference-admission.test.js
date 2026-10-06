import test from 'node:test';
import assert from 'node:assert/strict';
import { InferenceAdmission } from '../src/inference-admission.js';

test('cola acotada, proveedores independientes y liberación idempotente', async () => {
  const admission = new InferenceAdmission({ limit: 1, maxQueue: 1, waitMs: 1000 });
  const first = await admission.acquire('local');
  const queued = admission.acquire('local');
  await assert.rejects(admission.acquire('local'), { status: 429 });
  const external = await admission.acquire('external');
  first(); first();
  const second = await queued;
  assert.equal(admission.providers.get('local').active, 1);
  second(); external();
  assert.equal(admission.providers.size, 0);
});
test('cancelar una petición en cola no pierde slots', async () => {
  const admission = new InferenceAdmission({ limit: 1 });
  const release = await admission.acquire('local');
  const controller = new AbortController();
  const queued = admission.acquire('local', controller.signal);
  controller.abort();
  await assert.rejects(queued);
  release();
  assert.equal(admission.providers.size, 0);
});
