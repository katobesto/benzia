import assert from 'node:assert/strict';
import test from 'node:test';

import { summarizeMetrics } from '../src/metrics.js';

test('agrega tokens, caché y actividad por clave', () => {
  const metrics = [
    { at: '2026-09-02T10:10:00Z', keyId: 'a', inputTokens: 10, outputTokens: 5, cacheStatus: 'miss', status: 200, latencyMs: 100, lmCachedInputTokens: 8, tokensPerSecond: 20, throughputSource: 'upstream' },
    { at: '2026-09-02T10:20:00Z', keyId: 'a', inputTokens: 10, outputTokens: 5, cacheStatus: 'hit', status: 200, latencyMs: 10 },
    { at: '2026-09-02T11:00:00Z', keyId: 'b', inputTokens: 2, outputTokens: 1, cacheStatus: 'bypass', status: 500, latencyMs: 40 }
  ];
  const result = summarizeMetrics(metrics, [{ id: 'a', name: 'Equipo A' }, { id: 'b', name: 'Equipo B' }]);
  assert.equal(result.totals.inputTokens, 22);
  assert.equal(result.totals.outputTokens, 11);
  assert.equal(result.totals.cacheHitRate, 1 / 2);
  assert.equal(result.totals.cacheBypasses, 1);
  assert.equal(result.totals.lmCacheHitRate, 0.8);
  assert.equal(result.totals.averageTokensPerSecond, 20);
  assert.equal(result.totals.errors, 1);
  assert.equal(result.timeline.length, 2);
  assert.equal(result.byKey[0].name, 'Equipo A');
});

test('no muestra una tasa de hit inventada cuando todo el tráfico es bypass', () => {
  const result = summarizeMetrics([
    { at: '2026-09-02T10:10:00Z', keyId: 'a', inputTokens: 10, outputTokens: 5, cacheStatus: 'bypass', status: 200, latencyMs: 100 }
  ], [{ id: 'a', name: 'Equipo A' }]);
  assert.equal(result.totals.cacheHitRate, null);
});
