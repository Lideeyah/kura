import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import { bus } from '../bus/telemetry.js';

/**
 * Rate-limit aware fetch for the RYO transport.
 *
 * The builder guide is specific about this, and it is the failure mode most likely to
 * be hit in production: read the limit from /whoami, inspect X-RateLimit-* headers,
 * honour Retry-After when rate-limited, avoid tight polling loops, and "use exponential
 * backoff with jitter for 429, 503, and temporary network errors". It is equally
 * specific about what NOT to retry: "Do not retry invalid arguments or unknown tools
 * without changing the request."
 *
 * So this retries exactly three things — 429, 503, and transport-level network errors —
 * and nothing else. A 400 or a 404 is a bug in the request and comes straight back.
 * A 401 is a credential problem that no amount of waiting will fix.
 *
 * Jitter is FULL jitter (`random(0, ceiling)`), not the "backoff plus a small random
 * nudge" variant. Equal jitter still leaves every client's retries clustered around the
 * same instant after a shared outage; full jitter spreads them across the whole window,
 * which is the property that actually prevents a thundering herd on recovery.
 */

export interface RetryPolicy {
  /** Total attempts including the first. 1 disables retrying. */
  maxAttempts: number;
  /** Base for the exponential ceiling, in milliseconds. */
  baseDelayMs: number;
  /** Upper bound on any single wait, including a server-supplied Retry-After. */
  maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 4,
  baseDelayMs: 500,
  maxDelayMs: 20_000,
};

/** Status codes the guide sanctions retrying. */
const RETRYABLE_STATUS = new Set([429, 503]);

export interface RateLimitSnapshot {
  limit: number | null;
  remaining: number | null;
  /** Epoch seconds, as published by the server. */
  reset: number | null;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * `Retry-After` is either delta-seconds or an HTTP-date (RFC 9110). Both are honoured;
 * anything else returns null so the caller falls back to computed backoff.
 */
export function parseRetryAfter(header: string | null, now = Date.now()): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - now);
}

/** Exponential ceiling with FULL jitter: uniform in [0, min(cap, base * 2^attempt)]. */
export function fullJitterDelay(
  attempt: number,
  policy: RetryPolicy,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** attempt);
  return Math.floor(random() * ceiling);
}

export function readRateLimitHeaders(res: Response): RateLimitSnapshot {
  const num = (name: string): number | null => {
    const raw = res.headers.get(name);
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };
  return {
    limit: num('x-ratelimit-limit'),
    remaining: num('x-ratelimit-remaining'),
    reset: num('x-ratelimit-reset'),
  };
}

export interface RetryingFetchOptions {
  policy?: Partial<RetryPolicy>;
  /** Injectable for deterministic tests. */
  random?: () => number;
  sleepFn?: (ms: number) => Promise<void>;
  fetchImpl?: FetchLike;
  /** Called on every backoff decision. Defaults to publishing on the telemetry bus. */
  onBackoff?: (event: BackoffEvent) => void;
  /** Called whenever the server publishes quota headers. */
  onQuota?: (snapshot: RateLimitSnapshot) => void;
}

export interface BackoffEvent {
  attempt: number;
  ofAttempts: number;
  delayMs: number;
  reason: 'RATE_LIMITED' | 'UPSTREAM_UNAVAILABLE' | 'NETWORK_ERROR';
  status: number | null;
  /** True when the wait came from the server's own Retry-After rather than our backoff. */
  fromRetryAfter: boolean;
  rateLimit: RateLimitSnapshot | null;
  at: string;
}

export function createRetryingFetch(options: RetryingFetchOptions = {}): FetchLike {
  const policy: RetryPolicy = { ...DEFAULT_RETRY_POLICY, ...options.policy };
  const random = options.random ?? Math.random;
  const doSleep = options.sleepFn ?? sleep;
  const doFetch: FetchLike = options.fetchImpl ?? ((u, i) => fetch(u as string | URL, i));

  const emit =
    options.onBackoff ??
    ((event: BackoffEvent) => {
      bus.publish({ type: 'rate_limit', backoff: event });
    });

  return async (url, init) => {
    let lastError: unknown;

    for (let attempt = 0; attempt < policy.maxAttempts; attempt += 1) {
      const isLast = attempt === policy.maxAttempts - 1;

      let res: Response;
      try {
        res = await doFetch(url, init);
      } catch (err) {
        // Transport-level failure: connection refused, DNS, socket reset.
        lastError = err;
        if (isLast) throw err;
        const delayMs = fullJitterDelay(attempt, policy, random);
        emit({
          attempt: attempt + 1,
          ofAttempts: policy.maxAttempts,
          delayMs,
          reason: 'NETWORK_ERROR',
          status: null,
          fromRetryAfter: false,
          rateLimit: null,
          at: new Date().toISOString(),
        });
        await doSleep(delayMs);
        continue;
      }

      const quota = readRateLimitHeaders(res);
      if (quota.limit !== null || quota.remaining !== null) options.onQuota?.(quota);

      if (!RETRYABLE_STATUS.has(res.status)) return res;

      // Out of attempts: hand the 429/503 back so the SDK surfaces a real error rather
      // than this layer inventing one.
      if (isLast) return res;

      const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
      const fromRetryAfter = retryAfterMs !== null;
      const delayMs = fromRetryAfter
        ? Math.min(retryAfterMs, policy.maxDelayMs)
        : fullJitterDelay(attempt, policy, random);

      emit({
        attempt: attempt + 1,
        ofAttempts: policy.maxAttempts,
        delayMs,
        reason: res.status === 429 ? 'RATE_LIMITED' : 'UPSTREAM_UNAVAILABLE',
        status: res.status,
        fromRetryAfter,
        rateLimit: quota,
        at: new Date().toISOString(),
      });

      // The body must be drained before the socket can be reused for the retry.
      await res.arrayBuffer().catch(() => undefined);
      await doSleep(delayMs);
    }

    throw lastError ?? new Error('RETRY_EXHAUSTED');
  };
}
