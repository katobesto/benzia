export class InferenceAdmission {
  constructor({ limit = 0, maxQueue = 16, waitMs = 10000 } = {}) {
    this.limit = limit; this.maxQueue = maxQueue; this.waitMs = waitMs; this.providers = new Map();
  }
  acquire(provider, signal) {
    signal?.throwIfAborted();
    if (!this.limit) return Promise.resolve(() => {});
    let state = this.providers.get(provider);
    if (!state) { state = { active: 0, queue: [] }; this.providers.set(provider, state); }
    const release = () => {
      let released = false;
      return () => {
        if (released) return; released = true;
        state.active--;
        state.queue.shift()?.grant();
        if (!state.active && !state.queue.length) this.providers.delete(provider);
      };
    };
    if (state.active < this.limit) { state.active++; return Promise.resolve(release()); }
    const busy = () => Object.assign(new Error('El proveedor está ocupado. Reintenta en unos segundos.'), { status: 429 });
    if (state.queue.length >= this.maxQueue) return Promise.reject(busy());
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
      const remove = error => { cleanup(); const index = state.queue.indexOf(item); if (index >= 0) state.queue.splice(index, 1); reject(error); };
      const abort = () => remove(signal.reason || new Error('Cancelado'));
      const item = { grant: () => { cleanup(); state.active++; resolve(release()); } };
      const timer = setTimeout(() => remove(busy()), this.waitMs);
      signal?.addEventListener('abort', abort, { once: true });
      state.queue.push(item);
    });
  }
}
