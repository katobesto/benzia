import crypto from 'node:crypto';

import { searchBrave } from './brave-search.js';
import { extractUsage } from './usage.js';
import { routeForModel } from './providers.js';

const MAX_MESSAGES = 12;
const MAX_MESSAGE_CHARS = 1800;
const MAX_QUERIES = 3;
const MAX_SOURCES = 8;

const cleanText = (value, limit = MAX_MESSAGE_CHARS) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);

export function normalizeResearchMessages(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((message) => ['user', 'assistant'].includes(message?.role) && typeof message.content === 'string')
    .slice(-MAX_MESSAGES)
    .map((message) => ({ role: message.role, content: cleanText(message.content) }))
    .filter((message) => message.content);
}

function fallbackPlan(messages) {
  const userMessages = messages.filter((message) => message.role === 'user');
  const current = userMessages.at(-1)?.content || '';
  const subject = userMessages.slice(-4, -1).map((message) => message.content).join(' ').slice(-300);
  const primary = `${subject}${subject && current ? ' ' : ''}${current}`.slice(0, 400);
  return { topic: subject || current || 'consulta del usuario', shouldSearch: true, queries: [primary || current].filter(Boolean) };
}

export function parseResearchPlan(value, messages) {
  const fallback = fallbackPlan(messages);
  const match = String(value || '').match(/\{[\s\S]*\}/);
  if (!match) return fallback;
  try {
    const parsed = JSON.parse(match[0]);
    const shouldSearch = parsed.should_search !== false && parsed.shouldSearch !== false;
    const plannedQueries = [...new Set((Array.isArray(parsed.queries) ? parsed.queries : [])
      .map((query) => cleanText(query, 400)).filter(Boolean))].slice(0, MAX_QUERIES);
    const queries = shouldSearch ? plannedQueries : [];
    return {
      topic: cleanText(parsed.topic, 160) || fallback.topic,
      shouldSearch,
      queries: shouldSearch ? (queries.length ? queries : fallback.queries) : []
    };
  } catch {
    return fallback;
  }
}

function plannerPrompt(messages) {
  const transcript = messages.map((message) => `${message.role === 'user' ? 'USUARIO' : 'ASISTENTE'}: ${message.content}`).join('\n');
  return `Decide primero si una búsqueda web aportará valor real para responder al último mensaje del usuario dentro de esta conversación. Devuelve EXCLUSIVAMENTE JSON válido, sin Markdown: {"topic":"tema concreto","should_search":true,"queries":["consulta autónoma 1","consulta autónoma 2"]}. Usa should_search:false y queries:[] si la respuesta es conversacional, creativa, de razonamiento, o puede responderse con el contexto disponible sin información actual, verificable o con fuentes. Usa should_search:true si el usuario pide buscar, fuentes, enlaces, información reciente, precisión factual, recomendaciones actuales o datos verificables. Si buscas, incluye entre 1 y 3 consultas. Cada consulta debe poder entenderse por sí sola, conservar el sujeto implícito de la conversación, usar términos específicos y priorizar fuentes primarias cuando corresponda. No respondas al usuario ni reveles razonamiento.\n\nCONVERSACIÓN:\n${transcript}`;
}

