import assert from 'node:assert/strict';
import test from 'node:test';

import { summarizeMetrics } from '../src/metrics.js';

test('agrega tokens y caché del proveedor por clave', () => {
  const metrics = [
    { at: '2026-09-02T10:10:00Z', keyId: 'a', inputTokens: 10, outputTokens: 5, status: 200, latencyMs: 100, lmCachedInputTokens: 8, tokensPerSecond: 20, throughputSource: 'upstream' },
    { at: '2026-09-02T10:20:00Z', keyId: 'a', inputTokens: 10, outputTokens: 5, status: 200, latencyMs: 10, lmCachedInputTokens: 0 },
    { at: '2026-09-02T11:00:00Z', keyId: 'b', inputTokens: 2, outputTokens: 1, status: 500, latencyMs: 40 }
  ];
  const result = summarizeMetrics(metrics, [{ id: 'a', name: 'Equipo A' }, { id: 'b', name: 'Equipo B' }]);
  assert.equal(result.totals.inputTokens, 22);
  assert.equal(result.totals.outputTokens, 11);
  assert.equal(result.totals.lmCachedInputTokens, 8);
  assert.equal(result.totals.lmUncachedInputTokens, 12);
  assert.equal(result.totals.lmCacheHitRate, 0.4);
  assert.equal(result.totals.lmCacheReportedRequests, 2);
  assert.equal(result.totals.averageTokensPerSecond, 20);
  assert.equal(result.totals.errors, 1);
  assert.equal(result.timeline.length, 2);
  assert.equal(result.byKey[0].name, 'Equipo A');
});

test('no muestra una tasa de reutilización cuando el proveedor no la reporta', () => {
  const result = summarizeMetrics([
    { at: '2026-09-02T10:10:00Z', keyId: 'a', inputTokens: 10, outputTokens: 5, status: 200, latencyMs: 100 }
  ], [{ id: 'a', name: 'Equipo A' }]);
  assert.equal(result.totals.lmCacheHitRate, null);
  assert.equal(result.totals.lmCacheReportedRequests, 0);
});
