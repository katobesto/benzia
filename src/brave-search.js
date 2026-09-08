const DEFAULT_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';
const LLM_CONTEXT_ENDPOINT = 'https://api.search.brave.com/res/v1/llm/context';
const MAX_QUERY_CHARS = 400;
const MAX_QUERY_WORDS = 50;
const MAX_SOURCES = 6;
const MAX_SNIPPET_CHARS = 1_600;
const MAX_CONTEXT_CHARS = 18_000;

export const DEFAULT_BRAVE_SEARCH_ENDPOINT = DEFAULT_ENDPOINT;

export function normalizeBraveEndpoint(value) {
  const url = new URL(String(value || DEFAULT_ENDPOINT));
  if (url.protocol !== 'https:') throw new Error('El endpoint de Brave debe usar HTTPS.');
  return url.toString().replace(/\/+$/, '');
}

export function validateSearchQuery(value) {
  const query = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  if (!query) throw new Error('Escribe una consulta para buscar en Internet.');
  if (query.length > MAX_QUERY_CHARS || query.split(' ').length > MAX_QUERY_WORDS) {
    throw new Error('La consulta admite hasta 400 caracteres y 50 palabras.');
  }
  return query;
}

function safeSource(entry) {
  if (!entry || typeof entry.url !== 'string') return null;
  let url;
  try {
    url = new URL(entry.url);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
  } catch {
    return null;
  }
  const title = String(entry.title || url.hostname).replace(/\s+/g, ' ').trim().slice(0, 220);
  const snippets = Array.isArray(entry.snippets)
    ? entry.snippets.map((snippet) => String(snippet || '').replace(/\s+/g, ' ').trim()).filter(Boolean)
    : [];
  return { url: url.toString(), title: title || url.hostname, hostname: url.hostname, snippets };
}

export function formatBraveContext(payload) {
  const grounding = payload?.grounding || {};
  const candidates = [
    ...(Array.isArray(payload?.web?.results)
      ? payload.web.results.map((entry) => ({ ...entry, snippets: [entry.description || ''] }))
      : []),
    ...(Array.isArray(grounding.generic) ? grounding.generic : []),
    ...(Array.isArray(grounding.map) ? grounding.map : []),
    ...(grounding.poi ? [grounding.poi] : [])
  ];
  const seen = new Set();
  const sources = [];
  let remaining = MAX_CONTEXT_CHARS;

  for (const candidate of candidates) {
    const source = safeSource(candidate);
    if (!source || seen.has(source.url) || sources.length >= MAX_SOURCES || remaining <= 0) continue;
    seen.add(source.url);
    const snippets = source.snippets.join('\n').slice(0, Math.min(MAX_SNIPPET_CHARS, remaining));
    remaining -= snippets.length;
    sources.push({ title: source.title, url: source.url, hostname: source.hostname, snippets });
  }

  const context = sources.map((source, index) => {
    const excerpt = source.snippets || '(Brave no devolvió extracto para esta fuente.)';
    return `[${index + 1}] ${source.title}\nURL: ${source.url}\nExtracto: ${excerpt}`;
  }).join('\n\n');

  return {
    sources: sources.map(({ title, url, hostname }) => ({ title, url, hostname })),
    evidence: sources,
    context
  };
}

export async function searchBrave({ endpoint, apiKey, query }) {
  if (!apiKey) {
    const error = new Error('La búsqueda web no está configurada. Pide al administrador que añada la clave de Brave.');
    error.status = 503;
    throw error;
  }
  const normalizedQuery = validateSearchQuery(query);
  const url = normalizeBraveEndpoint(endpoint);
  const request = async (candidateEndpoint) => {
    const requestUrl = new URL(candidateEndpoint);
    requestUrl.search = '';
    requestUrl.searchParams.set('q', normalizedQuery);
    requestUrl.searchParams.set('country', 'ES');
    requestUrl.searchParams.set('search_lang', 'es');
    requestUrl.searchParams.set('count', String(MAX_SOURCES));
    requestUrl.searchParams.set('safesearch', 'moderate');
    return fetch(requestUrl, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'x-subscription-token': apiKey
      },
      signal: AbortSignal.timeout(30_000)
    });
  };
  let response;
  try {
    response = await request(url);
  } catch (cause) {
    const error = new Error('No se pudo conectar con Brave Search.');
    error.status = 502;
    error.cause = cause;
    throw error;
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const isLegacyContext = url === LLM_CONTEXT_ENDPOINT && payload?.error?.code === 'OPTION_NOT_IN_PLAN';
    if (isLegacyContext) {
      try {
        response = await request(DEFAULT_ENDPOINT);
      } catch (cause) {
        const error = new Error('No se pudo conectar con Brave Search.');
        error.status = 502;
        error.cause = cause;
        throw error;
      }
      if (response.ok) {
        const result = formatBraveContext(await response.json());
        return { query: normalizedQuery, ...result };
      }
    }
    const error = new Error(response.status === 401 || response.status === 403
      ? 'Brave rechazó la clave configurada.'
      : response.status === 429 ? 'Brave ha aplicado un límite temporal de consultas.' : 'Brave no pudo completar la búsqueda.');
    error.status = response.status === 429 ? 429 : 502;
    throw error;
  }
  const result = formatBraveContext(await response.json());
  return { query: normalizedQuery, ...result };
}