async function planWithModel({ config, settings, model, messages, accessKey, store }) {
  const startedAt = Date.now();
  const body = {
    model,
    temperature: 0.1,
    max_tokens: 280,
    messages: [
      { role: 'system', content: 'Eres un planificador de búsquedas. Cumple exactamente el formato solicitado.' },
      { role: 'user', content: plannerPrompt(messages) }
    ]
  };
  const externalRoute = routeForModel(model, settings.externalProviders);
  const provider = externalRoute && accessKey.allowExternalProviders ? externalRoute.provider : null;
  if (externalRoute && !provider) return fallbackPlan(messages);
  if (provider) body.model = externalRoute.upstreamModel;
  try {
    const response = await fetch(`${provider?.baseUrl || settings.upstreamBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        ...((provider?.apiKey || settings.upstreamApiKey) ? { authorization: `Bearer ${provider?.apiKey || settings.upstreamApiKey}` } : {})
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Math.min(config.requestTimeoutMs, 45_000))
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const output = payload.choices?.[0]?.message?.content || payload.output?.[0]?.content?.[0]?.text || '';
    const usage = extractUsage(payload, body);
    await store.recordMetric?.({
      id: crypto.randomUUID(), at: new Date().toISOString(), keyId: accessKey.id,
      path: '/chat/research/planner', model, status: response.status, latencyMs: Date.now() - startedAt,
      ...usage, lmCachedInputTokens: null, lmCacheSource: 'unavailable', tokensPerSecond: null,
      throughputSource: 'unavailable', telemetryVersion: 2, generationDurationMs: null, timeToFirstTokenMs: null, stream: false
    });
    return parseResearchPlan(output, messages);
  } catch {
    return fallbackPlan(messages);
  }
}

function formatEvidence(entries) {
  return entries.map((source, index) => `[${index + 1}] ${source.title}\nURL: ${source.url}\nExtracto: ${source.snippets || '(sin extracto disponible)'}`).join('\n\n');
}

export async function runResearch({ config, store, accessKey, model, messages, emit }) {
  const stored = store.getSettings();
  const settings = {
    upstreamBaseUrl: (stored.upstreamBaseUrl || config.upstreamBaseUrl).replace(/\/+$/, ''),
    upstreamApiKey: stored.upstreamApiKey ?? config.upstreamApiKey,
    braveSearchEndpoint: stored.braveSearchEndpoint || config.braveSearchEndpoint,
    braveSearchApiKey: stored.braveSearchApiKey ?? config.braveSearchApiKey,
    externalProviders: Array.isArray(stored.externalProviders) ? stored.externalProviders : []
  };
  const safeMessages = normalizeResearchMessages(messages);
  if (!safeMessages.length) throw new Error('No hay contexto suficiente para investigar.');
  if (!settings.braveSearchApiKey) {
    const error = new Error('La búsqueda web no está configurada. Pide al administrador que añada la clave de Brave.');
    error.status = 503;
    throw error;
  }

  emit('research.status', { step: 'planning', label: 'Entendiendo tu consulta' });
  const plan = await planWithModel({ config, settings, model, messages: safeMessages, accessKey, store });
  emit('research.plan', { topic: plan.topic, shouldSearch: plan.shouldSearch, queries: plan.queries });
  if (!plan.shouldSearch) {
    emit('research.status', { step: 'complete', label: 'El contexto de la conversación es suficiente; redactando respuesta' });
    emit('research.complete', { sources: [], context: '', skipped: true });
    return { context: '', sources: [], plan };
  }
  emit('research.status', { step: 'searching', label: `Buscando ${plan.queries.length} fuente${plan.queries.length === 1 ? '' : 's'} de información` });

  const settled = await Promise.allSettled(plan.queries.map(async (query, index) => {
    const result = await searchBrave({ endpoint: settings.braveSearchEndpoint, apiKey: settings.braveSearchApiKey, query });
    emit('research.search', { index: index + 1, total: plan.queries.length, query, sources: result.sources.length });
    return result;
  }));
  const successes = settled.filter((result) => result.status === 'fulfilled').map((result) => result.value);
  if (!successes.length) throw new Error('Brave no pudo devolver fuentes para esta investigación.');

  emit('research.status', { step: 'evidence', label: 'Seleccionando fuentes relevantes' });
  const seen = new Set();
  const sources = successes.flatMap((result) => result.evidence || []).filter((source) => {
    if (!source?.url || seen.has(source.url) || seen.size >= MAX_SOURCES) return false;
    seen.add(source.url);
    return true;
  });
  if (!sources.length) throw new Error('No se encontraron fuentes relevantes para responder.');
  const publicSources = sources.map(({ title, url, hostname }) => ({ title, url, hostname }));
  emit('research.sources', { sources: publicSources });
  const context = formatEvidence(sources);
  emit('research.complete', { sources: publicSources, context });
  return { context, sources: publicSources, plan };
}
