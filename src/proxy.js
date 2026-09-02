import crypto from 'node:crypto';

import cors from 'cors';
import express from 'express';

import { extractAccessToken } from './access-auth.js';
import { extractOutputText, extractUpstreamTelemetry, extractUsage } from './usage.js';

const CACHEABLE_PATHS = new Set(['/v1/chat/completions', '/v1/completions', '/v1/responses', '/v1/embeddings']);
const DASHBOARD_PATHS = new Set(['/dashboard', '/keys', '/activity', '/settings', '/styles.css', '/app.js', '/favicon.ico']);

const safeError = (status, message, type = 'gateway_error') => ({
  error: { message, type, code: type, param: null }
});

function pickResponseHeaders(headers) {
  const result = {};
  for (const name of ['content-type', 'content-length', 'x-request-id']) {
    const value = headers.get(name);
    if (value) result[name] = value;
  }
  return result;
}

function parseSseBuffer(buffer, onPayload) {
  const lines = buffer.split(/\r?\n/);
  const remainder = lines.pop() || '';
  for (const line of lines) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    try { onPayload(JSON.parse(data)); } catch { /* Un fragmento no JSON se reenvía igualmente. */ }
  }
  return remainder;
}

export function createGatewayApp({ config, store, cache, adminApp, chatApp, liveActivity }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(cors({ origin: true, credentials: false }));

  if (chatApp) app.use('/chat', chatApp);

  // Publica la carcasa del panel bajo el mismo hostname del gateway. Los datos
  // y las operaciones de /admin/api siguen protegidos dentro de adminApp.
  app.use((req, res, next) => {
    const isAdminApi = req.path === '/admin/api' || req.path.startsWith('/admin/api/');
    if (adminApp && (DASHBOARD_PATHS.has(req.path) || isAdminApi)) {
      return adminApp.handle(req, res, next);
    }
    return next();
  });

  app.use(express.json({ limit: '20mb' }));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'benzIA', upstream: effectiveSettings().upstreamBaseUrl });
  });

  const effectiveSettings = () => {
    const stored = store.getSettings();
    return {
      upstreamBaseUrl: (stored.upstreamBaseUrl || config.upstreamBaseUrl).replace(/\/+$/, ''),
      upstreamApiKey: stored.upstreamApiKey ?? config.upstreamApiKey
    };
  };

  app.use(async (req, res) => {
    const startedAt = Date.now();
    const requestId = crypto.randomUUID();
    const token = extractAccessToken(req);
    const accessKey = store.findKeyByToken(token);
    if (!accessKey) {
      return res.status(401).json(safeError(401, 'Clave de acceso ausente, revocada o no válida.', 'invalid_api_key'));
    }

    const path = req.path;
    const body = req.body && Object.keys(req.body).length ? structuredClone(req.body) : undefined;
    const isStream = Boolean(body?.stream);
    const isInference = req.method === 'POST' && CACHEABLE_PATHS.has(path);
    const canCache = isInference && !isStream && cache.stats().maxEntries > 0 && cache.stats().ttlSeconds > 0;
    const cacheKey = canCache ? cache.keyFor(path, body) : null;
    const bypassRequested = /no-cache/i.test(req.get('cache-control') || '') || req.query.cache === 'false';
    const cacheStatus = isInference && canCache && !bypassRequested ? 'miss' : 'bypass';

    if (canCache && !bypassRequested) {
      const cached = cache.get(cacheKey);
      if (cached) {
        const latencyMs = Date.now() - startedAt;
        res.set({ ...cached.headers, 'x-lm-gateway-cache': 'HIT', 'x-lm-gateway-request-id': requestId });
        res.status(cached.status).send(Buffer.from(cached.body, 'base64'));
        await store.recordMetric({
          id: requestId,
          at: new Date().toISOString(),
          keyId: accessKey.id,
          path,
          model: body?.model || null,
          status: cached.status,
          latencyMs,
          inputTokens: cached.usage.inputTokens,
          outputTokens: cached.usage.outputTokens,
          usageSource: cached.usage.usageSource,
          lmCachedInputTokens: null,
          lmCacheSource: 'not_applicable',
          tokensPerSecond: null,
          throughputSource: 'not_applicable',
          telemetryVersion: 2,
          generationDurationMs: null,
          timeToFirstTokenMs: null,
          cacheStatus: 'hit',
          stream: false
        });
        return;
      }
    }

    const settings = effectiveSettings();
    const upstreamUrl = `${settings.upstreamBaseUrl}${req.originalUrl}`;
    const upstreamBody = body ? structuredClone(body) : undefined;
    if (upstreamBody?.stream && path === '/v1/chat/completions') {
      upstreamBody.stream_options = { ...upstreamBody.stream_options, include_usage: true };
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('Upstream timeout')), config.requestTimeoutMs);
    req.on('aborted', () => controller.abort());
    const trackLive = isInference && isStream;
    if (trackLive) {
      liveActivity?.begin({
        id: requestId,
        keyId: accessKey.id,
        keyName: accessKey.name,
        path,
        model: body?.model || null,
        startedAt
      });
    }

    let upstream;
    try {
      upstream = await fetch(upstreamUrl, {
        method: req.method,
        headers: {
          accept: req.get('accept') || '*/*',
          ...(upstreamBody ? { 'content-type': 'application/json' } : {}),
          ...(settings.upstreamApiKey ? { authorization: `Bearer ${settings.upstreamApiKey}` } : {})
        },
        body: upstreamBody ? JSON.stringify(upstreamBody) : undefined,
        signal: controller.signal
      });
    } catch (error) {
      clearTimeout(timeout);
      if (trackLive) liveActivity?.finish(requestId);
      const timedOut = controller.signal.aborted;
      const status = timedOut ? 504 : 502;
      const message = timedOut
        ? 'LM Studio no respondió dentro del tiempo configurado.'
        : `No se pudo conectar con LM Studio: ${error.message}`;
      await store.recordMetric({
        id: requestId, at: new Date().toISOString(), keyId: accessKey.id, path,
        model: body?.model || null, status, latencyMs: Date.now() - startedAt,
        inputTokens: 0, outputTokens: 0, usageSource: 'unavailable',
        lmCachedInputTokens: null, lmCacheSource: 'unavailable',
        tokensPerSecond: null, throughputSource: 'unavailable',
        telemetryVersion: 2,
        generationDurationMs: null, timeToFirstTokenMs: null,
        cacheStatus, stream: isStream
      });
      return res.status(status).json(safeError(status, message, timedOut ? 'upstream_timeout' : 'upstream_unavailable'));
    }

    clearTimeout(timeout);
    const responseHeaders = pickResponseHeaders(upstream.headers);
    res.status(upstream.status);
    res.set({ ...responseHeaders, 'x-lm-gateway-cache': cacheStatus.toUpperCase(), 'x-lm-gateway-request-id': requestId });

    if (isStream && upstream.body) {
      res.removeHeader('content-length');
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let sseBuffer = '';
      let lastPayload = {};
      let outputText = '';
      let firstTokenAt = null;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(Buffer.from(value));
          sseBuffer += decoder.decode(value, { stream: true });
          sseBuffer = parseSseBuffer(sseBuffer, (payload) => {
            lastPayload = payload;
            const fragment = extractOutputText(payload);
            if (fragment) {
              firstTokenAt ||= Date.now();
              outputText += fragment;
              liveActivity?.update(requestId, outputText);
            }
          });
        }
        parseSseBuffer(`${sseBuffer}${decoder.decode()}\n`, (payload) => {
          lastPayload = payload;
          const fragment = extractOutputText(payload);
          if (fragment) {
            firstTokenAt ||= Date.now();
            outputText += fragment;
            liveActivity?.update(requestId, outputText);
          }
        });
        res.end();
      } catch (error) {
        if (!res.writableEnded) res.end();
      }
      const completedAt = Date.now();
      const usage = extractUsage(lastPayload, body, outputText);
      const telemetry = extractUpstreamTelemetry(lastPayload, {
        outputTokens: usage.outputTokens,
        startedAt,
        firstTokenAt,
        completedAt
      });
      liveActivity?.finish(requestId);
      await store.recordMetric({
        id: requestId, at: new Date().toISOString(), keyId: accessKey.id, path,
        model: body?.model || null, status: upstream.status, latencyMs: completedAt - startedAt,
        ...usage, ...telemetry, cacheStatus, stream: true
      });
      return;
    }

    if (trackLive) liveActivity?.finish(requestId);
    const responseBuffer = Buffer.from(await upstream.arrayBuffer());
    let payload = {};
    try { payload = JSON.parse(responseBuffer.toString('utf8')); } catch { /* Respuesta binaria o texto. */ }
    const usage = extractUsage(payload, body);
    const telemetry = extractUpstreamTelemetry(payload, {
      outputTokens: usage.outputTokens,
      startedAt,
      completedAt: Date.now()
    });
    if (canCache && !bypassRequested && upstream.ok) {
      cache.set(cacheKey, {
        status: upstream.status,
        headers: responseHeaders,
        body: responseBuffer.toString('base64'),
        usage
      });
    }
    res.send(responseBuffer);
    await store.recordMetric({
      id: requestId, at: new Date().toISOString(), keyId: accessKey.id, path,
      model: body?.model || null, status: upstream.status, latencyMs: Date.now() - startedAt,
      ...usage, ...telemetry, cacheStatus, stream: false
    });
  });

  app.use((error, _req, res, _next) => {
    if (error instanceof SyntaxError) return res.status(400).json(safeError(400, 'El cuerpo JSON no es válido.', 'invalid_json'));
    console.error(error);
    return res.status(500).json(safeError(500, 'Error interno del gateway.'));
  });

  return app;
}
