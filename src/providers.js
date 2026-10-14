export const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,49}$/;

export function normalizeProviderBaseUrl(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Introduce una URL base para el proveedor.');
  const url = new URL(value.trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('La URL debe ser HTTP(S), sin credenciales ni parámetros.');
  }
  const pathname = url.pathname.replace(/\/+$/, '');
  url.pathname = pathname.endsWith('/v1') ? pathname.slice(0, -3) : pathname;
  return url.toString().replace(/\/+$/, '');
}

export function sanitizeExternalProviders(value, previous = []) {
  if (!Array.isArray(value)) throw new Error('La lista de proveedores externos no es válida.');
  if (value.length > 20) throw new Error('Se admiten hasta 20 proveedores externos.');
  const previousById = new Map(previous.map((provider) => [provider.id, provider]));
  const ids = new Set();
  return value.map((raw, index) => {
    const id = typeof raw?.id === 'string' ? raw.id.trim().toLowerCase() : '';
    const name = typeof raw?.name === 'string' ? raw.name.trim() : '';
    if (!PROVIDER_ID_PATTERN.test(id)) throw new Error(`El ID del proveedor ${index + 1} no es válido.`);
    if (ids.has(id)) throw new Error(`El ID de proveedor “${id}” está repetido.`);
    if (name.length < 2 || name.length > 80) throw new Error(`El nombre del proveedor ${index + 1} debe tener entre 2 y 80 caracteres.`);
    ids.add(id);
    const apiKeyInput = typeof raw.apiKey === 'string' ? raw.apiKey.trim() : '';
    const previousId = typeof raw.originalId === 'string' ? raw.originalId : id;
    const apiKey = apiKeyInput || (raw.keepApiKey ? previousById.get(previousId)?.apiKey || '' : '');
    if (apiKey.length > 2000) throw new Error(`El token de “${name}” es demasiado largo.`);
    return { id, name, baseUrl: normalizeProviderBaseUrl(raw.baseUrl), apiKey };
  });
}

export function publicExternalProviders(providers = []) {
  return providers.map(({ id, name, baseUrl, apiKey }) => ({ id, name, baseUrl, hasApiKey: Boolean(apiKey) }));
}

async function requestProviderModels(provider, { timeoutMs = 8000 } = {}) {
  const response = await fetch(`${provider.baseUrl}/v1/models`, {
    headers: provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {},
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return Array.isArray(payload.data) ? payload.data.filter((model) => typeof model?.id === 'string' && model.id.trim()) : [];
}

export function routeForModel(model, providers = []) {
  if (typeof model !== 'string') return null;
  const separator = model.indexOf('/');
  if (separator < 1) return null;
  const provider = providers.find((candidate) => candidate.id === model.slice(0, separator));
  if (!provider) return null;
  const upstreamModel = model.slice(separator + 1);
  return upstreamModel ? { provider, upstreamModel } : null;
}

const modelCatalogues = new Map();
const localModelLimits = new Map();
export async function fetchProviderModels(provider, options = {}) {
  if (options.cache === false) return requestProviderModels(provider, options);
  const key = JSON.stringify([provider.baseUrl, provider.apiKey || '', options.timeoutMs || 8000]);
  let entry = modelCatalogues.get(key);
  if (entry && (entry.pending || entry.expiresAt > Date.now())) return structuredClone(await (entry.pending || entry.models));
  entry = { expiresAt: 0 };
  modelCatalogues.set(key, entry);
  if (modelCatalogues.size > 100) modelCatalogues.delete(modelCatalogues.keys().next().value);
  entry.pending = requestProviderModels(provider, options).then(models => {
    entry.models = models;
    entry.expiresAt = Date.now() + 15_000;
    return models;
  }).catch(error => {
    if (modelCatalogues.get(key) === entry) modelCatalogues.delete(key);
    throw error;
  }).finally(() => { entry.pending = null; });
  return structuredClone(await entry.pending);
}

/**
 * LM Studio publica límites de contexto más completos en su API nativa que en
 * el endpoint OpenAI-compatible /v1/models. Si la API nativa no está
 * disponible, conserva intacto el catálogo compatible.
 */
async function requestLocalModelLimits(provider, timeoutMs) {
  try {
    const response = await fetch(`${provider.baseUrl}/api/v1/models`, {
      headers: provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {},
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) {
      await response.body?.cancel();
      return new Map();
    }
    const payload = await response.json().catch(() => ({}));
    const nativeModels = Array.isArray(payload.models) ? payload.models : [];
    return new Map(nativeModels.flatMap((model) => {
      const id = typeof model?.key === 'string' ? model.key : model?.id;
      if (typeof id !== 'string' || !id) return [];
      const maxContext = Number.isSafeInteger(model.max_context_length) && model.max_context_length > 0 ? model.max_context_length : null;
      const loadedContext = (Array.isArray(model.loaded_instances) ? model.loaded_instances : []).map((instance) => instance?.config?.context_length)
        .find((limit) => Number.isSafeInteger(limit) && limit > 0) || null;
      return [[id, { maxContext, loadedContext }]];
    }));
  } catch {
    return new Map();
  }
}

function fetchLocalModelLimits(provider, { timeoutMs = 750 } = {}) {
  const key = JSON.stringify([provider.baseUrl, provider.apiKey || '', timeoutMs]);
  let entry = localModelLimits.get(key);
  if (entry && (entry.pending || entry.expiresAt > Date.now())) return entry.pending || Promise.resolve(entry.limits);
  entry = { expiresAt: 0 };
  localModelLimits.set(key, entry);
  if (localModelLimits.size > 100) localModelLimits.delete(localModelLimits.keys().next().value);
  entry.pending = requestLocalModelLimits(provider, timeoutMs).then((limits) => {
    entry.limits = limits;
    // Cache unsupported/unavailable native APIs too: they must not add a
    // timeout to every catalogue refresh or to every concurrent chat login.
    entry.expiresAt = Date.now() + 15_000;
    return limits;
  }).finally(() => { entry.pending = null; });
  return entry.pending;
}

function applyLocalModelLimits(models, limitsById) {
  return models.map((model) => {
    const limits = limitsById.get(model.id);
    if (!limits) return model;
    return {
      ...model,
      ...(limits.maxContext ? { max_context_length: limits.maxContext } : {}),
      ...((limits.maxContext || limits.loadedContext) && !model.context_length ? { context_length: limits.maxContext || limits.loadedContext } : {}),
      ...(limits.loadedContext ? { loaded_context_length: limits.loadedContext } : {}),
      benzIA_model_limits_source: 'LM Studio API'
    };
  });
}

export async function enrichLocalModelsWithLimits(provider, models, options = {}) {
  if (!Array.isArray(models) || !models.length) return models;
  return applyLocalModelLimits(models, await fetchLocalModelLimits(provider, options));
}

export async function fetchLocalProviderModels(provider, { timeoutMs = 8000, limitsTimeoutMs = 750 } = {}) {
  const [models, limits] = await Promise.all([
    fetchProviderModels(provider, { timeoutMs }),
    fetchLocalModelLimits(provider, { timeoutMs: limitsTimeoutMs })
  ]);
  return applyLocalModelLimits(models, limits);
}

export function clearProviderModelsCache() {
  modelCatalogues.clear();
  localModelLimits.clear();
}
