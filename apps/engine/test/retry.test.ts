/**
 * Rate-limit handling, tested against a REAL HTTP server that really returns 429 with
 * a real Retry-After header — not a stubbed fetch. The guide names 429 as the failure
 * builders should expect, so this is the one that has to actually work.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  createRetryingFetch,
  fullJitterDelay,
  parseRetryAfter,
  readRateLimitHeaders,
  type BackoffEvent,
} from '../src/mcp/retry.js';

let server: Server;
let base: string;

/** Per-path scripted behaviour, so each test drives a distinct real response. */
const state = {
  limited: { remaining: 0, retryAfter: '1' },
  flaky: { remaining: 0 },
  hits: {} as Record<string, number>,
};

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = req.url ?? '/';
    state.hits[path] = (state.hits[path] ?? 0) + 1;

    if (path === '/limited') {
      res.setHeader('X-RateLimit-Limit', '1000');
      res.setHeader('X-RateLimit-Remaining', String(Math.max(0, 3 - state.hits[path]!)));
      res.setHeader('X-RateLimit-Reset', '1788800000');
      if (state.limited.remaining > 0) {
        state.limited.remaining -= 1;
        res.setHeader('Retry-After', state.limited.retryAfter);
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'rate_limited' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (path === '/unavailable') {
      if (state.flaky.remaining > 0) {
        state.flaky.remaining -= 1;
        res.writeHead(503);
        res.end('unavailable');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (path === '/always-limited') {
      res.setHeader('Retry-After', '0');
      res.writeHead(429);
      res.end('nope');
      return;
    }

    if (path === '/bad-request') {
      res.writeHead(400);
      res.end('invalid arguments');
      return;
    }

    if (path === '/unauthorized') {
      res.writeHead(401);
      res.end('bad credential');
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const collector = () => {
  const events: BackoffEvent[] = [];
  return { events, onBackoff: (e: BackoffEvent) => events.push(e) };
};

describe('Retry-After parsing', () => {
  it('reads delta-seconds', () => {
    expect(parseRetryAfter('30')).toBe(30_000);
  });

  it('reads an HTTP-date', () => {
    const now = Date.parse('2026-09-07T12:00:00Z');
    expect(parseRetryAfter('Mon, 07 Sep 2026 12:00:30 GMT', now)).toBe(30_000);
  });

  it('never returns a negative wait for a date already in the past', () => {
    const now = Date.parse('2026-09-07T12:00:00Z');
    expect(parseRetryAfter('Mon, 07 Sep 2026 11:59:00 GMT', now)).toBe(0);
  });

  it('returns null for junk so the caller falls back to computed backoff', () => {
    expect(parseRetryAfter('soon')).toBeNull();
    expect(parseRetryAfter(null)).toBeNull();
  });
});

describe('full jitter', () => {
  const policy = { maxAttempts: 5, baseDelayMs: 500, maxDelayMs: 20_000 };

  it('is uniform across the whole window, not clustered near the ceiling', () => {
    // Equal jitter would floor every wait at half the ceiling. Full jitter must be
    // able to return values near zero — that is what de-synchronises a herd.
    expect(fullJitterDelay(3, policy, () => 0)).toBe(0);
    expect(fullJitterDelay(3, policy, () => 0.999)).toBeGreaterThan(3_900);
  });

  it('grows the ceiling exponentially and then clamps at maxDelayMs', () => {
    const top = (attempt: number) => fullJitterDelay(attempt, policy, () => 0.999999);
    expect(top(0)).toBeLessThanOrEqual(500);
    expect(top(1)).toBeLessThanOrEqual(1_000);
    expect(top(2)).toBeLessThanOrEqual(2_000);
    expect(top(20)).toBeLessThanOrEqual(20_000);
  });
});

describe('rate-limit aware fetch against a real server', () => {
  it('honours Retry-After on a real 429 and then succeeds', async () => {
    state.limited.remaining = 2;
    state.limited.retryAfter = '1';
    state.hits['/limited'] = 0;
    const { events, onBackoff } = collector();
    const waits: number[] = [];

    const f = createRetryingFetch({
      onBackoff,
      sleepFn: async (ms) => {
        waits.push(ms);
      },
    });

    const res = await f(`${base}/limited`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    expect(events).toHaveLength(2);
    expect(events.every((e) => e.reason === 'RATE_LIMITED')).toBe(true);
    expect(events.every((e) => e.fromRetryAfter)).toBe(true);
    // Retry-After: 1 second — the server's number, not our backoff curve.
    expect(waits).toEqual([1000, 1000]);
  });

  it('surfaces the quota headers the server publishes', async () => {
    state.limited.remaining = 0;
    state.hits['/limited'] = 0;
    const seen: unknown[] = [];
    const f = createRetryingFetch({ onQuota: (q) => seen.push(q), sleepFn: async () => {} });
    await f(`${base}/limited`);
    expect(seen[0]).toMatchObject({ limit: 1000, reset: 1788800000 });
  });

  it('falls back to jittered backoff on a 503 with no Retry-After', async () => {
    state.flaky.remaining = 2;
    const { events, onBackoff } = collector();
    const f = createRetryingFetch({
      onBackoff,
      random: () => 0.5,
      sleepFn: async () => {},
      policy: { baseDelayMs: 400 },
    });

    const res = await f(`${base}/unavailable`);
    expect(res.status).toBe(200);
    expect(events.map((e) => e.reason)).toEqual(['UPSTREAM_UNAVAILABLE', 'UPSTREAM_UNAVAILABLE']);
    expect(events.every((e) => e.fromRetryAfter)).toBe(false);
    // random 0.5 of ceilings 400 and 800.
    expect(events.map((e) => e.delayMs)).toEqual([200, 400]);
  });

  it('gives up after maxAttempts and returns the 429 rather than throwing something invented', async () => {
    const { events, onBackoff } = collector();
    const f = createRetryingFetch({ onBackoff, sleepFn: async () => {}, policy: { maxAttempts: 3 } });
    const res = await f(`${base}/always-limited`);
    expect(res.status).toBe(429);
    expect(events).toHaveLength(2); // 3 attempts => 2 backoffs
    expect(events[1]!.ofAttempts).toBe(3);
  });

  it('does NOT retry a 400 — the guide forbids retrying invalid arguments', async () => {
    state.hits['/bad-request'] = 0;
    const { events, onBackoff } = collector();
    const f = createRetryingFetch({ onBackoff, sleepFn: async () => {} });
    const res = await f(`${base}/bad-request`);
    expect(res.status).toBe(400);
    expect(events).toHaveLength(0);
    expect(state.hits['/bad-request']).toBe(1);
  });

  it('does NOT retry a 401 — waiting cannot fix a bad credential', async () => {
    state.hits['/unauthorized'] = 0;
    const f = createRetryingFetch({ sleepFn: async () => {} });
    expect((await f(`${base}/unauthorized`)).status).toBe(401);
    expect(state.hits['/unauthorized']).toBe(1);
  });

  it('retries a genuine connection failure, then rethrows if it never recovers', async () => {
    const { events, onBackoff } = collector();
    const f = createRetryingFetch({ onBackoff, sleepFn: async () => {}, policy: { maxAttempts: 3 } });
    // Port 1 is not listening; this is a real ECONNREFUSED, not a simulated one.
    await expect(f('http://127.0.0.1:1/nope')).rejects.toThrow();
    expect(events.map((e) => e.reason)).toEqual(['NETWORK_ERROR', 'NETWORK_ERROR']);
  });

  it('never blows up into an untracked failure — every retry is reported', async () => {
    state.limited.remaining = 3;
    state.limited.retryAfter = '0';
    state.hits['/limited'] = 0;
    const { events, onBackoff } = collector();
    const f = createRetryingFetch({ onBackoff, sleepFn: async () => {}, policy: { maxAttempts: 5 } });
    await f(`${base}/limited`);
    // Every single backoff carries attempt, delay, reason and status for the audit trail.
    for (const e of events) {
      expect(e.attempt).toBeGreaterThan(0);
      expect(e.delayMs).toBeGreaterThanOrEqual(0);
      expect(e.reason).toBe('RATE_LIMITED');
      expect(e.status).toBe(429);
      expect(Date.parse(e.at)).not.toBeNaN();
    }
    expect(events).toHaveLength(3);
  });
});
