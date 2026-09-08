import { bus } from '../bus/telemetry.js';

/**
 * Outbound call pacer.
 *
 * The retry layer handles a refusal after it happens. This avoids provoking one: RYO
 * publishes a per-minute ceiling on every key (`/whoami` → `rate_limit_per_min`, and the
 * credential table's "Rate Per Minute"), and the guide asks builders to read that limit
 * and avoid tight polling loops rather than discover it by being refused.
 *
 * Two constraints, not one:
 *
 *   1. A sliding-window ceiling, so no more than `perMinute` calls occur in any 60s.
 *   2. A minimum interval between consecutive calls, 60000/perMinute by default.
 *
 * The second matters more than it looks. Against live RYO a burst of five or six rapid
 * calls is refused with a tool-level rate limit *while /whoami still reports the full
 * per-minute quota remaining* — so the binding constraint is burst rate, not volume. A
 * pure sliding window happily spends the whole minute's budget in two seconds and trips
 * exactly that. Spacing the calls evenly is what the guide means by "avoid tight polling
 * loops".
 */
export class RatePacer {
  private readonly timestamps: number[] = [];
  // Negative infinity, not 0: a monotonic clock that legitimately starts at 0 would
  // make a `> 0` sentinel silently skip the first spacing gap.
  private lastCallAt = Number.NEGATIVE_INFINITY;
  private readonly minIntervalMs: number;

  constructor(
    private readonly perMinute: number,
    private readonly now: () => number = Date.now,
    private readonly sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
    minIntervalMs?: number,
  ) {
    this.minIntervalMs = minIntervalMs ?? (perMinute > 0 ? Math.ceil(60_000 / perMinute) : 0);
  }

  get enabled(): boolean {
    return this.perMinute > 0;
  }

  /** Calls remaining in the current sliding minute. */
  remaining(): number {
    this.evict();
    return Math.max(0, this.perMinute - this.timestamps.length);
  }

  private evict(): void {
    const cutoff = this.now() - 60_000;
    while (this.timestamps.length > 0 && this.timestamps[0]! <= cutoff) this.timestamps.shift();
  }

  /** Wait, if necessary, until another call fits inside the window. Then record it. */
  async acquire(): Promise<number> {
    if (!this.enabled) return 0;
    this.evict();

    let waited = 0;
    while (this.timestamps.length >= this.perMinute) {
      const oldest = this.timestamps[0]!;
      const waitMs = Math.max(1, oldest + 60_000 - this.now());
      bus.publish({
        type: 'rate_limit',
        backoff: {
          attempt: 1,
          ofAttempts: 1,
          delayMs: waitMs,
          reason: 'RATE_LIMITED',
          status: null,
          fromRetryAfter: false,
          rateLimit: { limit: this.perMinute, remaining: 0, reset: null },
          at: new Date().toISOString(),
        },
      });
      await this.sleep(waitMs);
      waited += waitMs;
      this.evict();
    }

    // Even inside the window, keep consecutive calls spaced.
    const sinceLast = this.now() - this.lastCallAt;
    if (sinceLast < this.minIntervalMs) {
      const gap = this.minIntervalMs - sinceLast;
      await this.sleep(gap);
      waited += gap;
      this.evict();
    }

    this.lastCallAt = this.now();
    this.timestamps.push(this.lastCallAt);
    return waited;
  }
}
