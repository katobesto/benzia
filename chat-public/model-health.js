(function expose(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.BenziaModelHealth = api;
})(globalThis, function createModelHealthTools() {
  const DEFAULT_TIMEOUT_MS = 12_000;
  const DEFAULT_CONCURRENCY = 3;

  async function probeOne({ model, endpoint, token, fetchImpl, timeoutMs, signal }) {
    const controller = new AbortController();
    let timedOut = false;
    const abortFromCaller = () => controller.abort(signal.reason || new DOMException('Análisis cancelado.', 'AbortError'));
    if (signal?.aborted) abortFromCaller();
    else signal?.addEventListener('abort', abortFromCaller, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new DOMException('La petición superó el tiempo límite.', 'TimeoutError'));
    }, timeoutMs);

    try {
      const response = await fetchImpl(`${endpoint}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'OK' }],
          max_tokens: 1,
          temperature: 0,
          stream: false
        }),
        signal: controller.signal
      });
      const status = response.status;
      const cancelBody = () => {
        try { Promise.resolve(response.body?.cancel?.()).catch(() => {}); } catch { /* No hace falta leer respuestas de error. */ }
      };
      if (timedOut) {
        cancelBody();
        return { model, status: 'down', reason: 'timeout' };
      }
      if (status === 429) {
        cancelBody();
        return { model, status: 'unknown', reason: 'rate_limited', httpStatus: status };
      }
      if (status === 404) {
        let payload;
        try { payload = await response.json(); } catch {
          return timedOut
            ? { model, status: 'down', reason: 'timeout' }
            : { model, status: 'unknown', reason: 'http_404', httpStatus: status };
        }
        if (timedOut) return { model, status: 'down', reason: 'timeout' };
        const error = payload?.error;
        const message = String(error?.message || (typeof error === 'string' ? error : '') || payload?.message || '').toLowerCase();
        const escapedModel = model.toLowerCase().replace(/[.*+?^${}()|[\\]\\]/g, '\\$&');
        const modelSpecific = new RegExp(`\\bmodel\\b.{0,100}${escapedModel}(?:$|[^a-z0-9]).{0,100}(?:not found|does not exist|unknown|unavailable|not supported)`)
          .test(message);
        return modelSpecific
          ? { model, status: 'down', reason: 'model_not_found', httpStatus: status }
          : { model, status: 'unknown', reason: 'http_404', httpStatus: status };
      }
      if (!response.ok) {
        cancelBody();
        return { model, status: 'unknown', reason: `http_${status}`, httpStatus: status };
      }
      let payload;
      try { payload = await response.json(); } catch {
        return timedOut
          ? { model, status: 'down', reason: 'timeout' }
          : { model, status: 'unknown', reason: 'invalid_response', httpStatus: status };
      }
      if (timedOut) return { model, status: 'down', reason: 'timeout' };
      if (String(payload?.id || '').startsWith('chatcmpl-disabled_')) {
        return { model, status: 'unknown', reason: 'access_paused', httpStatus: status };
      }
      if (!Array.isArray(payload?.choices) || !payload.choices.length) {
        return { model, status: 'unknown', reason: 'invalid_response', httpStatus: status };
      }
      return { model, status: 'online', httpStatus: status };
    } catch (error) {
      if (signal?.aborted) throw signal.reason || error;
      if (timedOut) return { model, status: 'down', reason: 'timeout' };
      return { model, status: 'unknown', reason: 'network_error' };
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abortFromCaller);
    }
  }

  async function probeModels({
    models,
    endpoint,
    token,
    fetchImpl = fetch,
    concurrency = DEFAULT_CONCURRENCY,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal,
    onProgress = () => {}
  } = {}) {
    if (!Array.isArray(models) || models.some((model) => typeof model !== 'string' || !model.trim())) {
      throw new TypeError('La lista de modelos no es válida.');
    }
    if (typeof endpoint !== 'string' || !/^https?:\/\//i.test(endpoint)) {
      throw new TypeError('El endpoint de benzIA no es válido.');
    }
    if (typeof token !== 'string' || !token) throw new TypeError('Falta el token de acceso.');
    if (typeof fetchImpl !== 'function') throw new TypeError('No hay transporte HTTP disponible.');
    const safeConcurrency = Math.max(1, Math.min(5, Math.floor(Number(concurrency) || DEFAULT_CONCURRENCY)));
    const safeTimeout = Math.max(10, Math.min(60_000, Math.floor(Number(timeoutMs) || DEFAULT_TIMEOUT_MS)));
    const normalizedEndpoint = endpoint.replace(/\/+$/, '');
    const results = new Array(models.length);
    let nextIndex = 0;
    let completed = 0;

    async function worker() {
      while (!signal?.aborted) {
        const index = nextIndex++;
        if (index >= models.length) return;
        const result = await probeOne({
          model: models[index], endpoint: normalizedEndpoint, token, fetchImpl,
          timeoutMs: safeTimeout, signal
        });
        results[index] = result;
        completed += 1;
        onProgress({ completed, total: models.length, ...result });
      }
    }

    await Promise.all(Array.from({ length: Math.min(safeConcurrency, models.length) }, worker));
    if (signal?.aborted) throw signal.reason || new DOMException('Análisis cancelado.', 'AbortError');
    return results;
  }

  return { probeModels, DEFAULT_TIMEOUT_MS, DEFAULT_CONCURRENCY };
});
