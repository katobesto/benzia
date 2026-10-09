import crypto from 'node:crypto';

import cors from 'cors';
import express from 'express';

import { extractAccessToken, PAUSED_TOKEN_MESSAGE } from './access-auth.js';
import { jsonBodyErrorHandler } from './http-errors.js';
import { loadModelCapabilities, annotateModel } from './model-capabilities.js';
import { fetchProviderModels, routeForModel } from './providers.js';
import { normalizeCodexModels } from './codex-provider.js';
import { extractOutputText, extractUpstreamTelemetry, extractUsage } from './usage.js';
import { RateLimiter } from './rate-limit.js';

const INFERENCE_PATHS = new Set(['/v1/chat/completions', '/v1/completions', '/v1/responses', '/v1/embeddings']);
const DASHBOARD_PATHS = new Set(['/dashboard', '/keys', '/activity', '/security', '/settings', '/utilities', '/server', '/styles.css', '/app.js', '/api-client.js', '/favicon.ico']);
// Listing models is part of the interactive chat startup. External providers
// must never turn an unavailable host into an eight-second UI stall.
const EXTERNAL_MODELS_TIMEOUT_MS = 750;

const safeError = (status, message, type = 'gateway_error') => ({
  error: { message, type, code: type, param: null }
});

function pausedResponseObject(body, message, { completed = true } = {}) {
  const responseId = `resp_disabled_${crypto.randomUUID().replaceAll('-', '')}`;
  const itemId = `msg_disabled_${crypto.randomUUID().replaceAll('-', '')}`;
  const content = { type: 'output_text', text: message, annotations: [] };
  return {
    id: responseId,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: completed ? 'completed' : 'in_progress',
    model: body?.model || 'benzIA',
    output: completed ? [{ id: itemId, type: 'message', status: 'completed', role: 'assistant', content: [content] }] : [],
    usage: completed ? {
      input_tokens: 0,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 0,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 0
    } : null,
    metadata: { benzIA_access: 'paused' }
  };
}

