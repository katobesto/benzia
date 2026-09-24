import { summarizeMetrics } from './metrics.js';

function parseDateValue(value, endOfDay = false) {
  if (typeof value !== 'string' || !value) return null;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const parsed = new Date(dateOnly ? `${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z` : value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

// Shared by the administrative panel and the read-only /status view so both
// render exactly the same operating summary.
export function buildOverviewPayload(store, query = {}) {
  const hours = Math.min(24 * 90, Math.max(1, Number.parseInt(query.hours || '24', 10)));
  const keyId = typeof query.keyId === 'string' ? query.keyId : undefined;
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
  const metrics = store.getMetrics({ from, to, keyId, limit: 50000 });
  return {
    payload: {
      range: { from, to, hours: rangeHours },
      ...summarizeMetrics(metrics, keys, rangeHours > 72 ? 'day' : 'hour'),
      recent: metrics.slice(-20).reverse()
    }
  };
}