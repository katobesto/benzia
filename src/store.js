import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { DatabaseSync } from 'node:sqlite';

export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
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
        revoked_at TEXT,
        last_used_at TEXT
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
      CREATE INDEX IF NOT EXISTS idx_metrics_at ON metrics(at);
      CREATE INDEX IF NOT EXISTS idx_metrics_key_at ON metrics(key_id, at);
      CREATE INDEX IF NOT EXISTS idx_metrics_cache_at ON metrics(cache_status, at);
    `);
    const accessKeyColumns = new Set(this.db.prepare('PRAGMA table_info(access_keys)').all().map((column) => column.name));
    if (!accessKeyColumns.has('paused_at')) this.db.exec('ALTER TABLE access_keys ADD COLUMN paused_at TEXT');
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
      SELECT id, name, prefix, created_at AS createdAt, paused_at AS pausedAt, revoked_at AS revokedAt, last_used_at AS lastUsedAt
      FROM access_keys ORDER BY created_at ASC
    `);
    this.statements.keyByHash = this.db.prepare(`
      SELECT id, name, prefix, created_at AS createdAt, paused_at AS pausedAt, revoked_at AS revokedAt, last_used_at AS lastUsedAt
      FROM access_keys WHERE token_hash = ? AND paused_at IS NULL AND revoked_at IS NULL
    `);
    this.statements.keyByHashAnyState = this.db.prepare(`
      SELECT id, name, prefix, created_at AS createdAt, paused_at AS pausedAt, revoked_at AS revokedAt, last_used_at AS lastUsedAt
      FROM access_keys WHERE token_hash = ?
    `);
    this.statements.keyInsert = this.db.prepare(`
      INSERT INTO access_keys (id, name, prefix, token_hash, created_at, paused_at, revoked_at, last_used_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.statements.keyPause = this.db.prepare('UPDATE access_keys SET paused_at = ? WHERE id = ? AND revoked_at IS NULL');
    this.statements.keyResume = this.db.prepare('UPDATE access_keys SET paused_at = NULL WHERE id = ? AND revoked_at IS NULL');
    this.statements.keyRevoke = this.db.prepare('UPDATE access_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL');
    this.statements.keyRename = this.db.prepare('UPDATE access_keys SET name = ? WHERE id = ?');
    this.statements.keyTouch = this.db.prepare('UPDATE access_keys SET last_used_at = ? WHERE id = ?');
    this.statements.metricInsert = this.db.prepare(`
      INSERT INTO metrics (id, at, key_id, status, cache_status, input_tokens, output_tokens, latency_ms, data_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.statements.metricPrune = this.db.prepare('DELETE FROM metrics WHERE at < ?');
    this.statements.metricUpdate = this.db.prepare(`
      UPDATE metrics SET cache_status = ?, input_tokens = ?, output_tokens = ?, latency_ms = ?, data_json = ? WHERE id = ?
    `);
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
          key.createdAt, key.pausedAt || null, key.revokedAt || null, key.lastUsedAt || null
        );
      }
      for (const rawMetric of Array.isArray(parsed.metrics) ? parsed.metrics : []) {
        this.insertMetric(normalizeMetric(rawMetric));
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
    const settings = { ...this.getSettings(), ...structuredClone(patch) };
    this.statements.settingsSet.run(JSON.stringify(settings));
    return this.getSettings();
  }

  listKeys() {
    return this.statements.keysList.all().map((key) => ({ ...key }));
  }

  findKeyByToken(token, { includeInactive = false } = {}) {
    if (!token) return null;
    const statement = includeInactive ? this.statements.keyByHashAnyState : this.statements.keyByHash;
    const key = statement.get(hashToken(token));
    return key ? { ...key } : null;
  }

  async createKey(name) {
    const token = `lmg_${crypto.randomBytes(28).toString('base64url')}`;
    const key = {
      id: crypto.randomUUID(),
      name,
      prefix: token.slice(0, 12),
      createdAt: new Date().toISOString(),
      pausedAt: null,
      revokedAt: null,
      lastUsedAt: null
    };
    this.statements.keyInsert.run(key.id, key.name, key.prefix, hashToken(token), key.createdAt, null, null, null);
    return { ...key, token };
  }

  async setKeyPaused(id, paused) {
    const result = paused
      ? this.statements.keyPause.run(new Date().toISOString(), id)
      : this.statements.keyResume.run(id);
    if (Number(result.changes) === 0) return null;
    return this.listKeys().find((key) => key.id === id) || null;
  }

  async revokeKey(id) {
    return Number(this.statements.keyRevoke.run(new Date().toISOString(), id).changes) > 0;
  }

  async renameKey(id, name) {
    const result = this.statements.keyRename.run(name, id);
    if (Number(result.changes) === 0) return null;
    return this.listKeys().find((key) => key.id === id) || null;
  }

  async recordMetric(metric) {
    this.pruneMetrics();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.insertMetric(metric);
      this.statements.keyTouch.run(metric.at, metric.keyId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  getMetrics({ from, to, keyId, limit = 5000 } = {}) {
    const conditions = [];
    const params = [];
    if (from) { conditions.push('at >= ?'); params.push(from); }
    if (to) { conditions.push('at <= ?'); params.push(to); }
    if (keyId) { conditions.push('key_id = ?'); params.push(keyId); }
    const safeLimit = Math.min(50000, Math.max(1, Number(limit) || 5000));
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.db.prepare(`SELECT data_json FROM metrics ${where} ORDER BY at DESC LIMIT ?`).all(...params, safeLimit);
    return rows.reverse().map((row) => JSON.parse(row.data_json));
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