function sendPausedInference(res, path, body, message = PAUSED_TOKEN_MESSAGE) {
  const stream = Boolean(body?.stream);
  const id = `disabled_${crypto.randomUUID().replaceAll('-', '')}`;
  const created = Math.floor(Date.now() / 1000);
  const model = body?.model || 'benzIA';

  if (path === '/v1/responses') {
    const completed = pausedResponseObject(body, message);
    if (!stream) return res.status(200).json(completed);
    const started = { ...completed, status: 'in_progress', output: [], usage: null };
    const item = completed.output[0];
    const part = item.content[0];
    const events = [
      { type: 'response.created', sequence_number: 0, response: started },
      { type: 'response.output_item.added', sequence_number: 1, output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
      { type: 'response.content_part.added', sequence_number: 2, item_id: item.id, output_index: 0, content_index: 0, part: { ...part, text: '' } },
      { type: 'response.output_text.delta', sequence_number: 3, item_id: item.id, output_index: 0, content_index: 0, delta: message, logprobs: [] },
      { type: 'response.output_text.done', sequence_number: 4, item_id: item.id, output_index: 0, content_index: 0, text: message, logprobs: [] },
      { type: 'response.content_part.done', sequence_number: 5, item_id: item.id, output_index: 0, content_index: 0, part },
      { type: 'response.output_item.done', sequence_number: 6, output_index: 0, item },
      { type: 'response.completed', sequence_number: 7, response: completed }
    ];
    res.status(200).set({ 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    events.forEach((event) => res.write(`data: ${JSON.stringify(event)}\n\n`));
    return res.end();
  }

  if (path === '/v1/chat/completions') {
    if (!stream) {
      return res.status(200).json({
        id: `chatcmpl-${id}`, object: 'chat.completion', created, model,
        choices: [{ index: 0, message: { role: 'assistant', content: message }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
      });
    }
    const chunks = [
      { id: `chatcmpl-${id}`, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { role: 'assistant', content: message }, finish_reason: null }] },
      { id: `chatcmpl-${id}`, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
    ];
    res.status(200).set({ 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    chunks.forEach((chunk) => res.write(`data: ${JSON.stringify(chunk)}\n\n`));
    return res.end('data: [DONE]\n\n');
  }

  if (path === '/v1/completions') {
    return res.status(200).json({
      id: `cmpl-${id}`, object: 'text_completion', created, model,
      choices: [{ index: 0, text: message, finish_reason: 'stop' }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    });
  }

  return res.status(403).json(safeError(403, message, 'access_disabled'));
}

function pickResponseHeaders(headers) {
  const result = {};
  for (const name of ['content-type', 'content-length', 'cache-control', 'x-request-id']) {
    const value = headers.get(name);
    if (value) result[name] = value;
  }
  return result;
}

function writeWithBackpressure(res, chunk) {
  if (res.write(chunk)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      res.off('drain', onDrain);
      res.off('close', onClose);
      res.off('error', onError);
    };
    const onDrain = () => { cleanup(); resolve(); };
    const onClose = () => { cleanup(); reject(new Error('El cliente cerró la conexión.')); };
    const onError = (error) => { cleanup(); reject(error); };
    res.once('drain', onDrain);
    res.once('close', onClose);
    res.once('error', onError);
  });
}

async function recordMetricSafely(store, metric) {
  try {
    await store.recordMetric(metric);
  } catch (error) {
    console.error(`No se pudo guardar la métrica ${metric.id}:`, error);
  }
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

export function createGatewayApp({ config, store, adminApp, chatApp, statusApp, liveActivity, rateLimiter: providedRateLimiter }) {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustCloudflareProxy) app.set('trust proxy', 1);
  const rateLimiter = providedRateLimiter || new RateLimiter({ limit: config.rateLimitAuthPerMinute || 20 });
  const logLimit = (event) => {
    console.warn(`[seguridad] rate limit activado ${JSON.stringify(event)}`);
    try { store.recordSecurityEvent?.(event); } catch (error) { console.error('No se pudo guardar el evento de seguridad:', error); }
  };
  app.use(cors({ origin: true, credentials: false }));
  app.use((req, _res, next) => {
    req.rateLimitAddress = config.trustCloudflareProxy
      ? (req.get('cf-connecting-ip') || req.ip || req.socket?.remoteAddress || 'unknown')
      : (req.socket?.remoteAddress || 'unknown');
    next();
  });

  app.get('/', (_req, res) => res.redirect(302, '/chat'));
  if (chatApp) app.use('/chat', (req, _res, next) => { req.rateLimiter = rateLimiter; req.securityLog = logLimit; next(); }, chatApp);
  if (statusApp) app.use('/status', statusApp);

  // Publica la carcasa del panel bajo el mismo hostname del gateway. Los datos
  // y las operaciones de /admin/api siguen protegidos dentro de adminApp.
  app.use((req, res, next) => {
    const isAdminApi = req.path === '/admin/api' || req.path.startsWith('/admin/api/');
    const isServerProxy = req.path === '/server' || req.path.startsWith('/server/');
    if (adminApp && (DASHBOARD_PATHS.has(req.path) || isAdminApi || isServerProxy)) {
      return adminApp.handle(req, res, next);
    }
    return next();
  });

  app.use(express.json({ limit: '20mb' }));

  app.get('/health', async (_req, res) => {
    const settings = effectiveSettings();
    try {
      const models = await fetchProviderModels(
        { baseUrl: settings.upstreamBaseUrl, apiKey: settings.upstreamApiKey },
        { timeoutMs: Math.min(config.requestTimeoutMs, 5000), cache: false }
      );
      return res.json({ status: 'ok', service: 'benzIA', upstream: settings.upstreamBaseUrl, models: models.length });
    } catch (error) {
      return res.status(503).json({
        status: 'degraded', service: 'benzIA', upstream: settings.upstreamBaseUrl,
        error: `El proveedor local no está disponible: ${error.message}`
      });
    }
  });

  const effectiveSettings = () => {
    const stored = store.getSettings();
    return {
      upstreamBaseUrl: (stored.upstreamBaseUrl || config.upstreamBaseUrl).replace(/\/+$/, ''),
      upstreamApiKey: stored.upstreamApiKey ?? config.upstreamApiKey,
      externalProviders: Array.isArray(stored.externalProviders) ? stored.externalProviders : [],
      codexOpenAI: stored.codexOpenAI || { connected: false, selectedModel: '', models: [] }
    };
  };

  app.use(async (req, res) => {
    const startedAt = Date.now();
    const requestId = crypto.randomUUID();
    const token = extractAccessToken(req);
    const accessKey = store.findKeyByToken(token, { includeInactive: true });
    if (!accessKey || accessKey.revokedAt) {
      const ip = req.rateLimitAddress || 'unknown';
      const result = rateLimiter.consume(`auth:${ip}`, {
        type: 'auth_rate_limit', route: req.path, identity: null,
        addressFingerprint: rateLimiter.addressFingerprint(req)
      }, config.rateLimitAuthPerMinute || 20, false);
      if (!result.allowed) {
        const event = { type: 'auth_rate_limit', route: req.path, identity: null, addressFingerprint: rateLimiter.addressFingerprint(req), retryAfterSeconds: result.retryAfterSeconds };
        if (rateLimiter.shouldLog(event)) logLimit(event);
        res.set('Retry-After', String(result.retryAfterSeconds));
        return res.status(429).json(safeError(429, 'Demasiados intentos de autenticación. Espera antes de volver a intentarlo.', 'rate_limited'));
      }
      return res.status(401).json(safeError(401, 'Clave de acceso ausente, revocada o no válida.', 'invalid_api_key'));
    }

    const inferred = req.method === 'POST' && INFERENCE_PATHS.has(req.path);
    const ip = req.rateLimitAddress || 'unknown';
    const limit = inferred ? (config.rateLimitInferencePerMinute || 20) : (config.rateLimitKeyPerMinute || 120);
    const keyResult = rateLimiter.consume(`key:${accessKey.id}:${inferred ? 'inference' : 'general'}`, {
      type: inferred ? 'inference_rate_limit' : 'key_rate_limit', route: req.path,
      identity: accessKey.name, addressFingerprint: rateLimiter.addressFingerprint(req)
    }, limit, false);
    if (!keyResult.allowed) {
      const event = { type: inferred ? 'inference_rate_limit' : 'key_rate_limit', route: req.path, identity: accessKey.name, addressFingerprint: rateLimiter.addressFingerprint(req), retryAfterSeconds: keyResult.retryAfterSeconds };
      if (rateLimiter.shouldLog(event)) logLimit(event);
      res.set('Retry-After', String(keyResult.retryAfterSeconds));
      return res.status(429).json(safeError(429, 'Has superado el ritmo máximo de solicitudes. Espera antes de volver a intentarlo.', 'rate_limited'));
    }
    const path = req.path;
    if (req.method === 'GET' && path === '/v1/user_stats') {
      const stats = store.getKeyStats(accessKey.id) || {};
      return res.json({ object: 'user_stats', ...stats, tokens_consumed: stats.consumedTokens, tokens_available: stats.availableTokens, percentage_used: stats.usagePercent, uncached_input_tokens: stats.uncachedInputTokens, tokens_saved_by_cache: stats.cachedTokens, cache_tokens_saved: stats.cachedTokens, cache_percentage: stats.cachePercent, percentage_cache: stats.cachePercent });
    }
    const body = req.body && Object.keys(req.body).length ? structuredClone(req.body) : undefined;
    const isStream = Boolean(body?.stream);
    const isInference = req.method === 'POST' && INFERENCE_PATHS.has(path);
    if (accessKey.pausedAt && isInference) return sendPausedInference(res, path, body, accessKey.pausedMessage || PAUSED_TOKEN_MESSAGE);
    if (accessKey.pausedAt && !path.startsWith('/v1/models')) {
      return res.status(403).json(safeError(403, accessKey.pausedMessage || PAUSED_TOKEN_MESSAGE, 'access_disabled'));
    }
    const normalizedModelId = String(body?.model || '').replace(/[._\s-]/g, '');
    const supportsQwen38ReasoningEffort = /qwen38.*27b|qwen.*27b.*38|qwen38.*flashnext|qwen.*flash.*next.*38/i.test(normalizedModelId);
    if (isInference && supportsQwen38ReasoningEffort && body?.reasoning_effort !== undefined && !['low', 'medium', 'xhigh'].includes(body.reasoning_effort)) {
      const error = safeError(400, 'reasoning_effort para Qwen 3.8 debe ser low, medium o xhigh.', 'invalid_parameter');
      error.error.param = 'reasoning_effort';
      return res.status(400).json(error);
    }
    if (isInference && accessKey.tokenLimit != null) {
      const remaining = Math.max(0, Number(accessKey.tokenLimit) - Number(accessKey.consumedTokens || 0));
      if (!remaining) return res.status(429).json(safeError(429, 'Has agotado los tokens disponibles para esta clave.', 'token_limit_exceeded'));
      const outputBudget = remaining;
      // Limit generated output to the remaining allowance. The final charge is
      // still based on upstream usage when available, with estimates as fallback.
      if (path === '/v1/responses') body.max_output_tokens = Math.min(Number(body.max_output_tokens) || outputBudget, outputBudget);
      else if (path !== '/v1/embeddings') body.max_tokens = Math.min(Number(body.max_tokens) || outputBudget, outputBudget);
    }
    const settings = effectiveSettings();
    if (req.method === 'GET' && path === '/v1/models') {
      const localProvider = { baseUrl: settings.upstreamBaseUrl, apiKey: settings.upstreamApiKey };
      const providers = accessKey.allowExternalProviders
        ? settings.externalProviders.filter((provider) => accessKey.externalProviderIds == null || accessKey.externalProviderIds.includes(provider.id))
        : [];
      const codexModels = accessKey.allowExternalProviders && (accessKey.externalProviderIds == null || accessKey.externalProviderIds.includes('openai'))
        ? normalizeCodexModels(settings.codexOpenAI.models || [], settings.codexOpenAI.selectedModel)
        : [];
      const results = await Promise.allSettled([
        fetchProviderModels(localProvider, { timeoutMs: Math.min(config.requestTimeoutMs, 8000) }),
        ...providers.map((provider) => fetchProviderModels(provider, { timeoutMs: Math.min(config.requestTimeoutMs, EXTERNAL_MODELS_TIMEOUT_MS) }))
      ]);
      const hasAnyModelsResponse = results.some((result) => result.status === 'fulfilled');
      if (!hasAnyModelsResponse && !codexModels.length) return res.status(502).json(safeError(502, `No se pudo consultar el proveedor local: ${results[0].reason?.message || 'sin conexión'}.`, 'upstream_unavailable'));
      const localModels = results[0].status === 'fulfilled' ? results[0].value : [];
      const externalModels = providers.flatMap((provider, index) => {
        const result = results[index + 1];
        if (result.status !== 'fulfilled') return [];
        return result.value.map((model) => ({ ...model, id: `${provider.id}/${model.id}`, owned_by: provider.name, benzIA_provider: { id: provider.id, name: provider.name, external: true } }));
      });
      const failed = [...(results[0].status === 'rejected' ? ['local'] : []), ...providers.filter((_provider, index) => results[index + 1].status === 'rejected').map((provider) => provider.id)];
      if (failed.length) res.set('x-benzia-provider-errors', failed.join(','));
      const capabilities = await loadModelCapabilities(config.dataDir);
      return res.json({ object: 'list', data: [...localModels, ...codexModels, ...externalModels].map((model) => annotateModel(model, capabilities)) });
    }

    const codexConfig = settings.codexOpenAI;
    const codexRoute = typeof body?.model === 'string' && body.model.startsWith('openai/')
      ? normalizeCodexModels(codexConfig.models || [], codexConfig.selectedModel).find((model) => model.id === body.model)
      : null;
    if (typeof body?.model === 'string' && body.model.startsWith('openai/') && !codexRoute) return res.status(404).json(safeError(404, 'El modelo OpenAI Codex solicitado no está publicado.', 'model_not_found'));
    if (codexRoute && path !== '/v1/chat/completions') return res.status(400).json(safeError(400, 'OpenAI Codex en benzIA admite /v1/chat/completions; el app-server no ofrece embeddings ni el formato de Responses API a través de este adaptador.', 'unsupported_endpoint'));
    if (codexRoute && !accessKey.allowExternalProviders) return res.status(403).json(safeError(403, 'Este token sólo puede utilizar el proveedor local.', 'external_provider_forbidden'));
    if (codexRoute && accessKey.externalProviderIds && !accessKey.externalProviderIds.includes('openai')) return res.status(403).json(safeError(403, 'Este token no tiene acceso a OpenAI Codex.', 'external_provider_forbidden'));

    const externalRoute = routeForModel(body?.model, settings.externalProviders);
    if (externalRoute && !accessKey.allowExternalProviders) {
      return res.status(403).json(safeError(403, 'Este token sólo puede utilizar el proveedor local.', 'external_provider_forbidden'));
    }
    if (externalRoute && accessKey.externalProviderIds && !accessKey.externalProviderIds.includes(externalRoute.provider.id)) {
      return res.status(403).json(safeError(403, 'Este token no tiene acceso a ese proveedor externo.', 'external_provider_forbidden'));
    }
    const selectedProvider = codexRoute ? { id: 'openai', name: 'OpenAI Codex', baseUrl: 'codex://app-server', apiKey: '' } : externalRoute?.provider || {
      id: 'local', name: 'Proveedor IA Local', baseUrl: settings.upstreamBaseUrl, apiKey: settings.upstreamApiKey
    };
    const upstreamUrl = codexRoute ? '' : `${selectedProvider.baseUrl}${req.originalUrl}`;
    const upstreamBody = body ? structuredClone(body) : undefined;
    if (externalRoute && upstreamBody) upstreamBody.model = externalRoute.upstreamModel;
    if (upstreamBody?.stream && path === '/v1/chat/completions') {
      upstreamBody.stream_options = { ...upstreamBody.stream_options, include_usage: true };
    }
    const controller = new AbortController();
    let timedOut = false;
    let clientDisconnected = false;
    // REQUEST_TIMEOUT_MS limits the wait for upstream response headers only.
    // Thinking and other generation phases can be quiet for a long time.
    let timeout;
    const startUpstreamTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(() => {
        timedOut = true;
        controller.abort(new Error('Upstream timeout'));
      }, config.requestTimeoutMs);
    };
    const clearUpstreamTimeout = () => clearTimeout(timeout);
    startUpstreamTimeout();
    const onRequestAborted = () => {
      clientDisconnected = true;
      controller.abort(new Error('El cliente canceló la petición.'));
    };
    const onResponseClosed = () => {
      // Node emits `close` after a normal `end()` too; only treat it as a
      // cancellation when the response did not finish writing.
      if (res.writableEnded || res.writableFinished) return;
      clientDisconnected = true;
      controller.abort(new Error('El cliente cerró la conexión.'));
    };
    req.once('aborted', onRequestAborted);
    res.once('close', onResponseClosed);
    const cleanupRequest = () => {
      clearUpstreamTimeout();
      releaseInference();
      req.off('aborted', onRequestAborted);
      res.off('close', onResponseClosed);
    };
    let admissionRejected = false;
    const failureStatus = () => admissionRejected ? 429 : timedOut ? 504 : clientDisconnected ? 499 : 502;
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
    let releaseInference = () => {};
    try {
      if (isInference && config.inferenceAdmission) {
        clearUpstreamTimeout();
        releaseInference = await config.inferenceAdmission.acquire(selectedProvider.baseUrl, controller.signal);
        startUpstreamTimeout();
      }
      if (codexRoute) {
        const completionId = `chatcmpl-${crypto.randomUUID().replaceAll('-', '')}`;
        const created = Math.floor(Date.now() / 1000);
        let streamedText = '';
        const emitDelta = async (delta) => {
          streamedText += delta;
          if (trackLive) liveActivity?.update(requestId, streamedText, delta);
          const chunk = { id: completionId, object: 'chat.completion.chunk', created, model: body.model, choices: [{ index: 0, delta: { content: delta }, finish_reason: null }] };
          await writeWithBackpressure(res, `data: ${JSON.stringify(chunk)}${String.fromCharCode(10, 10)}`);
        };
        if (isStream) {
          res.status(200).set({ 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no', 'x-lm-gateway-request-id': requestId });
          res.flushHeaders?.();
        }
        const result = await config.codexAppServer.generate(upstreamBody, { signal: controller.signal, ...(isStream ? { onDelta: emitDelta } : {}) });
        clearUpstreamTimeout();
        const content = await result.completion;
        cleanupRequest();
        const completedAt = Date.now();
        const outputTokens = Math.max(0, Math.ceil(content.length / 4));
        const usage = { inputTokens: 0, outputTokens, usageSource: 'estimated', lmCachedInputTokens: null, lmCacheSource: 'unavailable' };
        const telemetry = extractUpstreamTelemetry({}, { outputTokens, startedAt, completedAt });
        await recordMetricSafely(store, { id: requestId, at: new Date().toISOString(), keyId: accessKey.id, path, model: body?.model || null, provider: 'openai', status: 200, latencyMs: completedAt - startedAt, ...usage, ...telemetry, stream: isStream });
        if (trackLive) liveActivity?.finish(requestId);
        if (isStream) {
          // Headers were flushed before starting Codex so deltas reach clients immediately.
          const chunks = streamedText ? [] : (content.match(/.{1,40}/gs) || ['']);
          for (const chunk of chunks) await writeWithBackpressure(res, `data: ${JSON.stringify({ id: completionId, object: 'chat.completion.chunk', created: Math.floor(completedAt / 1000), model: body.model, choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }] })}\n\n`);
          await writeWithBackpressure(res, `data: ${JSON.stringify({ id: completionId, object: 'chat.completion.chunk', created: Math.floor(completedAt / 1000), model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
          return res.end();
        }
        return res.status(200).json({ id: completionId, object: 'chat.completion', created: Math.floor(completedAt / 1000), model: body.model, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 0, completion_tokens: outputTokens, total_tokens: outputTokens } });
      }
      const requestUpstream = (requestBody) => fetch(upstreamUrl, {
        method: req.method,
        headers: {
          accept: req.get('accept') || '*/*',
          ...(requestBody ? { 'content-type': 'application/json' } : {}),
          ...(selectedProvider.apiKey ? { authorization: `Bearer ${selectedProvider.apiKey}` } : {}),
          // Algunos servidores OpenAI-compatibles responden 404 a /responses
          // sin leer el cuerpo. El cliente reintenta entonces con
          // /chat/completions; cerrar este socket evita que ese JSON pendiente
          // sea interpretado por el upstream como el método del siguiente POST.
          ...(path === '/v1/responses' ? { connection: 'close' } : {})
        },
        body: requestBody ? JSON.stringify(requestBody) : undefined,
        signal: controller.signal
      });
      upstream = await requestUpstream(upstreamBody);
      clearUpstreamTimeout();
      // `stream_options.include_usage` es OpenAI-compatible, pero no todos los
      // servidores que implementan chat/completions lo reconocen todavía.
      // Reintentar sin esa extensión conserva la compatibilidad; en ese caso
      // benzIA estima el uso si el upstream no lo publica de otra forma.
      if (upstream.status === 400 && path === '/v1/chat/completions' && upstreamBody?.stream_options?.include_usage) {
        await upstream.body?.cancel();
        const compatibleBody = structuredClone(upstreamBody);
        delete compatibleBody.stream_options;
        timedOut = false;
        // Re-establish a fresh connection timeout for the compatibility retry.
        startUpstreamTimeout();
        upstream = await requestUpstream(compatibleBody);
        clearUpstreamTimeout();
      }
      // Non-streaming responses still need a bounded body read. A streaming
      // response, however, remains open across arbitrary provider/network
      // pauses until it finishes or the client disconnects.
      if (!isStream) startUpstreamTimeout();
    } catch (error) {
      if (error.status === 429) { admissionRejected = true; res.set('Retry-After', '5'); }
      cleanupRequest();
      if (trackLive) liveActivity?.finish(requestId);
      const status = failureStatus();
      const message = timedOut
        ? `${selectedProvider.name} no respondió dentro del tiempo configurado.`
        : clientDisconnected
          ? 'El cliente cerró la conexión antes de recibir la respuesta.'
        : `No se pudo conectar con ${selectedProvider.name}: ${error.message}`;
      await recordMetricSafely(store, {
        id: requestId, at: new Date().toISOString(), keyId: accessKey.id, path,
        model: body?.model || null, provider: selectedProvider.id, status, latencyMs: Date.now() - startedAt,
        inputTokens: 0, outputTokens: 0, usageSource: 'unavailable',
        lmCachedInputTokens: null, lmCacheSource: 'unavailable',
        tokensPerSecond: null, throughputSource: 'unavailable',
        telemetryVersion: 2,
        generationDurationMs: null, timeToFirstTokenMs: null,
        stream: isStream
      });
      if (clientDisconnected) return;
      if (res.headersSent) {
        if (isStream && !res.writableEnded) {
          await writeWithBackpressure(res, `data: ${JSON.stringify(safeError(status, message, timedOut ? 'upstream_timeout' : 'upstream_unavailable'))}${String.fromCharCode(10, 10)}`).catch(() => {});
          if (!res.writableEnded) res.end();
        }
        return;
      }
      return res.status(status).json(safeError(status, message, timedOut ? 'upstream_timeout' : 'upstream_unavailable'));
    }

    const responseHeaders = pickResponseHeaders(upstream.headers);
    res.status(upstream.status);
    res.set({ ...responseHeaders, 'x-lm-gateway-request-id': requestId });

    if (isStream && upstream.body) {
      res.removeHeader('content-length');
      res.set({ 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' });
      res.flushHeaders?.();
      const reader = upstream.body.getReader();
      const cancelUpstream = () => { void reader.cancel().catch(() => {}); };
      controller.signal.addEventListener('abort', cancelUpstream, { once: true });
      if (controller.signal.aborted) cancelUpstream();
      const decoder = new TextDecoder();
      let sseBuffer = '';
      let lastPayload = {};
      let outputText = '';
      let firstTokenAt = null;
      let streamError = null;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          await writeWithBackpressure(res, Buffer.from(value));
          sseBuffer += decoder.decode(value, { stream: true });
          sseBuffer = parseSseBuffer(sseBuffer, (payload) => {
            lastPayload = payload;
            const fragment = extractOutputText(payload);
            if (fragment) {
              firstTokenAt ||= Date.now();
              outputText += fragment;
              liveActivity?.update(requestId, outputText, fragment);
            }
          });
        }
        parseSseBuffer(`${sseBuffer}${decoder.decode()}\n`, (payload) => {
          lastPayload = payload;
          const fragment = extractOutputText(payload);
          if (fragment) {
            firstTokenAt ||= Date.now();
            outputText += fragment;
            liveActivity?.update(requestId, outputText, fragment);
          }
        });
        res.end();
      } catch (error) {
        streamError = error;
        if (!clientDisconnected && !res.writableEnded) {
          const status = failureStatus();
          const message = timedOut
            ? `${selectedProvider.name} superó el tiempo máximo durante la respuesta.`
            : `La respuesta de ${selectedProvider.name} se interrumpió antes de completarse.`;
          try {
            await writeWithBackpressure(res, `data: ${JSON.stringify(safeError(status, message, timedOut ? 'upstream_timeout' : 'upstream_interrupted'))}\n\n`);
          } catch { /* El cliente también puede haberse desconectado. */ }
          if (!res.writableEnded) res.end();
        }
      }
      cleanupRequest();
      controller.signal.removeEventListener('abort', cancelUpstream);
      const completedAt = Date.now();
      const usage = extractUsage(lastPayload, body, outputText);
      const telemetry = extractUpstreamTelemetry(lastPayload, {
        outputTokens: usage.outputTokens,
        startedAt,
        firstTokenAt,
        completedAt
      });
      liveActivity?.finish(requestId);
      await recordMetricSafely(store, {
        id: requestId, at: new Date().toISOString(), keyId: accessKey.id, path,
        model: body?.model || null, provider: selectedProvider.id,
        status: streamError ? failureStatus() : upstream.status, latencyMs: completedAt - startedAt,
        ...usage, ...telemetry, stream: true
      });
      return;
    }

    if (trackLive) liveActivity?.finish(requestId);
    let responseBuffer;
    try {
      responseBuffer = Buffer.from(await upstream.arrayBuffer());
    } catch (error) {
      if (error.status === 429) { admissionRejected = true; res.set('Retry-After', '5'); }
      cleanupRequest();
      const status = failureStatus();
      await recordMetricSafely(store, {
        id: requestId, at: new Date().toISOString(), keyId: accessKey.id, path,
        model: body?.model || null, provider: selectedProvider.id, status, latencyMs: Date.now() - startedAt,
        inputTokens: 0, outputTokens: 0, usageSource: 'unavailable',
        lmCachedInputTokens: null, lmCacheSource: 'unavailable',
        tokensPerSecond: null, throughputSource: 'unavailable', telemetryVersion: 2,
        generationDurationMs: null, timeToFirstTokenMs: null, stream: false
      });
      if (clientDisconnected || res.headersSent) return;
      const message = timedOut
        ? `${selectedProvider.name} superó el tiempo máximo durante la respuesta.`
        : `La respuesta de ${selectedProvider.name} se interrumpió antes de completarse.`;
      return res.status(status).json(safeError(status, message, timedOut ? 'upstream_timeout' : 'upstream_interrupted'));
    }
    cleanupRequest();
    let payload = {};
    try { payload = JSON.parse(responseBuffer.toString('utf8')); } catch { /* Respuesta binaria o texto. */ }
    const usage = extractUsage(payload, body);
    const telemetry = extractUpstreamTelemetry(payload, {
      outputTokens: usage.outputTokens,
      startedAt,
      completedAt: Date.now()
    });
    res.send(responseBuffer);
    await recordMetricSafely(store, {
      id: requestId, at: new Date().toISOString(), keyId: accessKey.id, path,
      model: body?.model || null, provider: selectedProvider.id, status: upstream.status, latencyMs: Date.now() - startedAt,
      ...usage, ...telemetry, stream: false
    });
  });

  app.use(jsonBodyErrorHandler);
  app.use((error, _req, res, _next) => {
    console.error(error);
    return res.status(500).json(safeError(500, 'Error interno del gateway.'));
  });

  return app;
}
