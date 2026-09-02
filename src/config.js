import crypto from 'node:crypto';
import path from 'node:path';

const numberFromEnv = (name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) => {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
};

const normalizeBaseUrl = (value) => value.replace(/\/+$/, '');

export function loadConfig() {
  const generatedAdminToken = !process.env.ADMIN_TOKEN;
  return {
    adminToken: process.env.ADMIN_TOKEN || crypto.randomBytes(24).toString('base64url'),
    generatedAdminToken,
    adminHost: process.env.ADMIN_HOST || '127.0.0.1',
    adminPort: numberFromEnv('ADMIN_PORT', 3400, { min: 1, max: 65535 }),
    gatewayHost: process.env.GATEWAY_HOST || '0.0.0.0',
    gatewayPort: numberFromEnv('GATEWAY_PORT', 3401, { min: 1, max: 65535 }),
    publicGatewayUrl: normalizeBaseUrl(process.env.PUBLIC_GATEWAY_URL || `http://localhost:${process.env.GATEWAY_PORT || 3401}`),
    upstreamBaseUrl: normalizeBaseUrl(process.env.LM_STUDIO_BASE_URL || 'http://127.0.0.1:1234'),
    upstreamApiKey: process.env.LM_STUDIO_API_KEY || '',
    dataDir: path.resolve(process.env.DATA_DIR || './data'),
    cacheTtlSeconds: numberFromEnv('CACHE_TTL_SECONDS', 300, { min: 0, max: 86400 }),
    cacheMaxEntries: numberFromEnv('CACHE_MAX_ENTRIES', 250, { min: 0, max: 10000 }),
    requestTimeoutMs: numberFromEnv('REQUEST_TIMEOUT_MS', 300000, { min: 1000, max: 1800000 }),
    metricsRetentionDays: numberFromEnv('METRICS_RETENTION_DAYS', 30, { min: 1, max: 3650 })
  };
}
