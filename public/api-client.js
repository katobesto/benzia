// Nivel de acceso de una clave a los origenes de modelos. `localModelAllowed`
// es el flag nuevo: las claves antiguas no lo traen y siguen pudiendo usar el
// proveedor local, que era su comportamiento de siempre.
export function keyProviderAccessLevel(key) {
  const local = key?.localModelAllowed !== false;
  const external = Boolean(key?.allowExternalProviders);
  if (!local && external) return 'external-only';
  if (local && external) return 'both';
  return 'local-only';
}

// El combo de tres opciones: solo local, permitir externos (local + externos)
// y solo externos (el modelo local queda oculto e inaccesible para el token).
export function keyProviderAccessOptions(key) {
  const level = keyProviderAccessLevel(key);
  return `<option value="local-only" ${level === 'local-only' ? 'selected' : ''}>Solo proveedor local</option><option value="both" ${level === 'both' ? 'selected' : ''}>Permitir externos</option><option value="external-only" ${level === 'external-only' ? 'selected' : ''}>Solo externos</option>`;
}

export function keyProviderAccessMarkup(key, { className = 'key-provider-access', id = '' } = {}) {
  const attrs = `${id ? ` id="${id}"` : ''}${className ? ` class="${className}"` : ''}`;
  return `<select${attrs}>${keyProviderAccessOptions(key)}</select>`;
}

// Cada opcion se traduce a los dos booleanos que acepta la API administrativa.
export function keyProviderAccessPayload(level) {
  if (level === 'external-only') return { localModelAllowed: false, allowExternalProviders: true };
  if (level === 'both') return { localModelAllowed: true, allowExternalProviders: true };
  return { localModelAllowed: true, allowExternalProviders: false };
}

export function providerFilterOptions(settings) {
  const providers = Array.isArray(settings?.externalProviders) ? settings.externalProviders : [];
  const codex = settings?.codexOpenAI;
  if (codex?.connected && codex.selectedModel && !providers.some((provider) => provider.id === 'openai')) {
    return [...providers, { id: 'openai', name: 'OpenAI Codex', baseUrl: 'codex://app-server' }];
  }
  return providers;
}

export async function parseApiResponse(response) {
  if (response.status === 204) return null;
  const contentType = response.headers.get('content-type') || 'content-type no informado';
  const body = await response.text();
  const requestId = response.headers.get('x-request-id') || response.headers.get('cf-ray');
  const reference = requestId && /^[\w-]{1,100}$/.test(requestId) ? ` Referencia: ${requestId}.` : '';
  let payload;
  try {
    payload = body ? JSON.parse(body) : {};
  } catch {
    throw new Error(`El servidor devolvió una respuesta que no es JSON válido (HTTP ${response.status}; ${contentType}).${reference} Comprueba el proxy y los logs del servicio.`);
  }
  if (!response.ok) throw new Error(`${payload?.error || `Error ${response.status}`}${reference}`);
  return payload;
}
