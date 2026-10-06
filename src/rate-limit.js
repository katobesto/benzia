import crypto from 'node:crypto';

const WINDOW_MS = 60_000;
const PRUNE_INTERVAL_MS = 60_000;

export class RateLimiter {
  constructor({ limit, windowMs = WINDOW_MS, maxBuckets = 20_000, onLimit = () => {}, now = Date.now }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.maxBuckets = maxBuckets;
    this.onLimit = onLimit;
    this.now = now;
    this.buckets = new Map();
    this.fingerprints = new WeakMap();
    this.lastPrune = 0;
    this.ipSecret = crypto.randomBytes(32);
    this.lastLimitedEvents = new Map();
  }

  shouldLog(details) {
    const key = `${details.type}:${details.identity || details.addressFingerprint || ''}:${details.route}`;
    const now = this.now();
    if (now - (this.lastLimitedEvents.get(key) || 0) < this.windowMs) return false;
    this.lastLimitedEvents.set(key, now);
    if (this.lastLimitedEvents.size > this.maxBuckets) this.lastLimitedEvents.delete(this.lastLimitedEvents.keys().next().value);
    return true;
  }

  consume(key, details = {}, limit = this.limit, emitOnLimit = true) {
    const now = this.now();
    if (now - this.lastPrune >= PRUNE_INTERVAL_MS) {
      for (const [bucketKey, bucket] of this.buckets) {
        if (now - bucket.startedAt >= this.windowMs) this.buckets.delete(bucketKey);
      }
      this.lastPrune = now;
    }
    let bucket = this.buckets.get(key);
    if (!bucket || now - bucket.startedAt >= this.windowMs) {
      bucket = { startedAt: now, count: 0 };
      this.buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (this.buckets.size > this.maxBuckets) this.buckets.delete(this.buckets.keys().next().value);
    if (bucket.count <= limit) return { allowed: true, remaining: limit - bucket.count };

    const retryAfterSeconds = Math.max(1, Math.ceil((bucket.startedAt + this.windowMs - now) / 1000));
    if (emitOnLimit) this.onLimit({ ...details, retryAfterSeconds });
    return { allowed: false, retryAfterSeconds };
  }

  addressFingerprint(req) {
    if (!this.fingerprints.has(req)) this.fingerprints.set(req, crypto.createHmac('sha256', this.ipSecret).update(req.rateLimitAddress || req.socket?.remoteAddress || 'unknown').digest('hex').slice(0, 16));
    return this.fingerprints.get(req);
  }

  middleware({ key, details = () => ({}) }) {
    return (req, res, next) => {
      const result = this.consume(key(req), details(req));
      if (result.allowed) return next();
      res.set('Retry-After', String(result.retryAfterSeconds));
      return res.status(429).json({ error: 'Demasiadas solicitudes. Espera un momento antes de volver a intentarlo.', code: 'rate_limited' });
    };
  }
}
