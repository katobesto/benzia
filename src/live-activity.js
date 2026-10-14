import { TokenEstimator } from './usage.js';

const roundRate = (value) => Math.round(value * 10) / 10;

export class LiveActivity {
  constructor({ now = () => Date.now(), prefillRateReader = null } = {}) {
    this.active = new Map();
    this.now = now;
    this.prefillRateReader = prefillRateReader;
  }

  begin({ id, keyId, keyName, path, model, startedAt }) {
    this.active.set(id, {
      id,
      keyId,
      keyName,
      path,
      model,
      startedAt: startedAt ?? this.now(),
      firstTokenAt: null,
      lastTokenAt: null,
      tokenEstimator: new TokenEstimator(),
      outputTokensApprox: 0,
      samples: [],
      prefillAfter: this.prefillRateReader?.latestPrefillMarker?.() ?? null,
      prefillTokensPerSecond: null
    });
  }

  update(id, outputText, fragment) {
    const item = this.active.get(id);
    if (!item || !outputText) return;
    if (fragment === undefined) item.tokenEstimator = new TokenEstimator();
    this.append(id, fragment === undefined ? outputText : fragment);
  }

  append(id, fragment) {
    const item = this.active.get(id);
    if (!item || !fragment) return;
    item.tokenEstimator.add(fragment);
    this.updateTokens(id, item.tokenEstimator.tokens);
  }

  updateTokens(id, tokens) {
    const item = this.active.get(id);
    if (!item) return;
    const now = this.now();
    item.outputTokensApprox = tokens;
    if (item.firstTokenAt === null) {
      item.firstTokenAt = now;
      item.samples.push({ at: now, tokens: 0 });
    }
    item.lastTokenAt = now;
    const last = item.samples.at(-1);
    // At most one sample per 100 ms, plus the initial zero and window boundary.
    // Fast providers can deliver thousands of deltas in a single burst.
    if (item.samples.length > 1 && Math.floor(last.at / 100) === Math.floor(now / 100)) {
      last.at = now;
      last.tokens = item.outputTokensApprox;
    } else item.samples.push({ at: now, tokens: item.outputTokensApprox });
    while (item.samples.length > 2 && item.samples[1].at < now - 5000) item.samples.shift();
  }

  finish(id) {
    this.active.delete(id);
  }

  snapshot({ keyId } = {}) {
    const now = this.now();
    const streams = [...this.active.values()]
      .filter((item) => !keyId || item.keyId === keyId)
      .map((item) => {
        const oldestSample = item.samples[0];
        const generationSeconds = oldestSample ? (now - oldestSample.at) / 1000 : 0;
        const tokensInWindow = oldestSample ? item.outputTokensApprox - oldestSample.tokens : 0;
        const isEmitting = item.lastTokenAt !== null && now - item.lastTokenAt < 1500;
        if (!isEmitting && item.prefillTokensPerSecond === null) {
          item.prefillTokensPerSecond = this.prefillRateReader?.latestPrefillRate(item.prefillAfter ?? -Infinity) ?? null;
        }
        const prefillTokensPerSecond = !isEmitting ? item.prefillTokensPerSecond : null;
        const tokensPerSecond = generationSeconds >= 0.5
          ? roundRate(tokensInWindow / generationSeconds)
          : 0;
        return {
          id: item.id,
          keyId: item.keyId,
          keyName: item.keyName,
          path: item.path,
          model: item.model,
          status: isEmitting ? 'emitting' : 'waiting',
          startedAt: new Date(item.startedAt).toISOString(),
          elapsedMs: now - item.startedAt,
          outputTokensApprox: item.outputTokensApprox,
          tokensPerSecond,
          prefillTokensPerSecond
        };
      });

    return {
      activeStreams: streams.length,
      tokensPerSecond: roundRate(streams.reduce((sum, item) => sum + (item.status === 'emitting' ? item.tokensPerSecond : item.prefillTokensPerSecond || 0), 0)),
      streams
    };
  }
}
