import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import express from 'express';
import helmet from 'helmet';

import { adminAuth } from './admin-auth.js';
import { DEFAULT_BRAVE_SEARCH_ENDPOINT, normalizeBraveEndpoint } from './brave-search.js';
import { CAPABILITIES_FILENAME, loadModelCapabilities, sanitizeModelCapabilities } from './model-capabilities.js';
import { buildOverviewPayload } from './overview.js';
import { fetchProviderModels, normalizeProviderBaseUrl, publicExternalProviders, sanitizeExternalProviders, PROVIDER_ID_PATTERN } from './providers.js';
import { jsonBodyErrorHandler } from './http-errors.js';

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');

const validName = (value) => typeof value === 'string' && value.trim().length >= 2 && value.trim().length <= 80;
const validPausedMessage = (value) => value === undefined || value === null || (typeof value === 'string' && value.trim().length <= 500);
const SERVER_SESSION_COOKIE = 'benzia_server_session';

function readCookie(req, name) {
  const cookies = req.get('cookie') || '';
  return cookies.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1) || '';
}

function serverSessionValue(adminToken) {
  return crypto.createHmac('sha256', adminToken).update('server-proxy').digest('hex');
}

function hasServerSession(req, adminToken) {
  const candidate = Buffer.from(readCookie(req, SERVER_SESSION_COOKIE));
  const expected = Buffer.from(serverSessionValue(adminToken));
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

function setServerSession(res, value, maxAge = 3600000) {
  res.set('set-cookie', `${SERVER_SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAge / 1000)}`);
}

function rewriteServerHtml(html) {
  return html
    .replace(/((?:href|src|action)\s*=\s*["'])\/(?!server(?:\/|["']))/gi, '$1/server/')
    .replace(/(url\(\s*["']?)\/(?!server(?:\/|["']))/gi, '$1/server/')
    .replace(/(src\s*=\s*["']\/server\/app\.js)(?=["'])/gi, '$1?v=20260910-proxy-2');
}

function rewriteServerJavaScript(script) {
  return script
    .replace(/(["'`])\/(?:api)(?=[\/"'`])/g, '$1/server/api')
    .replace(/(["'`])\/ninfer\.html(?=["'`])/g, '$1/server/ninfer.html');
}

export function normalizeOpenCodeBaseUrl(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Introduce una URL base para el servidor.');
  const url = new URL(value.trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('La URL debe ser HTTP(S), sin credenciales ni parámetros.');
  }
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = path.endsWith('/v1') ? path : `${path || ''}/v1`;
  return url.toString().replace(/\/+$/, '');
}

export function extractOpenAiModels(payload) {
  if (!Array.isArray(payload?.data)) return [];
  const seen = new Set();
  return payload.data.flatMap((model) => {
    const id = typeof model?.id === 'string' ? model.id.trim() : '';
    if (!id || seen.has(id)) return [];
    seen.add(id);
    return [{ id, name: typeof model?.name === 'string' && model.name.trim() ? model.name.trim() : id }];
  });
}

export function createAdminApp({ config, store, liveActivity }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy: { directives: { 'script-src': ["'self'"], 'style-src': ["'self'"], 'img-src': ["'self'", 'data:'] } } }));
  app.use(express.json({ limit: '1mb' }));
  app.use(express.static(publicDir, { extensions: ['html'], index: false }));

  const auth = adminAuth(config.adminToken);
  app.get('/admin/api/session', auth, (_req, res) => res.json({ authenticated: true }));

  app.post('/admin/api/server-session', auth, (_req, res) => {
    setServerSession(res, serverSessionValue(config.adminToken));
    res.json({ authenticated: true });
  });

  app.delete('/admin/api/server-session', auth, (_req, res) => {
    setServerSession(res, '', 0);
    res.status(204).end();
  });

  app.use('/server', async (req, res, next) => {
    if (!hasServerSession(req, config.adminToken)) return res.status(401).send('Sesión del servidor no válida.');
    const suffix = req.path === '/' ? '/' : req.path;
    const targetUrl = new URL(suffix + (req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : ''), `${config.serverProxyTarget}/`);
    targetUrl.searchParams.delete('_benzia_proxy');
    try {
      const hasBody = !['GET', 'HEAD'].includes(req.method);
      const requestHeaders = {};
      for (const name of ['accept', 'content-type', 'content-length', 'if-none-match', 'if-modified-since', 'range']) {
        const value = req.get(name);
        if (value) requestHeaders[name] = value;
      }
      const request = {
        method: req.method,
        headers: requestHeaders,
        signal: AbortSignal.timeout(15000)
      };
      if (hasBody && req.body !== undefined) {
        request.body = JSON.stringify(req.body);
        delete request.headers['content-length'];
        request.headers['content-type'] ||= 'application/json';
      } else if (hasBody) {
        request.body = req;
        request.duplex = 'half';
      }
      const upstream = await fetch(targetUrl, request);
      const contentType = upstream.headers.get('content-type') || '';
      const headers = {};
      for (const name of ['content-type', 'cache-control', 'etag', 'last-modified', 'location']) {
        const value = upstream.headers.get(name);
        if (value) headers[name] = value;
      }
      const upstreamCookies = upstream.headers.getSetCookie?.() || [];
      if (upstreamCookies.length) {
        headers['set-cookie'] = upstreamCookies.map((cookie) => cookie.replace(/Path=\/[^;]*/i, 'Path=/server'));
      }
      if (headers.location) {
        try {
          const location = new URL(headers.location, targetUrl);
          if (location.origin === new URL(config.serverProxyTarget).origin) headers.location = `/server${location.pathname}${location.search}${location.hash}`;
        } catch { /* Conserva redirecciones no URL. */ }
      }
      res.removeHeader('content-security-policy');
      res.removeHeader('x-frame-options');
      res.removeHeader('cross-origin-resource-policy');
      res.status(upstream.status).set({ ...headers, 'cache-control': 'no-store, private' });
      if (req.method === 'HEAD') return res.end();
      const buffer = Buffer.from(await upstream.arrayBuffer());
      if (contentType.includes('text/html')) return res.send(rewriteServerHtml(buffer.toString('utf8')));
      if (contentType.includes('javascript') || contentType.includes('ecmascript')) return res.send(rewriteServerJavaScript(buffer.toString('utf8')));
      return res.send(buffer);
    } catch (error) {
      return next(error);
    }
  });

  app.get('/admin/api/overview', auth, (req, res) => {
    const result = buildOverviewPayload(store, req.query);
    if (result.error) return res.status(400).json({ error: result.error });
    res.json(result.payload);
  });

  app.get('/admin/api/live', auth, (req, res) => {
    const keyId = typeof req.query.keyId === 'string' ? req.query.keyId : undefined;
    res.json(liveActivity?.snapshot({ keyId }) || { activeStreams: 0, tokensPerSecond: 0, streams: [] });
  });

  app.get('/admin/api/keys', auth, (_req, res) => res.json({ keys: store.listKeys() }));

  app.post('/admin/api/keys', auth, async (req, res) => {
    if (!validName(req.body?.name)) return res.status(400).json({ error: 'El nombre debe contener entre 2 y 80 caracteres.' });
    if ('allowExternalProviders' in req.body && typeof req.body.allowExternalProviders !== 'boolean') return res.status(400).json({ error: 'El acceso a proveedores externos debe ser verdadero o falso.' });
    const created = await store.createKey(req.body.name.trim(), { allowExternalProviders: req.body.allowExternalProviders === true });
    res.status(201).json({ key: created, notice: 'Guarde el token ahora: no volverá a mostrarse.' });
  });

  app.patch('/admin/api/keys/:id', auth, async (req, res) => {
    if (!validName(req.body?.name)) return res.status(400).json({ error: 'El nombre debe contener entre 2 y 80 caracteres.' });
    const key = await store.renameKey(req.params.id, req.body.name.trim());
    if (!key) return res.status(404).json({ error: 'Clave no encontrada.' });
    res.json({ key });
  });

  app.patch('/admin/api/keys/:id/access', auth, async (req, res) => {
    if (typeof req.body?.paused !== 'boolean') return res.status(400).json({ error: 'El estado de pausa debe ser verdadero o falso.' });
    if (!validPausedMessage(req.body?.pausedMessage)) return res.status(400).json({ error: 'El aviso personalizado no puede superar los 500 caracteres.' });
    const pausedMessage = typeof req.body.pausedMessage === 'string' ? req.body.pausedMessage.trim() || null : null;
    const key = await store.setKeyPaused(req.params.id, req.body.paused, pausedMessage);
    if (!key) return res.status(404).json({ error: 'Clave no encontrada o revocada.' });
    res.json({ key });
  });

  app.patch('/admin/api/keys/:id/providers', auth, async (req, res) => {
    const hasAccessLevel = 'allowExternalProviders' in req.body;
    const hasFilter = 'providerIds' in req.body;
    if (!hasAccessLevel && !hasFilter) return res.status(400).json({ error: 'Indica el nivel de acceso o los proveedores visibles.' });
    if (hasAccessLevel && typeof req.body.allowExternalProviders !== 'boolean') return res.status(400).json({ error: 'El acceso a proveedores externos debe ser verdadero o falso.' });
    let providerIds;
    if (hasFilter) {
      if (req.body.providerIds !== null) {
        if (!Array.isArray(req.body.providerIds) || req.body.providerIds.length > 20) {
          return res.status(400).json({ error: 'La lista de proveedores visibles no es válida.' });
        }
        for (const id of req.body.providerIds) {
          if (typeof id !== 'string' || !PROVIDER_ID_PATTERN.test(id.trim().toLowerCase())) {
            return res.status(400).json({ error: `El ID de proveedor “${id}” no es válido.` });
          }
        }
        providerIds = [...new Set(req.body.providerIds.map((id) => id.trim().toLowerCase()))];
      } else {
        providerIds = null;
      }
    }
    if (hasAccessLevel && req.body.allowExternalProviders === false) providerIds = null;
    const key = await store.setKeyExternalAccess(req.params.id, hasAccessLevel ? req.body.allowExternalProviders : undefined, providerIds);
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
    const hasBraveSearchApiKey = Boolean(settings.braveSearchApiKey ?? config.braveSearchApiKey);
    const externalProviders = Array.isArray(settings.externalProviders) ? settings.externalProviders : [];
    res.json({
      upstreamBaseUrl: settings.upstreamBaseUrl || config.upstreamBaseUrl,
      hasUpstreamApiKey,
      gatewayPort: config.gatewayPort,
      adminPort: config.adminPort,
      publicGatewayUrl: settings.publicGatewayUrl || config.publicGatewayUrl,
      braveSearchEndpoint: settings.braveSearchEndpoint || config.braveSearchEndpoint || DEFAULT_BRAVE_SEARCH_ENDPOINT,
      hasBraveSearchApiKey,
      externalProviders: publicExternalProviders(externalProviders),
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
    if ('braveSearchEndpoint' in req.body) {
      try {
        patch.braveSearchEndpoint = normalizeBraveEndpoint(req.body.braveSearchEndpoint);
      } catch (error) {
        return res.status(400).json({ error: error.message || 'La URL de Brave no es válida.' });
      }
    }
    if (typeof req.body.braveSearchApiKey === 'string' && req.body.braveSearchApiKey.length) patch.braveSearchApiKey = req.body.braveSearchApiKey.trim();
    if (req.body.clearBraveSearchApiKey === true) patch.braveSearchApiKey = '';
    if ('externalProviders' in req.body) {
      try {
        const previous = Array.isArray(store.getSettings().externalProviders) ? store.getSettings().externalProviders : [];
        patch.externalProviders = sanitizeExternalProviders(req.body.externalProviders, previous);
      } catch (error) {
        return res.status(400).json({ error: error.message || 'La configuración de proveedores externos no es válida.' });
      }
    }
    await store.updateSettings(patch);
    res.json({ updated: true });
  });

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

  app.post('/admin/api/external-providers/test', auth, async (req, res) => {
    const storedProviders = Array.isArray(store.getSettings().externalProviders) ? store.getSettings().externalProviders : [];
    const savedId = typeof req.body?.originalId === 'string' ? req.body.originalId : req.body?.id;
    const saved = storedProviders.find((provider) => provider.id === savedId);
    let provider;
    try {
      provider = {
        id: typeof req.body?.id === 'string' ? req.body.id.trim().toLowerCase() : '',
        name: typeof req.body?.name === 'string' ? req.body.name.trim() : '',
        baseUrl: normalizeProviderBaseUrl(req.body?.baseUrl),
        apiKey: typeof req.body?.apiKey === 'string' && req.body.apiKey.trim() ? req.body.apiKey.trim() : saved?.apiKey || ''
      };
      if (!provider.id || !provider.name) throw new Error('Completa el ID y el nombre del proveedor.');
    } catch (error) {
      return res.status(400).json({ error: error.message || 'El proveedor no es válido.' });
    }
    const startedAt = Date.now();
    try {
      const models = await fetchProviderModels(provider);
      return res.json({ online: true, latencyMs: Date.now() - startedAt, models: models.map((model) => ({ id: model.id, name: model.name || model.id })) });
    } catch (error) {
      return res.status(502).json({ online: false, latencyMs: Date.now() - startedAt, error: `No se pudieron consultar los modelos (${error.message}).` });
    }
  });

  // This endpoint is deliberately server-side: the dashboard never connects
  // directly to a configured model host or exposes its access token in logs.
  app.post('/admin/api/opencode/discover-models', auth, async (req, res) => {
    let baseUrl;
    try {
      baseUrl = normalizeOpenCodeBaseUrl(req.body?.baseUrl);
    } catch (error) {
      return res.status(400).json({ error: error.message || 'La URL del servidor no es válida.' });
    }
    const apiKey = typeof req.body?.apiKey === 'string' ? req.body.apiKey.trim() : '';
    if (apiKey.length > 1000) return res.status(400).json({ error: 'El token de acceso es demasiado largo.' });
    const startedAt = Date.now();
    try {
      const response = await fetch(`${baseUrl}/models`, {
        headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
        redirect: 'error',
        signal: AbortSignal.timeout(8000)
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        return res.status(502).json({
          online: false,
          status: response.status,
          latencyMs: Date.now() - startedAt,
          error: `El servidor rechazó la consulta de modelos (HTTP ${response.status}).`
        });
      }
      return res.json({
        online: true,
        status: response.status,
        latencyMs: Date.now() - startedAt,
        models: extractOpenAiModels(payload)
      });
    } catch {
      return res.status(502).json({
        online: false,
        latencyMs: Date.now() - startedAt,
        error: 'No se pudo conectar con el servidor OpenAI-compatible.'
      });
    }
  });

  // Referencia declarada por el operador: modalidades que anuncia cada modelo
  // en GET /v1/models (input_modalities / output_modalities). Se guarda como
  // archivo en el directorio de datos para que el gateway la lea en caliente.
  app.get('/admin/api/model-capabilities', auth, async (_req, res) => {
    try {
      const capabilities = await loadModelCapabilities(config.dataDir);
      res.json({ file: CAPABILITIES_FILENAME, dataDir: config.dataDir, count: Object.keys(capabilities).length, capabilities });
    } catch {
      res.status(500).json({ error: 'No se pudo leer el mapa de capacidades de modelos.' });
    }
  });

  app.put('/admin/api/model-capabilities', auth, async (req, res) => {
    let capabilities;
    try {
      capabilities = sanitizeModelCapabilities(req.body?.capabilities);
    } catch (error) {
      return res.status(400).json({ error: error.message || 'El mapa de capacidades de modelos no es válido.' });
    }
    try {
      await fs.mkdir(config.dataDir, { recursive: true });
      await fs.writeFile(path.join(config.dataDir, CAPABILITIES_FILENAME), `${JSON.stringify(capabilities, null, 2)}\n`, 'utf8');
      res.json({ updated: true, count: Object.keys(capabilities).length });
    } catch {
      res.status(500).json({ error: 'No se pudo guardar el mapa de capacidades de modelos.' });
    }
  });

  app.use('/admin/api', (_req, res) => res.status(404).json({ error: 'Ruta administrativa no encontrada.' }));
  app.get('*', (_req, res) => {
    res.set('cache-control', 'no-store');
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  app.use(jsonBodyErrorHandler);
  app.use((error, _req, res, _next) => {
    console.error(error);
    res.status(500).json({ error: 'Error interno del panel.' });
  });

  return app;
}
