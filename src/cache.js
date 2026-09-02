import crypto from 'node:crypto';

export class ResponseCache {
  constructor({ ttlSeconds, maxEntries }) {
    this.ttlMs = ttlSeconds * 1000;
    this.maxEntries = maxEntries;
    this.entries = new Map();
  }

  keyFor(path, body) {
    return crypto.createHash('sha256').update(`${path}\n${JSON.stringify(body)}`).digest('hex');
  }

  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return null;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return structuredClone(entry.value);
  }

  set(key, value) {
    if (!this.ttlMs || !this.maxEntries) return;
    if (this.entries.has(key)) this.entries.delete(key);
    this.entries.set(key, { expiresAt: Date.now() + this.ttlMs, value: structuredClone(value) });
    while (this.entries.size > this.maxEntries) {
      this.entries.delete(this.entries.keys().next().value);
    }
  }

  clear() {
    const count = this.entries.size;
    this.entries.clear();
    return count;
  }

  stats() {
    return { entries: this.entries.size, ttlSeconds: this.ttlMs / 1000, maxEntries: this.maxEntries };
  }
}

