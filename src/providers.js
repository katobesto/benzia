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

export async function fetchProviderModels(provider, { timeoutMs = 8000 } = {}) {
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
