import assert from 'node:assert/strict';
import test from 'node:test';

import { estimateInputTokens, extractOutputText, extractUpstreamTelemetry, extractUsage } from '../src/usage.js';

test('prioriza los contadores exactos del upstream', () => {
  assert.deepEqual(extractUsage({ usage: { prompt_tokens: 12, completion_tokens: 7 } }, {}), {
    inputTokens: 12, outputTokens: 7, usageSource: 'upstream'
  });
});

test('estima tokens cuando Proveedor IA Local no devuelve usage', () => {
  const body = { messages: [{ role: 'user', content: 'Escribe una frase corta' }] };
  const usage = extractUsage({ choices: [{ message: { content: 'Esta es la respuesta.' } }] }, body);
  assert.equal(usage.usageSource, 'estimated');
  assert.ok(usage.inputTokens >= estimateInputTokens(body));
  assert.ok(usage.outputTokens > 0);
});

test('incluye texto e imágenes multimodales en la estimación de entrada', () => {
  const textOnly = estimateInputTokens({ messages: [{ role: 'user', content: 'Describe esto' }] });
  const multimodal = estimateInputTokens({
    messages: [{ role: 'user', content: [
      { type: 'text', text: 'Describe esto' },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,abc' } }
    ] }]
  });
  assert.ok(multimodal > textOnly);
});

test('cuenta el razonamiento emitido antes de la respuesta visible', () => {
  assert.equal(extractOutputText({ choices: [{ delta: { reasoning: 'Analizando tokens' } }] }), 'Analizando tokens');
  assert.equal(extractOutputText({ choices: [{ delta: { reasoning_content: 'Pensando' } }] }), 'Pensando');
  assert.equal(extractOutputText({ type: 'reasoning.delta', content: 'Evaluando' }), 'Evaluando');
});

test('extrae cached_tokens y rendimiento reportados por Proveedor IA Local', () => {
  const telemetry = extractUpstreamTelemetry({
    usage: { prompt_tokens_details: { cached_tokens: 80 } },
    stats: { tokens_per_second: 41.25 }
  }, { outputTokens: 10, startedAt: 1000, completedAt: 2000 });
  assert.deepEqual(telemetry, {
    telemetryVersion: 2,
    lmCachedInputTokens: 80,
    lmCacheSource: 'upstream',
    tokensPerSecond: 41.3,
    throughputSource: 'upstream',
    generationDurationMs: 1000,
    timeToFirstTokenMs: null
  });
});

test('estima tokens por segundo sin inventar datos de caché de Proveedor IA Local', () => {
  const telemetry = extractUpstreamTelemetry({}, {
    outputTokens: 20,
    firstTokenAt: 1000,
    completedAt: 3000
  });
  assert.equal(telemetry.lmCachedInputTokens, null);
  assert.equal(telemetry.lmCacheSource, 'unavailable');
  assert.equal(telemetry.tokensPerSecond, 10);
  assert.equal(telemetry.throughputSource, 'estimated');
  assert.equal(telemetry.generationDurationMs, 2000);
});
