import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';
import helmet from 'helmet';

import { adminAuth } from './admin-auth.js';
import { summarizeMetrics } from './metrics.js';

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');

const validName = (value) => typeof value === 'string' && value.trim().length >= 2 && value.trim().length <= 80;

export function createAdminApp({ config, store, cache, liveActivity }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy: { directives: { 'script-src': ["'self'"], 'style-src': ["'self'"], 'img-src': ["'self'", 'data:'] } } }));
  app.use(express.json({ limit: '1mb' }));
  app.use(express.static(publicDir, { extensions: ['html'] }));

  const auth = adminAuth(config.adminToken);
  app.get('/admin/api/session', auth, (_req, res) => res.json({ authenticated: true }));

  app.get('/admin/api/overview', auth, (req, res) => {
    const hours = Math.min(24 * 90, Math.max(1, Number.parseInt(req.query.hours || '24', 10)));
    const keyId = typeof req.query.keyId === 'string' ? req.query.keyId : undefined;
    const parseDate = (value, endOfDay = false) => {
      if (typeof value !== 'string' || !value) return null;
      const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
      const parsed = new Date(dateOnly ? `${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z` : value);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    };
    const hasDateRange = 'from' in req.query || 'to' in req.query;
    const requestedFrom = parseDate(req.query.from);
    const requestedTo = parseDate(req.query.to, true);
    if (hasDateRange && ((req.query.from && !requestedFrom) || (req.query.to && !requestedTo) || (requestedFrom && requestedTo && requestedFrom > requestedTo))) {
      return res.status(400).json({ error: 'El intervalo de fechas no es válido.' });
    }
    const now = new Date();
    const fromDate = requestedFrom || new Date(now.getTime() - hours * 3600000);
    const toDate = requestedTo || now;
    const rangeHours = Math.max(1, (toDate.getTime() - fromDate.getTime()) / 3600000);
    const from = fromDate.toISOString();
    const to = toDate.toISOString();
    const keys = store.listKeys();
    const metrics = store.getMetrics({ from, to, keyId, limit: 50000 });
    res.json({
      range: { from, to, hours: rangeHours },
      ...summarizeMetrics(metrics, keys, rangeHours > 72 ? 'day' : 'hour'),
      recent: metrics.slice(-20).reverse()
    });
  });

  app.get('/admin/api/live', auth, (req, res) => {
    const keyId = typeof req.query.keyId === 'string' ? req.query.keyId : undefined;
    res.json(liveActivity?.snapshot({ keyId }) || { activeStreams: 0, tokensPerSecond: 0, streams: [] });
  });

  app.get('/admin/api/keys', auth, (_req, res) => res.json({ keys: store.listKeys() }));

  app.post('/admin/api/keys', auth, async (req, res) => {
    if (!validName(req.body?.name)) return res.status(400).json({ error: 'El nombre debe contener entre 2 y 80 caracteres.' });
    const created = await store.createKey(req.body.name.trim());
    res.status(201).json({ key: created, notice: 'Guarde el token ahora: no volverá a mostrarse.' });
  });

  app.patch('/admin/api/keys/:id', auth, async (req, res) => {
    if (!validName(req.body?.name)) return res.status(400).json({ error: 'El nombre debe contener entre 2 y 80 caracteres.' });
    const key = await store.renameKey(req.params.id, req.body.name.trim());
    if (!key) return res.status(404).json({ error: 'Clave no encontrada.' });
    res.json({ key });
  });

  app.delete('/admin/api/keys/:id', auth, async (req, res) => {
    const revoked = await store.revokeKey(req.params.id);
    if (!revoked) return res.status(404).json({ error: 'Clave no encontrada.' });
    res.status(204).end();
  });

  app.get('/admin/api/settings', auth, (_req, res) => {
    const settings = store.getSettings();
    const hasUpstreamApiKey = Boolean(settings.upstreamApiKey ?? config.upstreamApiKey);
    res.json({
      upstreamBaseUrl: settings.upstreamBaseUrl || config.upstreamBaseUrl,
      hasUpstreamApiKey,
      gatewayPort: config.gatewayPort,
      adminPort: config.adminPort,
      publicGatewayUrl: settings.publicGatewayUrl || config.publicGatewayUrl,
      cache: cache.stats(),
      storage: store.storageStats?.() || null,
      retentionDays: config.metricsRetentionDays
    });
  });

  app.patch('/admin/api/settings', auth, async (req, res) => {
    const patch = {};
    if ('upstreamBaseUrl' in req.body) {
      try {
        const url = new URL(req.body.upstreamBaseUrl);
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error('invalid protocol');
        patch.upstreamBaseUrl = url.toString().replace(/\/+$/, '');
      } catch {
        return res.status(400).json({ error: 'La URL de Proveedor IA Local no es válida.' });
      }
    }
    if ('publicGatewayUrl' in req.body) {
      try {
        const url = new URL(req.body.publicGatewayUrl);
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error('invalid protocol');
        patch.publicGatewayUrl = url.toString().replace(/\/+$/, '');
      } catch {
        return res.status(400).json({ error: 'La URL pública del gateway no es válida.' });
      }
    }
    if (typeof req.body.upstreamApiKey === 'string' && req.body.upstreamApiKey.length) patch.upstreamApiKey = req.body.upstreamApiKey;
    if (req.body.clearUpstreamApiKey === true) patch.upstreamApiKey = '';
    await store.updateSettings(patch);
    res.json({ updated: true });
  });

  app.post('/admin/api/cache/clear', auth, (_req, res) => res.json({ cleared: cache.clear() }));

  app.get('/admin/api/upstream/status', auth, async (_req, res) => {
    const stored = store.getSettings();
    const baseUrl = (stored.upstreamBaseUrl || config.upstreamBaseUrl).replace(/\/+$/, '');
    const apiKey = stored.upstreamApiKey ?? config.upstreamApiKey;
    const startedAt = Date.now();
    try {
      const response = await fetch(`${baseUrl}/v1/models`, {
        headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
        signal: AbortSignal.timeout(5000)
      });
      const payload = await response.json().catch(() => ({}));
      res.status(response.ok ? 200 : 502).json({
        online: response.ok,
        status: response.status,
        latencyMs: Date.now() - startedAt,
        models: Array.isArray(payload.data) ? payload.data.map((model) => model.id) : []
      });
    } catch (error) {
      res.status(502).json({ online: false, latencyMs: Date.now() - startedAt, error: error.message });
    }
  });

  app.use('/admin/api', (_req, res) => res.status(404).json({ error: 'Ruta administrativa no encontrada.' }));
  app.get('*', (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));

  app.use((error, _req, res, _next) => {
    console.error(error);
    res.status(500).json({ error: 'Error interno del panel.' });
  });

  return app;
}
