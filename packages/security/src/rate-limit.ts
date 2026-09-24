/** Token-bucket rate limiter keyed by client identity. */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; updated: number }>();
  constructor(
    private capacity = 120,
    private refillPerSec = 40,
  ) {}

  take(key: string, cost = 1): boolean {
    const now = Date.now();
    const b = this.buckets.get(key) ?? { tokens: this.capacity, updated: now };
    b.tokens = Math.min(this.capacity, b.tokens + ((now - b.updated) / 1000) * this.refillPerSec);
    b.updated = now;
    const ok = b.tokens >= cost;
    if (ok) b.tokens -= cost;
    this.buckets.set(key, b);
    if (this.buckets.size > 10_000) this.buckets.clear();
    return ok;
  }
}
