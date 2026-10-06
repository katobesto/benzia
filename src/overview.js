import { summarizeMetrics } from './metrics.js';

function parseDateValue(value, endOfDay = false) {
  if (typeof value !== 'string' || !value) return null;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const parsed = new Date(dateOnly ? `${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z` : value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

// Shared by the administrative panel and the read-only /status view so both
// render exactly the same operating summary.
const overviewCache = new WeakMap();
export function buildOverviewPayload(store, query = {}) {
  const cacheKey = JSON.stringify(query);
  const cache = overviewCache.get(store) || new Map();
  overviewCache.set(store, cache);
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const hours = Math.min(24 * 90, Math.max(1, Number.parseInt(query.hours || '24', 10)));
  const keyId = typeof query.keyId === 'string' ? query.keyId : undefined;
  const model = typeof query.model === 'string' && query.model ? query.model : undefined;
  const hasDateRange = 'from' in query || 'to' in query;
  const requestedFrom = parseDateValue(query.from);
  const requestedTo = parseDateValue(query.to, true);
  if (hasDateRange && ((query.from && !requestedFrom) || (query.to && !requestedTo) || (requestedFrom && requestedTo && requestedFrom > requestedTo))) {
    return { error: 'El intervalo de fechas no es válido.' };
  }
  const now = new Date();
  const fromDate = requestedFrom || new Date(now.getTime() - hours * 3600000);
  const toDate = requestedTo || now;
  const rangeHours = Math.max(1, (toDate.getTime() - fromDate.getTime()) / 3600000);
  const from = fromDate.toISOString();
  const to = toDate.toISOString();
  const keys = store.listKeys();
  const bucket = rangeHours > 72 ? 'day' : 'hour';
  const metrics = store.getMetrics({ from, to, keyId, model, limit: store.getMetricsSummary ? 20 : 50000 });
  const summary = store.getMetricsSummary ? store.getMetricsSummary({ from, to, keyId, model, bucket }, keys) : summarizeMetrics(metrics, keys, bucket);
  const result = {
    payload: {
      range: { from, to, hours: rangeHours },
      models: store.getModels({ from, to, keyId }),
      ...summary,
      recent: metrics.slice(-20).reverse()
    }
  };
  cache.set(cacheKey, { value: result, expiresAt: Date.now() + 3000 });
  if (cache.size > 100) cache.delete(cache.keys().next().value);
  return result;
}