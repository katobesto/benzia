const BUCKETS = new Set(['hour', 'day']);

export function summarizeMetrics(metrics, keys, bucket = 'hour') {
  const safeBucket = BUCKETS.has(bucket) ? bucket : 'hour';
  const keyMap = new Map(keys.map((key) => [key.id, key]));
  const totals = {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheHits: 0,
    cacheMisses: 0,
    cacheBypasses: 0,
    lmCachedInputTokens: 0,
    lmReportedInputTokens: 0,
    lmCacheReportedRequests: 0,
    throughputSamples: 0,
    throughputReportedRequests: 0,
    throughputEstimatedRequests: 0,
    errors: 0,
    averageLatencyMs: 0,
    averageTokensPerSecond: 0
  };
  const latencyValues = [];
  let throughputOutputTokens = 0;
  let throughputSeconds = 0;
  const byKey = new Map();
  const timeline = new Map();

  for (const metric of metrics) {
    totals.requests += 1;
    totals.inputTokens += metric.inputTokens || 0;
    totals.outputTokens += metric.outputTokens || 0;
    totals.cacheHits += metric.cacheStatus === 'hit' ? 1 : 0;
    totals.cacheMisses += metric.cacheStatus === 'miss' ? 1 : 0;
    totals.cacheBypasses += metric.cacheStatus === 'bypass' ? 1 : 0;
    if (Number.isFinite(metric.lmCachedInputTokens)) {
      totals.lmCachedInputTokens += metric.lmCachedInputTokens;
      totals.lmReportedInputTokens += metric.inputTokens || 0;
      totals.lmCacheReportedRequests += 1;
    }
    totals.errors += metric.status >= 400 ? 1 : 0;
    latencyValues.push(metric.latencyMs || 0);
    const trustworthyThroughput = metric.throughputSource === 'upstream' || metric.telemetryVersion >= 2;
    if (trustworthyThroughput && Number.isFinite(metric.tokensPerSecond) && metric.tokensPerSecond > 0 && metric.outputTokens > 0) {
      totals.throughputSamples += 1;
      totals.throughputReportedRequests += metric.throughputSource === 'upstream' ? 1 : 0;
      totals.throughputEstimatedRequests += metric.throughputSource === 'upstream' ? 0 : 1;
      throughputOutputTokens += metric.outputTokens;
      throughputSeconds += Number.isFinite(metric.generationDurationMs) && metric.generationDurationMs > 0
        ? metric.generationDurationMs / 1000
        : metric.outputTokens / metric.tokensPerSecond;
    }

    const key = keyMap.get(metric.keyId);
    const currentKey = byKey.get(metric.keyId) || {
      keyId: metric.keyId,
      name: key?.name || 'Clave eliminada',
      prefix: key?.prefix || '—',
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheHits: 0,
      cacheMisses: 0,
      cacheBypasses: 0,
      lmCachedInputTokens: 0,
      lmReportedInputTokens: 0,
      errors: 0,
      lastActivity: null
    };
    currentKey.requests += 1;
    currentKey.inputTokens += metric.inputTokens || 0;
    currentKey.outputTokens += metric.outputTokens || 0;
    currentKey.cacheHits += metric.cacheStatus === 'hit' ? 1 : 0;
    currentKey.cacheMisses += metric.cacheStatus === 'miss' ? 1 : 0;
    currentKey.cacheBypasses += metric.cacheStatus === 'bypass' ? 1 : 0;
    if (Number.isFinite(metric.lmCachedInputTokens)) {
      currentKey.lmCachedInputTokens += metric.lmCachedInputTokens;
      currentKey.lmReportedInputTokens += metric.inputTokens || 0;
    }
    currentKey.errors += metric.status >= 400 ? 1 : 0;
    currentKey.lastActivity = metric.at;
    byKey.set(metric.keyId, currentKey);

    const date = new Date(metric.at);
    if (safeBucket === 'hour') date.setUTCMinutes(0, 0, 0);
    else date.setUTCHours(0, 0, 0, 0);
    const bucketKey = date.toISOString();
    const point = timeline.get(bucketKey) || { at: bucketKey, inputTokens: 0, outputTokens: 0, requests: 0, cacheHits: 0, cacheMisses: 0, cacheBypasses: 0, lmCachedInputTokens: 0 };
    point.inputTokens += metric.inputTokens || 0;
    point.outputTokens += metric.outputTokens || 0;
    point.requests += 1;
    point.cacheHits += metric.cacheStatus === 'hit' ? 1 : 0;
    point.cacheMisses += metric.cacheStatus === 'miss' ? 1 : 0;
    point.cacheBypasses += metric.cacheStatus === 'bypass' ? 1 : 0;
    point.lmCachedInputTokens += Number.isFinite(metric.lmCachedInputTokens) ? metric.lmCachedInputTokens : 0;
    timeline.set(bucketKey, point);
  }

  totals.averageLatencyMs = latencyValues.length
    ? Math.round(latencyValues.reduce((sum, value) => sum + value, 0) / latencyValues.length)
    : 0;
  totals.cacheHitRate = totals.cacheHits + totals.cacheMisses
    ? totals.cacheHits / (totals.cacheHits + totals.cacheMisses)
    : null;
  totals.lmCacheHitRate = totals.lmReportedInputTokens
    ? totals.lmCachedInputTokens / totals.lmReportedInputTokens
    : null;
  totals.averageTokensPerSecond = throughputSeconds > 0
    ? Math.round(throughputOutputTokens / throughputSeconds * 10) / 10
    : null;

  return {
    totals,
    byKey: [...byKey.values()].sort((a, b) => b.inputTokens + b.outputTokens - a.inputTokens - a.outputTokens),
    timeline: [...timeline.values()].sort((a, b) => a.at.localeCompare(b.at))
  };
}
