import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { DatabaseSync } from 'node:sqlite';
import { clearProviderModelsCache } from './providers.js';

export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// NULL means "every external provider is visible" for keys that allow
// external access; an array acts as a filter over the configured providers.
function parseExternalProviderIds(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string' && id) : null;
  } catch {
    return null;
  }
}

const normalizeMetric = (metric) => {
  let normalized = metric;
  if (metric.stream === true && metric.cacheStatus === 'miss') {
    normalized = { ...normalized, cacheStatus: 'bypass' };
  }
  if (
    !metric.telemetryVersion &&
    metric.throughputSource === 'estimated' &&
    Number(metric.outputTokens) > 0 &&
    Number(metric.latencyMs) > 0
  ) {
    const endToEndRate = Number(metric.outputTokens) / (Number(metric.latencyMs) / 1000);
    normalized = {
      ...normalized,
      telemetryVersion: 2,
      tokensPerSecond: Math.round(endToEndRate * 10) / 10,
      throughputSource: 'estimated_end_to_end',
      generationDurationMs: Number(metric.latencyMs),
      timeToFirstTokenMs: null
    };
  }
  return normalized;
};

export class SqliteStore {
  constructor(dataDir, retentionDays = 30) {
    this.dataDir = dataDir;
    this.filePath = path.join(dataDir, 'gateway.sqlite');
    this.legacyFilePath = path.join(dataDir, 'gateway.json');
    this.retentionDays = retentionDays;
    this.db = null;
    this.statements = {};
    this.lastPruneAt = 0;
  }

