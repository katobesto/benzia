import { extractOutputText, TokenEstimator } from './usage.js';

// This observer never changes the forwarded bytes. Oversized/malformed events
// are ignored for telemetry only, so diagnostics cannot buffer an entire stream.
const MAX_EVENT_CHARS = 1024 * 1024;

export class StreamMetrics {
  constructor({ onFragment = () => {}, now = Date.now } = {}) {
    this.onFragment = onFragment;
    this.now = now;
    this.decoder = new TextDecoder();
    this.estimator = new TokenEstimator();
    this.payload = { usage: {}, stats: {} };
    this.firstTokenAt = null;
    this.hasFragments = false;
    this.lineParts = [];
    this.lineLength = 0;
    this.data = [];
    this.dataLength = 0;
    this.discardEvent = false;
    this.skipLf = false;
  }

  write(bytes) { this.consume(this.decoder.decode(bytes, { stream: true })); }

  end() {
    this.consume(this.decoder.decode());
    if (this.lineLength) this.finishLine();
    this.dispatch();
  }

  consume(text) {
    // Scan only new bytes, joining a split line once, when it is complete.
    let start = 0;
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      if (this.skipLf) {
        this.skipLf = false;
        if (code === 10) { start = index + 1; continue; }
      }
      if (code !== 10 && code !== 13) continue;
      this.appendLine(text.slice(start, index));
      this.finishLine();
      this.skipLf = code === 13;
      start = index + 1;
    }
    this.appendLine(text.slice(start));
  }

  appendLine(text) {
    this.lineLength += text.length;
    if (this.lineLength + this.dataLength > MAX_EVENT_CHARS) {
      this.discardEvent = true;
      this.lineParts = [];
      this.data = [];
    } else if (!this.discardEvent && text) this.lineParts.push(text);
  }

  finishLine() {
    if (!this.lineLength) this.dispatch();
    else if (!this.discardEvent) {
      const line = this.lineParts.join('');
      if (line === 'data' || line.startsWith('data:')) {
        const value = line.slice(5).replace(/^ /, '');
        this.data.push(value);
        this.dataLength += value.length + 1;
      }
    }
    this.lineParts = [];
    this.lineLength = 0;
  }

  dispatch() {
    if (!this.discardEvent && this.data.length) {
      const data = this.data.join('\n');
      if (data.trim() !== '[DONE]') {
        let payload;
        try { payload = JSON.parse(data); } catch { /* Non-JSON SSE stays transparent. */ }
        if (payload && typeof payload === 'object') {
          try { this.observe(payload); } catch { /* Bad telemetry must not interrupt forwarding. */ }
        }
      }
    }
    this.data = [];
    this.dataLength = 0;
    this.discardEvent = false;
  }

  observe(payload) {
    // Preserve numeric usage/stats even when a later stop event omits them.
    // Never retain response snapshots, prompts, logprobs or generated content.
    for (const source of [payload, payload.response, payload.result]) {
      if (!source) continue;
      for (const field of ['prompt_tokens', 'input_tokens', 'completion_tokens', 'output_tokens', 'cached_tokens']) {
        if (Number.isFinite(source.usage?.[field])) this.payload.usage[field] = source.usage[field];
      }
      for (const field of ['input_tokens_details', 'prompt_tokens_details']) {
        const cached = source.usage?.[field]?.cached_tokens;
        if (Number.isFinite(cached)) this.payload.usage[field] = { cached_tokens: cached };
      }
      for (const field of ['tokens_per_second', 'time_to_first_token_seconds', 'ttft_seconds', 'cached_tokens']) {
        if (Number.isFinite(source.stats?.[field])) this.payload.stats[field] = source.stats[field];
      }
    }
    // Responses emits full snapshots as well as deltas. Counting both would
    // duplicate the output and inflate the dashboard's estimated throughput.
    const responseEvent = typeof payload.type === 'string' && payload.type.startsWith('response.');
    if (responseEvent && !payload.type.endsWith('.delta') && (this.hasFragments || !['response.completed', 'response.incomplete'].includes(payload.type))) return;
    const fragment = extractOutputText(payload);
    if (!fragment || typeof fragment !== 'string') return;
    this.hasFragments = true;
    this.firstTokenAt ??= this.now();
    this.estimator.add(fragment);
    this.onFragment(fragment, this.estimator.tokens);
  }
}
