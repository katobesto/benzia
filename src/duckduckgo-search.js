import { validateSearchQuery } from './brave-search.js';

const DDG_ENDPOINT = 'https://html.duckduckgo.com/html/';
const MAX_SOURCES = 6;
const MAX_SNIPPET_CHARS = 1_600;
const MAX_CONTEXT_CHARS = 18_000;

const decodeEntities = (value) => String(value || '')
  .replace(/&nbsp;/gi, ' ')
  .replace(/&lt;/gi, '<')
  .replace(/&gt;/gi, '>')
  .replace(/&quot;/gi, '"')
  .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
  .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(parseInt(code, 16)))
  .replace(/&amp;/gi, '&');

const stripTags = (value) => decodeEntities(String(value || '').replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();

// DuckDuckGo envuelve cada destino en //duckduckgo.com/l/?uddg=<urlencoded>&rut=...
function resolveResultUrl(href) {
  const raw = decodeEntities(String(href || '')).trim();
  if (!raw || raw.startsWith('javascript:')) return null;
  const candidate = raw.startsWith('//') ? `https:${raw}` : raw;
  try {
    const url = new URL(candidate);
    if (url.hostname.endsWith('duckduckgo.com') && url.pathname === '/l/') {
      const target = url.searchParams.get('uddg');
      if (!target) return null;
      return new URL(target);
    }
    return url;
  } catch {
    return null;
  }
}

export function parseDuckDuckGoResults(html) {
  const document = String(html || '');
  const sources = [];
  const seen = new Set();
  const blocks = document.split(/<div[^>]+class="[^"]*result__body[^"]*"/i).slice(1);
  const candidates = blocks.length
    ? blocks
    : document.split(/(?=<a[^>]+class="[^"]*result__a")/i).slice(1);
  for (const block of candidates) {
    const link = block.match(/<a[^>]+class="[^"]*result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!link) continue;
    const url = resolveResultUrl(link[1]);
    if (!url || !['http:', 'https:'].includes(url.protocol) || seen.has(url.toString())) continue;
    seen.add(url.toString());
    const snippet = (block.match(/<a[^>]+class="[^"]*result__snippet"[^>]*>([\s\S]*?)<\/a>/i)?.[1]
      || block.match(/<td[^>]+class="[^"]*result-snippet"[^>]*>([\s\S]*?)<\/td>/i)?.[1]
      || '').trim();
    sources.push({
      title: stripTags(link[2]) || url.hostname,
      url: url.toString(),
      hostname: url.hostname,
      snippets: snippet ? [stripTags(snippet).slice(0, MAX_SNIPPET_CHARS)] : []
    });
    if (sources.length >= MAX_SOURCES) break;
  }
  return sources;
}

export function formatDuckDuckGoContext(sources) {
  let remaining = MAX_CONTEXT_CHARS;
  const evidence = sources.map((source) => {
    const excerpt = String(source.snippets?.[0] || '').slice(0, Math.min(MAX_SNIPPET_CHARS, remaining));
    remaining -= excerpt.length;
    return { title: source.title, url: source.url, hostname: source.hostname, snippets: excerpt ? [excerpt] : [] };
  });
  const context = evidence.map((source, index) => {
    const excerpt = source.snippets?.[0] || '(DuckDuckGo no devolvió extracto para esta fuente.)';
    return `[${index + 1}] ${source.title}\nURL: ${source.url}\nExtracto: ${excerpt}`;
  }).join('\n\n');
  return {
    sources: evidence.map(({ title, url, hostname }) => ({ title, url, hostname })),
    evidence,
    context
  };
}

export async function searchDuckDuckGo({ query, signal, endpoint = DDG_ENDPOINT }) {
  const normalizedQuery = validateSearchQuery(query);
  const url = new URL(endpoint);
  url.searchParams.set('q', normalizedQuery);
  url.searchParams.set('kl', 'es-es');
  let response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        accept: 'text/html',
        'accept-language': 'es',
        'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) benzIA-gateway/1.0'
      },
      signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(signal ? [signal] : [])])
    });
  } catch (cause) {
    const error = new Error('No se pudo conectar con DuckDuckGo Search.');
    error.status = 502;
    error.cause = cause;
    throw error;
  }
  if (response.status === 429 || response.status === 403) {
    const error = new Error('DuckDuckGo ha limitado temporalmente las consultas. Reintenta en un momento.');
    error.status = 429;
    throw error;
  }
  if (!response.ok) {
    const error = new Error('DuckDuckGo no pudo completar la búsqueda.');
    error.status = 502;
    throw error;
  }
  const sources = parseDuckDuckGoResults(await response.text());
  const result = formatDuckDuckGoContext(sources);
  return { query: normalizedQuery, ...result };
}
