function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((item) => {
    if (typeof item === 'string') return item;
    if (item?.type === 'image_url' || item?.type === 'input_image' || item?.image_url) return '[imagen adjunta]';
    return item?.text || item?.input_text || item?.output_text || '';
  }).join(' ');
}

// Same character-based estimate for complete text and deltas, without retaining
// the response or allocating an array containing every ASCII character.
export class TokenEstimator {
  constructor() { this.units = 0; this.trailingUnits = 0; }

  add(value) {
    if (!value) return;
    const text = this.units ? String(value) : String(value).trimStart();
    const trimmedLength = text.trimEnd().length;
    let units = 0;
    let trailing = 0;
    for (let index = 0; index < text.length; index++) {
      const weight = text.charCodeAt(index) < 128 ? 1 : 2;
      units += weight;
      if (index >= trimmedLength) trailing += weight;
    }
    this.units += units;
    this.trailingUnits = trimmedLength ? trailing : this.trailingUnits + trailing;
  }

  get tokens() { return Math.ceil((this.units - this.trailingUnits) / 4); }
}

export function estimateTokens(text) {
  const estimator = new TokenEstimator();
  estimator.add(text);
  return estimator.tokens;
}

export function estimateInputTokens(body = {}) {
  if (Array.isArray(body.messages)) {
    const estimator = new TokenEstimator();
    for (let index = 0; index < body.messages.length; index++) {
      const message = body.messages[index];
      estimator.add(`${index ? '\n' : ''}${message.role || ''} `);
      estimator.add(textFromContent(message.content));
    }
    return estimator.tokens + body.messages.length * 3;
  }
  if (body.prompt) return estimateTokens(Array.isArray(body.prompt) ? body.prompt.join('\n') : body.prompt);
  if (body.input) return estimateTokens(typeof body.input === 'string' ? body.input : JSON.stringify(body.input));
  return 0;
}

export function extractOutputText(payload = {}) {
  if (Array.isArray(payload.choices)) {
    return payload.choices.map((choice) => (
      choice?.message?.content || choice?.text || choice?.delta?.content ||
      choice?.message?.reasoning || choice?.delta?.reasoning ||
      choice?.message?.reasoning_content || choice?.delta?.reasoning_content || ''
    )).join('');
  }
  if (Array.isArray(payload.output)) {
    return payload.output.flatMap((item) => item?.content || []).map((item) => item?.text || '').join('');
  }
  if (payload.response) return extractOutputText(payload.response);
  if (payload.result) return extractOutputText(payload.result);
  return payload.output_text || (typeof payload.delta === 'string' ? payload.delta : '') ||
    ((payload.type === 'reasoning.delta' || payload.type === 'message.delta') ? payload.content || '' : '');
}

export function extractUsage(payload, requestBody, outputText = '') {
  const usage = payload?.usage || payload?.response?.usage || payload?.result?.usage || {};
  const input = usage.prompt_tokens ?? usage.input_tokens;
  const output = usage.completion_tokens ?? usage.output_tokens;
  if (Number.isFinite(input) || Number.isFinite(output)) {
    return {
      inputTokens: Number(input) || 0,
      outputTokens: Number(output) || 0,
      usageSource: 'upstream'
    };
  }
  return {
    inputTokens: estimateInputTokens(requestBody),
    outputTokens: estimateTokens(outputText || extractOutputText(payload)),
    usageSource: 'estimated'
  };
}

const finiteNumber = (...values) => values.find((value) => Number.isFinite(value));

export function extractUpstreamTelemetry(payload = {}, {
  outputTokens = 0,
  startedAt,
  firstTokenAt,
  completedAt = Date.now()
} = {}) {
  const candidates = [payload, payload?.response, payload?.result].filter(Boolean);
  const usages = candidates.map((candidate) => candidate.usage).filter(Boolean);
  const stats = candidates.map((candidate) => candidate.stats).filter(Boolean);
  const cachedInputTokens = finiteNumber(
    ...usages.flatMap((usage) => [
      usage?.input_tokens_details?.cached_tokens,
      usage?.prompt_tokens_details?.cached_tokens,
      usage?.cached_tokens
    ]),
    ...stats.map((value) => value?.cached_tokens)
  );
  const upstreamRate = finiteNumber(...stats.map((value) => value?.tokens_per_second));
  const upstreamTtftSeconds = finiteNumber(...stats.flatMap((value) => [
    value?.time_to_first_token_seconds,
    value?.ttft_seconds
  ]));
  const generationStartedAt = firstTokenAt || startedAt;
  const generationSeconds = Number.isFinite(generationStartedAt)
    ? Math.max(0.001, (completedAt - generationStartedAt) / 1000)
    : 0;
  const estimatedRate = generationSeconds > 0 && outputTokens > 0 ? outputTokens / generationSeconds : undefined;
  const tokensPerSecond = upstreamRate ?? estimatedRate;

  return {
    telemetryVersion: 2,
    lmCachedInputTokens: cachedInputTokens ?? null,
    lmCacheSource: cachedInputTokens === undefined ? 'unavailable' : 'upstream',
    tokensPerSecond: tokensPerSecond === undefined ? null : Math.round(tokensPerSecond * 10) / 10,
    throughputSource: upstreamRate !== undefined ? 'upstream' : estimatedRate !== undefined ? 'estimated' : 'unavailable',
    generationDurationMs: generationSeconds > 0 ? Math.round(generationSeconds * 1000) : null,
    timeToFirstTokenMs: upstreamTtftSeconds !== undefined
      ? Math.round(upstreamTtftSeconds * 1000)
      : Number.isFinite(firstTokenAt) && Number.isFinite(startedAt)
        ? firstTokenAt - startedAt
        : null
  };
}
