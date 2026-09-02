import { estimateTokens } from './usage.js';

const roundRate = (value) => Math.round(value * 10) / 10;

export class LiveActivity {
  constructor({ now = () => Date.now() } = {}) {
    this.active = new Map();
    this.now = now;
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
      outputText: '',
      outputTokensApprox: 0,
      samples: []
    });
  }

  update(id, outputText) {
    const item = this.active.get(id);
    if (!item || !outputText) return;
    const now = this.now();
    item.outputText = outputText;
    item.outputTokensApprox = estimateTokens(outputText);
    if (!item.firstTokenAt) {
      item.firstTokenAt = now;
      item.samples.push({ at: now, tokens: 0 });
    }
    item.lastTokenAt = now;
    item.samples.push({ at: now, tokens: item.outputTokensApprox });
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
        const isEmitting = item.lastTokenAt && now - item.lastTokenAt < 1500;
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
          tokensPerSecond
        };
      });

    return {
      activeStreams: streams.length,
      tokensPerSecond: roundRate(streams.reduce((sum, item) => sum + item.tokensPerSecond, 0)),
      streams
    };
  }
}
