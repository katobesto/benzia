import crypto from 'node:crypto';

import cors from 'cors';
import express from 'express';

import { extractAccessToken, PAUSED_TOKEN_MESSAGE } from './access-auth.js';
import { extractOutputText, extractUpstreamTelemetry, extractUsage } from './usage.js';

const INFERENCE_PATHS = new Set(['/v1/chat/completions', '/v1/completions', '/v1/responses', '/v1/embeddings']);
const DASHBOARD_PATHS = new Set(['/dashboard', '/keys', '/activity', '/settings', '/styles.css', '/app.js', '/favicon.ico']);

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

function sendPausedInference(res, path, body) {
  const message = PAUSED_TOKEN_MESSAGE;
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

export function createGatewayApp({ config, store, adminApp, chatApp, liveActivity }) {
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
    const accessKey = store.findKeyByToken(token, { includeInactive: true });
    if (!accessKey || accessKey.revokedAt) {
      return res.status(401).json(safeError(401, 'Clave de acceso ausente, revocada o no válida.', 'invalid_api_key'));
    }

    const path = req.path;
    const body = req.body && Object.keys(req.body).length ? structuredClone(req.body) : undefined;
    const isStream = Boolean(body?.stream);
    const isInference = req.method === 'POST' && INFERENCE_PATHS.has(path);
    if (accessKey.pausedAt && isInference) return sendPausedInference(res, path, body);
    if (accessKey.pausedAt && !path.startsWith('/v1/models')) {
      return res.status(403).json(safeError(403, PAUSED_TOKEN_MESSAGE, 'access_disabled'));
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
        ? 'Proveedor IA Local no respondió dentro del tiempo configurado.'
        : `No se pudo conectar con Proveedor IA Local: ${error.message}`;
      await store.recordMetric({
        id: requestId, at: new Date().toISOString(), keyId: accessKey.id, path,
        model: body?.model || null, status, latencyMs: Date.now() - startedAt,
        inputTokens: 0, outputTokens: 0, usageSource: 'unavailable',
        lmCachedInputTokens: null, lmCacheSource: 'unavailable',
        tokensPerSecond: null, throughputSource: 'unavailable',
        telemetryVersion: 2,
        generationDurationMs: null, timeToFirstTokenMs: null,
        stream: isStream
      });
      return res.status(status).json(safeError(status, message, timedOut ? 'upstream_timeout' : 'upstream_unavailable'));
    }

    clearTimeout(timeout);
    const responseHeaders = pickResponseHeaders(upstream.headers);
    res.status(upstream.status);
    res.set({ ...responseHeaders, 'x-lm-gateway-request-id': requestId });

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
        ...usage, ...telemetry, stream: true
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
    res.send(responseBuffer);
    await store.recordMetric({
      id: requestId, at: new Date().toISOString(), keyId: accessKey.id, path,
      model: body?.model || null, status: upstream.status, latencyMs: Date.now() - startedAt,
      ...usage, ...telemetry, stream: false
    });
  });

  app.use((error, _req, res, _next) => {
    if (error instanceof SyntaxError) return res.status(400).json(safeError(400, 'El cuerpo JSON no es válido.', 'invalid_json'));
    console.error(error);
    return res.status(500).json(safeError(500, 'Error interno del gateway.'));
  });

  return app;
}
