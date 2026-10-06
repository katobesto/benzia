import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SqliteStore } from '../src/store.js';
import { summarizeMetrics } from '../src/metrics.js';

test('agregados SQL conservan totales, ponderación y filtros', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'benzia-summary-'));
  const store = new SqliteStore(dir);
  await store.init();
  t.after(async () => { store.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const key = await store.createKey('Equipo');
  const at = new Date().toISOString();
  const metrics = [
    { id:'a', at, keyId:key.id, status:200, inputTokens:100, outputTokens:40, latencyMs:100, lmCachedInputTokens:30, throughputSource:'upstream', tokensPerSecond:20, generationDurationMs:2000, model:'x' },
    { id:'b', at, keyId:key.id, status:500, inputTokens:50, outputTokens:20, latencyMs:200, throughputSource:'estimated', telemetryVersion:2, tokensPerSecond:10, model:'x' },
    { id:'c', at, keyId:key.id, status:200, inputTokens:10, outputTokens:0, latencyMs:300, model:'y' }
  ];
  for (const metric of metrics) await store.recordMetric(metric);
  const expected = summarizeMetrics(metrics, store.listKeys());
  const actual = store.getMetricsSummary({ from:at, to:at }, store.listKeys());
  assert.deepEqual(actual.totals, expected.totals);
  assert.deepEqual(actual.byKey, expected.byKey);
  assert.equal(actual.timeline[0].inputTokens, expected.timeline[0].inputTokens);
  assert.equal(store.getMetricsSummary({ from:at, to:at, model:'x' }, store.listKeys()).totals.requests, 2);
});
