import { searchBrave } from './brave-search.js';
import { searchDuckDuckGo } from './duckduckgo-search.js';

export const SEARCH_PROVIDERS = new Set(['auto', 'brave', 'duckduckgo']);

export function normalizeSearchProvider(value) {
  const provider = String(value || 'auto').trim().toLowerCase();
  return SEARCH_PROVIDERS.has(provider) ? provider : 'auto';
}

// 'auto' usa Brave cuando hay clave configurada y DuckDuckGo como alternativa sin configuración.
export function resolveSearchProvider({ provider = 'auto', hasBraveKey = false } = {}) {
  const normalized = normalizeSearchProvider(provider);
  if (normalized === 'brave') return 'brave';
  if (normalized === 'duckduckgo') return 'duckduckgo';
  return hasBraveKey ? 'brave' : 'duckduckgo';
}

export async function runWebSearch({ settings, query, signal }) {
  const hasBraveKey = Boolean(settings.braveSearchApiKey);
  const provider = resolveSearchProvider({ provider: settings.webSearchProvider, hasBraveKey });
  if (provider === 'brave') {
    const result = await searchBrave({ endpoint: settings.braveSearchEndpoint, apiKey: settings.braveSearchApiKey, query, signal });
    return { provider, ...result };
  }
  const result = await searchDuckDuckGo({ query, signal });
  return { provider, ...result };
}