  async init() {
    await fs.mkdir(this.dataDir, { recursive: true });
    this.db = new DatabaseSync(this.filePath, { enableForeignKeyConstraints: true });
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        data_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS access_keys (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        prefix TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        paused_at TEXT,
        paused_message TEXT,
        revoked_at TEXT,
        last_used_at TEXT,
        allow_external_providers INTEGER NOT NULL DEFAULT 0,
        external_provider_ids TEXT,
        token_limit INTEGER,
        consumed_tokens INTEGER NOT NULL DEFAULT 0,
        cached_tokens INTEGER NOT NULL DEFAULT 0,
        uncached_input_tokens INTEGER NOT NULL DEFAULT 0,
        cache_reported_input_tokens INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS metrics (
        id TEXT PRIMARY KEY,
        at TEXT NOT NULL,
        key_id TEXT NOT NULL,
        status INTEGER NOT NULL,
        cache_status TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        latency_ms REAL NOT NULL DEFAULT 0,
        data_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS security_events (
        id TEXT PRIMARY KEY,
        at TEXT NOT NULL,
        event_type TEXT NOT NULL,
        route TEXT NOT NULL,
        identity TEXT,
        address_fingerprint TEXT,
        retry_after_seconds INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_metrics_at ON metrics(at);
      CREATE INDEX IF NOT EXISTS idx_metrics_key_at ON metrics(key_id, at);
      CREATE INDEX IF NOT EXISTS idx_metrics_cache_at ON metrics(cache_status, at);
      CREATE INDEX IF NOT EXISTS idx_security_events_at ON security_events(at);
    `);
    const accessKeyColumns = new Set(this.db.prepare('PRAGMA table_info(access_keys)').all().map((column) => column.name));
    if (!accessKeyColumns.has('paused_at')) this.db.exec('ALTER TABLE access_keys ADD COLUMN paused_at TEXT');
    if (!accessKeyColumns.has('paused_message')) this.db.exec('ALTER TABLE access_keys ADD COLUMN paused_message TEXT');
    if (!accessKeyColumns.has('allow_external_providers')) this.db.exec('ALTER TABLE access_keys ADD COLUMN allow_external_providers INTEGER NOT NULL DEFAULT 0');
    if (!accessKeyColumns.has('external_provider_ids')) this.db.exec('ALTER TABLE access_keys ADD COLUMN external_provider_ids TEXT');
    if (!accessKeyColumns.has('token_limit')) this.db.exec('ALTER TABLE access_keys ADD COLUMN token_limit INTEGER');
    const hadConsumedTokens = accessKeyColumns.has('consumed_tokens');
    if (!hadConsumedTokens) {
      this.db.exec('ALTER TABLE access_keys ADD COLUMN consumed_tokens INTEGER NOT NULL DEFAULT 0');
      this.db.exec(`UPDATE access_keys SET consumed_tokens = COALESCE((SELECT SUM(MAX(0, input_tokens - COALESCE(json_extract(data_json, '$.lmCachedInputTokens'), 0)) + output_tokens) FROM metrics WHERE metrics.key_id = access_keys.id), 0)`);
    }
    if (!accessKeyColumns.has('cached_tokens')) {
      this.db.exec('ALTER TABLE access_keys ADD COLUMN cached_tokens INTEGER NOT NULL DEFAULT 0');
      this.db.exec(`UPDATE access_keys SET cached_tokens = COALESCE((SELECT SUM(MIN(input_tokens, MAX(0, COALESCE(json_extract(data_json, '$.lmCachedInputTokens'), 0)))) FROM metrics WHERE metrics.key_id = access_keys.id), 0)`);
      if (hadConsumedTokens) this.db.exec('UPDATE access_keys SET consumed_tokens = MAX(0, consumed_tokens - cached_tokens)');
    }
    if (!accessKeyColumns.has('uncached_input_tokens')) {
      this.db.exec('ALTER TABLE access_keys ADD COLUMN uncached_input_tokens INTEGER NOT NULL DEFAULT 0');
      this.db.exec(`UPDATE access_keys SET uncached_input_tokens = COALESCE((SELECT SUM(MAX(0, input_tokens - MIN(input_tokens, MAX(0, COALESCE(json_extract(data_json, '$.lmCachedInputTokens'), 0))))) FROM metrics WHERE metrics.key_id = access_keys.id), 0)`);
    }
    if (!accessKeyColumns.has('cache_reported_input_tokens')) {
      this.db.exec('ALTER TABLE access_keys ADD COLUMN cache_reported_input_tokens INTEGER NOT NULL DEFAULT 0');
      this.db.exec(`UPDATE access_keys SET cache_reported_input_tokens = COALESCE((SELECT SUM(input_tokens) FROM metrics WHERE metrics.key_id = access_keys.id AND json_type(data_json, '$.lmCachedInputTokens') IN ('integer', 'real')), 0)`);
    }
    this.prepareStatements();
    await this.migrateLegacyJson();
    this.migrateStoredMetrics();
    this.pruneMetrics(true);
  }

  prepareStatements() {
    this.statements.settingsGet = this.db.prepare('SELECT data_json FROM settings WHERE id = 1');
    this.statements.settingsSet = this.db.prepare(`
      INSERT INTO settings (id, data_json) VALUES (1, ?)
      ON CONFLICT(id) DO UPDATE SET data_json = excluded.data_json
    `);
    this.statements.keysList = this.db.prepare(`
      SELECT id, name, prefix, created_at AS createdAt, paused_at AS pausedAt, paused_message AS pausedMessage, revoked_at AS revokedAt, last_used_at AS lastUsedAt, allow_external_providers AS allowExternalProviders, external_provider_ids AS externalProviderIds, token_limit AS tokenLimit, consumed_tokens AS consumedTokens, cached_tokens AS cachedTokens
      FROM access_keys ORDER BY created_at ASC
    `);
    this.statements.keyByHash = this.db.prepare(`
      SELECT id, name, prefix, created_at AS createdAt, paused_at AS pausedAt, paused_message AS pausedMessage, revoked_at AS revokedAt, last_used_at AS lastUsedAt, allow_external_providers AS allowExternalProviders, external_provider_ids AS externalProviderIds, token_limit AS tokenLimit, consumed_tokens AS consumedTokens, cached_tokens AS cachedTokens
      FROM access_keys WHERE token_hash = ? AND paused_at IS NULL AND revoked_at IS NULL
    `);
    this.statements.keyByHashAnyState = this.db.prepare(`
      SELECT id, name, prefix, created_at AS createdAt, paused_at AS pausedAt, paused_message AS pausedMessage, revoked_at AS revokedAt, last_used_at AS lastUsedAt, allow_external_providers AS allowExternalProviders, external_provider_ids AS externalProviderIds, token_limit AS tokenLimit, consumed_tokens AS consumedTokens, cached_tokens AS cachedTokens
      FROM access_keys WHERE token_hash = ?
    `);
    this.statements.keyInsert = this.db.prepare(`
      INSERT INTO access_keys (id, name, prefix, token_hash, created_at, paused_at, paused_message, revoked_at, last_used_at, allow_external_providers, external_provider_ids)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.statements.keyPause = this.db.prepare('UPDATE access_keys SET paused_at = COALESCE(paused_at, ?), paused_message = ? WHERE id = ? AND revoked_at IS NULL');
    this.statements.keyResume = this.db.prepare('UPDATE access_keys SET paused_at = NULL WHERE id = ? AND revoked_at IS NULL');
    this.statements.keyRevoke = this.db.prepare('UPDATE access_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL');
    this.statements.keyDelete = this.db.prepare('DELETE FROM access_keys WHERE id = ?');
    this.statements.keyTokenLimit = this.db.prepare('UPDATE access_keys SET token_limit = ? WHERE id = ?');
    this.statements.keyStats = this.db.prepare('SELECT token_limit AS tokenLimit, consumed_tokens AS consumedTokens, cached_tokens AS cachedTokens, uncached_input_tokens AS uncachedInputTokens, cache_reported_input_tokens AS cacheReportedInputTokens FROM access_keys WHERE id = ?');
    this.statements.keyRename = this.db.prepare('UPDATE access_keys SET name = ? WHERE id = ?');
    this.statements.keyExternalAccess = this.db.prepare('UPDATE access_keys SET allow_external_providers = ?, external_provider_ids = ? WHERE id = ? AND revoked_at IS NULL');
    this.statements.keyTouch = this.db.prepare('UPDATE access_keys SET last_used_at = ? WHERE id = ?');
    this.statements.keyConsume = this.db.prepare('UPDATE access_keys SET consumed_tokens = consumed_tokens + ? WHERE id = ?');
    this.statements.keyTrackCache = this.db.prepare('UPDATE access_keys SET cached_tokens = cached_tokens + ?, uncached_input_tokens = uncached_input_tokens + ?, cache_reported_input_tokens = cache_reported_input_tokens + ? WHERE id = ?');
    this.statements.metricInsert = this.db.prepare(`
      INSERT INTO metrics (id, at, key_id, status, cache_status, input_tokens, output_tokens, latency_ms, data_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.statements.metricPrune = this.db.prepare('DELETE FROM metrics WHERE at < ?');
    this.statements.metricUpdate = this.db.prepare(`
      UPDATE metrics SET cache_status = ?, input_tokens = ?, output_tokens = ?, latency_ms = ?, data_json = ? WHERE id = ?
    `);
    this.statements.securityEventInsert = this.db.prepare(`
      INSERT INTO security_events (id, at, event_type, route, identity, address_fingerprint, retry_after_seconds)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    this.statements.securityEventsList = this.db.prepare(`
      SELECT id, at, event_type AS type, route, identity, address_fingerprint AS addressFingerprint, retry_after_seconds AS retryAfterSeconds
      FROM security_events ORDER BY at DESC LIMIT ?
    `);
    this.statements.securityEventsPrune = this.db.prepare('DELETE FROM security_events WHERE at < ?');
  }

  async migrateLegacyJson() {
    const existing = this.db.prepare('SELECT (SELECT COUNT(*) FROM access_keys) + (SELECT COUNT(*) FROM metrics) AS count').get();
    if (Number(existing.count) > 0) return;
    let parsed;
    try {
      parsed = JSON.parse(await fs.readFile(this.legacyFilePath, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return;
    }

    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.statements.settingsSet.run(JSON.stringify(parsed.settings || {}));
      for (const key of Array.isArray(parsed.keys) ? parsed.keys : []) {
        this.statements.keyInsert.run(
          key.id, key.name, key.prefix, key.tokenHash,
          key.createdAt, key.pausedAt || null, key.pausedMessage || null, key.revokedAt || null, key.lastUsedAt || null,
          key.allowExternalProviders ? 1 : 0,
          Array.isArray(key.externalProviderIds) ? JSON.stringify(key.externalProviderIds) : null
        );
      }
      for (const rawMetric of Array.isArray(parsed.metrics) ? parsed.metrics : []) {
        const metric = normalizeMetric(rawMetric);
        this.insertMetric(metric);
        this.trackMetricTokens(metric);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }

    let backupPath = `${this.legacyFilePath}.migrated`;
    try {
      await fs.access(backupPath);
      backupPath = `${backupPath}-${Date.now()}`;
    } catch { /* El nombre base está libre. */ }
    await fs.rename(this.legacyFilePath, backupPath);
    console.log(`Datos migrados a SQLite. Copia JSON conservada en ${backupPath}`);
  }

  insertMetric(metric) {
    this.statements.metricInsert.run(
      metric.id,
      metric.at,
      metric.keyId,
      Number(metric.status) || 0,
      metric.cacheStatus || 'bypass',
      Number(metric.inputTokens) || 0,
      Number(metric.outputTokens) || 0,
      Number(metric.latencyMs) || 0,
      JSON.stringify(metric)
    );
  }

  migrateStoredMetrics() {
    const rows = this.db.prepare('SELECT id, data_json FROM metrics').all();
    const updates = [];
    for (const row of rows) {
      const original = JSON.parse(row.data_json);
      const normalized = normalizeMetric(original);
      if (normalized !== original) updates.push(normalized);
    }
    if (!updates.length) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const metric of updates) {
        this.statements.metricUpdate.run(
          metric.cacheStatus || 'bypass',
          Number(metric.inputTokens) || 0,
          Number(metric.outputTokens) || 0,
          Number(metric.latencyMs) || 0,
          JSON.stringify(metric),
          metric.id
        );
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  pruneMetrics(force = false) {
    const now = Date.now();
    if (!force && now - this.lastPruneAt < 3600000) return;
    const cutoff = new Date(now - this.retentionDays * 86400000).toISOString();
    this.statements.metricPrune.run(cutoff);
    this.lastPruneAt = now;
  }

  getSettings() {
    const row = this.statements.settingsGet.get();
    return row ? JSON.parse(row.data_json) : {};
  }

  async updateSettings(patch) {
    clearProviderModelsCache();
    const settings = { ...this.getSettings(), ...structuredClone(patch) };
    this.statements.settingsSet.run(JSON.stringify(settings));
    return this.getSettings();
  }

  listKeys() {
    return this.statements.keysList.all().map((key) => ({
      ...key,
      allowExternalProviders: Boolean(key.allowExternalProviders),
      externalProviderIds: parseExternalProviderIds(key.externalProviderIds)
    }));
  }

  findKeyByToken(token, { includeInactive = false } = {}) {
    if (!token) return null;
    const statement = includeInactive ? this.statements.keyByHashAnyState : this.statements.keyByHash;
    const key = statement.get(hashToken(token));
    return key ? {
      ...key,
      allowExternalProviders: Boolean(key.allowExternalProviders),
      externalProviderIds: parseExternalProviderIds(key.externalProviderIds)
    } : null;
  }

  async createKey(name, { allowExternalProviders = false, externalProviderIds = null } = {}) {
    const token = `lmg_${crypto.randomBytes(28).toString('base64url')}`;
    const allow = Boolean(allowExternalProviders);
    const filter = allow && Array.isArray(externalProviderIds) ? externalProviderIds : null;
    const key = {
      id: crypto.randomUUID(),
      name,
      prefix: token.slice(0, 12),
      createdAt: new Date().toISOString(),
      pausedAt: null,
      pausedMessage: null,
      revokedAt: null,
      lastUsedAt: null,
      allowExternalProviders: allow,
      externalProviderIds: filter
    };
    this.statements.keyInsert.run(key.id, key.name, key.prefix, hashToken(token), key.createdAt, null, null, null, null, allow ? 1 : 0, filter ? JSON.stringify(filter) : null);
    return { ...key, token };
  }

  async setKeyPaused(id, paused, pausedMessage = null) {
    const result = paused
      ? this.statements.keyPause.run(new Date().toISOString(), pausedMessage || null, id)
      : this.statements.keyResume.run(id);
    if (Number(result.changes) === 0) return null;
    return this.listKeys().find((key) => key.id === id) || null;
  }

  async revokeKey(id) {
    return Number(this.statements.keyRevoke.run(new Date().toISOString(), id).changes) > 0;
  }

  async deleteKey(id) { return Number(this.statements.keyDelete.run(id).changes) > 0; }

  async setKeyTokenLimit(id, tokenLimit) {
    const result = this.statements.keyTokenLimit.run(tokenLimit, id);
    return Number(result.changes) ? this.listKeys().find((key) => key.id === id) || null : null;
  }

  getKeyStats(id) {
    const row = this.statements.keyStats.get(id);
    if (!row) return null;
    const consumedTokens = Number(row.consumedTokens) || 0;
    const tokenLimit = row.tokenLimit == null ? null : Number(row.tokenLimit);
    const cachedTokens = Number(row.cachedTokens) || 0;
    const uncachedInputTokens = Number(row.uncachedInputTokens) || 0;
    const cacheReportedInputTokens = Number(row.cacheReportedInputTokens) || 0;
    const cachePercent = cacheReportedInputTokens ? Math.min(100, cachedTokens / cacheReportedInputTokens * 100) : null;
    return { totalTokens: consumedTokens + cachedTokens, consumedTokens, availableTokens: tokenLimit == null ? null : Math.max(0, tokenLimit - consumedTokens), tokenLimit, usagePercent: tokenLimit == null ? null : Math.min(100, tokenLimit ? consumedTokens / tokenLimit * 100 : 100), uncachedInputTokens, outputTokens: Math.max(0, consumedTokens - uncachedInputTokens), cachedTokens, cachePercent };
  }

  async renameKey(id, name) {
    const result = this.statements.keyRename.run(name, id);
    if (Number(result.changes) === 0) return null;
    return this.listKeys().find((key) => key.id === id) || null;
  }

  async setKeyExternalAccess(id, allowExternalProviders = undefined, providerIds = undefined) {
    const current = this.listKeys().find((key) => key.id === id);
    if (!current || current.revokedAt) return null;
    const allow = allowExternalProviders === undefined ? current.allowExternalProviders : Boolean(allowExternalProviders);
    let storedFilter = null;
    if (allow) {
      const effective = providerIds === undefined ? current.externalProviderIds : providerIds;
      storedFilter = effective ? JSON.stringify(effective) : null;
    }
    const result = this.statements.keyExternalAccess.run(allow ? 1 : 0, storedFilter, id);
    if (Number(result.changes) === 0) return null;
    return this.listKeys().find((key) => key.id === id) || null;
  }

  async recordMetric(metric) {
    this.pruneMetrics();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.insertMetric(metric);
      this.statements.keyTouch.run(metric.at, metric.keyId);
      this.trackMetricTokens(metric);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  trackMetricTokens(metric) {
    const inputTokens = Math.max(0, Number(metric.inputTokens) || 0);
    const cachedInputTokens = Number.isFinite(metric.lmCachedInputTokens)
      ? Math.min(inputTokens, Math.max(0, Number(metric.lmCachedInputTokens)))
      : 0;
    const uncachedInputTokens = inputTokens - cachedInputTokens;
    const outputTokens = Math.max(0, Number(metric.outputTokens) || 0);
    this.statements.keyConsume.run(uncachedInputTokens + outputTokens, metric.keyId);
    this.statements.keyTrackCache.run(cachedInputTokens, uncachedInputTokens, Number.isFinite(metric.lmCachedInputTokens) ? inputTokens : 0, metric.keyId);
  }

  getMetrics({ from, to, keyId, model, limit = 5000 } = {}) {
    const conditions = [];
    const params = [];
    if (from) { conditions.push('at >= ?'); params.push(from); }
    if (to) { conditions.push('at <= ?'); params.push(to); }
    if (keyId) { conditions.push('key_id = ?'); params.push(keyId); }
    if (model) { conditions.push(`json_extract(data_json, '$.model') = ?`); params.push(model); }
    const safeLimit = Math.min(50000, Math.max(1, Number(limit) || 5000));
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.db.prepare(`SELECT data_json FROM metrics ${where} ORDER BY at DESC LIMIT ?`).all(...params, safeLimit);
    return rows.reverse().map((row) => JSON.parse(row.data_json));
  }

  getMetricsSummary({ from, to, keyId, model, bucket = 'hour' }, keys) {
    const conditions = ['at >= ?', 'at <= ?'];
    const params = [from, to];
    if (keyId) { conditions.push('key_id = ?'); params.push(keyId); }
    if (model) { conditions.push("json_extract(data_json, '$.model') = ?"); params.push(model); }
    const base = `WITH selected AS (SELECT *,
      json_extract(data_json, '$.lmCachedInputTokens') AS cached,
      json_extract(data_json, '$.tokensPerSecond') AS rate,
      json_extract(data_json, '$.generationDurationMs') AS duration,
      json_extract(data_json, '$.throughputSource') AS source,
      json_extract(data_json, '$.telemetryVersion') AS version
      FROM metrics WHERE ${conditions.join(' AND ')}), enriched AS (SELECT *,
      CASE WHEN (source = 'upstream' OR version >= 2) AND rate > 0 AND output_tokens > 0 THEN 1 ELSE 0 END AS measured
      FROM selected)`;
    const fields = `COUNT(*) AS requests, COALESCE(SUM(input_tokens),0) AS inputTokens,
      COALESCE(SUM(output_tokens),0) AS outputTokens, COALESCE(SUM(status >= 400),0) AS errors,
      COALESCE(SUM(cached),0) AS lmCachedInputTokens,
      COALESCE(SUM(CASE WHEN cached IS NOT NULL THEN input_tokens ELSE 0 END),0) AS lmReportedInputTokens,
      COALESCE(SUM(CASE WHEN cached IS NOT NULL THEN MAX(0,input_tokens-cached) ELSE 0 END),0) AS lmUncachedInputTokens,
      COUNT(cached) AS lmCacheReportedRequests`;
    const totals = this.db.prepare(`${base} SELECT ${fields}, COALESCE(AVG(latency_ms),0) AS averageLatencyMs,
      COALESCE(SUM(measured),0) AS throughputSamples,
      COALESCE(SUM(CASE WHEN measured AND source = 'upstream' THEN 1 ELSE 0 END),0) AS throughputReportedRequests,
      COALESCE(SUM(CASE WHEN measured AND source != 'upstream' THEN 1 ELSE 0 END),0) AS throughputEstimatedRequests,
      SUM(CASE WHEN measured THEN output_tokens ELSE 0 END) AS rateTokens,
      SUM(CASE WHEN measured THEN CASE WHEN duration > 0 THEN duration/1000.0 ELSE output_tokens/rate END ELSE 0 END) AS rateSeconds
      FROM enriched`).get(...params);
    totals.averageLatencyMs = Math.round(totals.averageLatencyMs);
    totals.averageTokensPerSecond = totals.rateSeconds > 0 ? Math.round(totals.rateTokens / totals.rateSeconds * 10) / 10 : null;
    totals.lmCacheHitRate = totals.lmReportedInputTokens ? totals.lmCachedInputTokens / totals.lmReportedInputTokens : null;
    delete totals.rateTokens; delete totals.rateSeconds;
    const keyMap = new Map(keys.map(key => [key.id, key]));
    const byKey = this.db.prepare(`${base} SELECT key_id AS keyId, ${fields}, MAX(at) AS lastActivity FROM enriched GROUP BY key_id ORDER BY SUM(input_tokens+output_tokens) DESC`).all(...params).map(row => ({ ...row, name: keyMap.get(row.keyId)?.name || 'Clave eliminada', prefix: keyMap.get(row.keyId)?.prefix || '—' }));
    const format = bucket === 'day' ? '%Y-%m-%dT00:00:00.000Z' : '%Y-%m-%dT%H:00:00.000Z';
    const timeline = this.db.prepare(`${base} SELECT strftime('${format}',at) AS at, ${fields} FROM enriched GROUP BY 1 ORDER BY 1`).all(...params);
    return { totals: { ...totals }, byKey, timeline };
  }

  recordSecurityEvent(event) {
    const at = event.at || new Date().toISOString();
    this.statements.securityEventInsert.run(
      event.id || crypto.randomUUID(), at, event.type, event.route,
      event.identity || null, event.addressFingerprint || null,
      Math.max(1, Number(event.retryAfterSeconds) || 1)
    );
    const cutoff = new Date(Date.now() - this.retentionDays * 86400000).toISOString();
    this.statements.securityEventsPrune.run(cutoff);
  }

  getSecurityEvents({ limit = 100 } = {}) {
    const safeLimit = Math.min(500, Math.max(1, Number(limit) || 100));
    return this.statements.securityEventsList.all(safeLimit);
  }

  // Modelos distintos usados en el periodo (no aplica el filtro de modelo,
  // para que el select del dashboard se pueble con todos los disponibles).
  getModels({ from, to, keyId } = {}) {
    const conditions = [];
    const params = [];
    if (from) { conditions.push('at >= ?'); params.push(from); }
    if (to) { conditions.push('at <= ?'); params.push(to); }
    if (keyId) { conditions.push('key_id = ?'); params.push(keyId); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.db.prepare(
      `SELECT json_extract(data_json, '$.model') AS model, COUNT(*) AS count
       FROM metrics ${where}
       GROUP BY 1
       HAVING model IS NOT NULL
       ORDER BY count DESC, model ASC`
    ).all(...params);
    return rows.map((row) => ({ model: row.model, count: Number(row.count) }));
  }

  storageStats() {
    const metrics = Number(this.db.prepare('SELECT COUNT(*) AS count FROM metrics').get().count);
    const pageCount = Number(this.db.prepare('PRAGMA page_count').get().page_count);
    const pageSize = Number(this.db.prepare('PRAGMA page_size').get().page_size);
    return {
      engine: 'SQLite',
      journalMode: 'WAL',
      metrics,
      sizeBytes: pageCount * pageSize
    };
  }

  close() {
    if (!this.db) return;
    this.db.close();
    this.db = null;
  }
}
