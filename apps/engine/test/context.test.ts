import { describe, expect, it } from 'vitest';
import { contextMultiplier, extractContext, type MarketContext } from '../src/arbiter/context.js';
import { evaluate, type ArbiterInput } from '../src/arbiter/invariants.js';
import type { SizingSignals } from '../src/arbiter/signals.js';
import { MarketContextCache } from '../src/mcp/context-cache.js';
import { EngineError } from '../src/mcp/errors.js';
import { validateEnvelope, type RyoEnvelope } from '../src/schema/tools.js';
import type { InterceptedRyo } from '../src/mcp/interceptor.js';

/** A `market_overview` envelope in the shape live RYO publishes. */
const overview = (data: Record<string, unknown>, over: Record<string, unknown> = {}): RyoEnvelope =>
  validateEnvelope('market_overview', {
    schema_version: '1.0.0',
    tool: 'market_overview',
    status: 'ok',
    data_mode: 'live',
    as_of: new Date().toISOString(),
    request: {},
    data,
    summary: { headline: 'market' },
    availability: { market_breadth: 'ok' },
    warnings: [],
    ...over,
  });

const LIVE_SHAPE = {
  regime: 'risk_on',
  sentiment: { fear_greed_index: 68.0, label: 'greed' },
  market: { total_market_cap_usd: 2_677_093_855_882, btc_dominance_pct: 58.5, breadth: 0.9348 },
};

describe('market context extraction', () => {
  it('reads regime, sentiment and breadth from the live payload shape', () => {
    const ctx = extractContext(overview(LIVE_SHAPE), 1_000);
    expect(ctx).not.toBeNull();
    expect(ctx!.regime).toBe('risk_on');
    expect(ctx!.fearGreed).toBe(68);
    expect(ctx!.breadth).toBeCloseTo(0.9348, 6);
    expect(ctx!.ageMs).toBe(1_000);
    expect(ctx!.status).toBe('ok');
    expect(ctx!.dataMode).toBe('live');
  });

  it('derives breadth from raw advancing/declining counts', () => {
    const ctx = extractContext(overview({ breadth: { advancing: 612, declining: 588 } }), 0);
    expect(ctx!.breadth).toBeCloseTo(612 / 1200, 6);
  });

  it('rescales a breadth published on a 0-100 scale', () => {
    const ctx = extractContext(overview({ market: { breadth: 93.48 } }), 0);
    expect(ctx!.breadth).toBeCloseTo(0.9348, 6);
  });

  /**
   * The load-bearing negative case. An unmeasurable breadth must not become a
   * convenient default — the gate is what refuses, and it can only refuse if this
   * reports the absence honestly.
   */
  it('returns null when breadth cannot be measured, rather than assuming one', () => {
    expect(extractContext(overview({ regime: 'risk_on' }), 0)).toBeNull();
    expect(extractContext(overview({ market: { btc_dominance_pct: 58.5 } }), 0)).toBeNull();
  });

  it('records regime and fear/greed but does not require them', () => {
    const ctx = extractContext(overview({ market: { breadth: 0.8 } }), 0);
    expect(ctx).not.toBeNull();
    expect(ctx!.regime).toBeNull();
    expect(ctx!.fearGreed).toBeNull();
  });
});

const ctx = (over: Partial<MarketContext> = {}): MarketContext => ({
  regime: 'risk_on',
  fearGreed: 68,
  breadth: 0.93,
  ageMs: 1_000,
  status: 'ok',
  dataMode: 'live',
  ...over,
});

describe('context multiplier', () => {
  it('is exactly 1 at and above the reference breadth', () => {
    expect(contextMultiplier(ctx({ breadth: 0.5 }))).toBe(1);
    expect(contextMultiplier(ctx({ breadth: 0.9348 }))).toBe(1);
    expect(contextMultiplier(ctx({ breadth: 1 }))).toBe(1);
  });

  it('scales down linearly below the reference breadth', () => {
    expect(contextMultiplier(ctx({ breadth: 0.4 }))).toBeCloseTo(0.8, 6);
    expect(contextMultiplier(ctx({ breadth: 0.25 }))).toBeCloseTo(0.5, 6);
  });

  it('floors at the configured minimum rather than reaching zero', () => {
    // A multiplier of 0 would refuse silently, without any invariant recording that it
    // said no. Refusal is the gates' job; this only ever shrinks.
    expect(contextMultiplier(ctx({ breadth: 0 }))).toBe(0.25);
    expect(contextMultiplier(ctx({ breadth: 0.01 }))).toBe(0.25);
  });

  it('is monotone non-decreasing in breadth', () => {
    let previous = 0;
    for (let b = 0; b <= 1.0001; b += 0.02) {
      const m = contextMultiplier(ctx({ breadth: Math.min(b, 1) }));
      expect(m).toBeGreaterThanOrEqual(previous);
      previous = m;
    }
  });
});

const env = (over: Record<string, unknown> = {}): RyoEnvelope =>
  validateEnvelope('analyze_token', {
    schema_version: '1.0.0',
    tool: 'analyze_token',
    status: 'ok',
    data_mode: 'live',
    as_of: new Date().toISOString(),
    request: { symbol: 'SOL' },
    data: { market: { price_usd: 172.44 }, technicals: { rsi_14: 56, atr_14: 4.31 } },
    summary: { headline: 'SOL' },
    availability: { market: 'ok', technicals: 'ok' },
    warnings: [],
    ...over,
  });

const sig = (over: Partial<SizingSignals> = {}): SizingSignals => ({
  priceUsd: 172.44,
  atr14: 4.31,
  atrPct: 4.31 / 172.44,
  rsi14: 56,
  completeness: 1,
  ...over,
});

const run = (over: Partial<ArbiterInput> = {}) =>
  evaluate({ token: 'SOL', latencyMs: 42, envelope: env(), signals: sig(), context: ctx(), ...over });

describe('CONTEXT invariant', () => {
  it('passes on a live, recent market read', () => {
    const v = run();
    expect(v.decision).toBe('APPROVED');
    expect(v.invariants.find((i) => i.id === 'CONTEXT')!.state).toBe('PASS');
    expect(v.reason).toContain('all 5 invariants satisfied');
  });

  it('vetoes when no market context could be read, naming the fault', () => {
    const v = run({
      context: null,
      contextFault: { code: 'UPSTREAM_RATE_LIMITED', message: 'market_overview refused' },
    });
    expect(v.decision).toBe('VETOED');
    expect(v.failedInvariant).toBe('CONTEXT');
    expect(v.reason).toContain('UPSTREAM_RATE_LIMITED');
    expect(v.sizing).toBeNull();
  });

  it('vetoes when the market read is not status=ok', () => {
    const v = run({ context: ctx({ status: 'partial' }) });
    expect(v.failedInvariant).toBe('CONTEXT');
    expect(v.reason).toContain('partial');
  });

  it('vetoes when the market read is not live', () => {
    const v = run({ context: ctx({ dataMode: 'simulated' }) });
    expect(v.failedInvariant).toBe('CONTEXT');
    expect(v.reason).toContain('not live');
  });

  it('vetoes a stale read at 60001 ms and passes at exactly 60000 ms', () => {
    expect(run({ context: ctx({ ageMs: 60_001 }) }).failedInvariant).toBe('CONTEXT');
    expect(run({ context: ctx({ ageMs: 60_000 }) }).decision).toBe('APPROVED');
  });

  it('is NOT_EVALUATED when an earlier gate already failed', () => {
    const v = run({ latencyMs: 5_000 });
    expect(v.failedInvariant).toBe('FRESHNESS');
    expect(v.invariants.find((i) => i.id === 'CONTEXT')!.state).toBe('NOT_EVALUATED');
  });

  it('reports the empirical values it saw, so the veto is auditable from the ledger', () => {
    const gate = run({ context: ctx({ breadth: 0.42, regime: 'risk_off' }) }).invariants.find(
      (i) => i.id === 'CONTEXT',
    )!;
    expect(gate.actual).toContain('risk_off');
    expect(gate.actual).toContain('42%');
  });
});

describe('breadth clamp on sizing', () => {
  it('leaves the position untouched in a broad market', () => {
    const v = run({ context: ctx({ breadth: 0.93 }) });
    expect(v.sizing!.inputs.contextMultiplier).toBe(1);
    expect(v.sizing!.clampedBy).not.toBe('MARKET_CONTEXT');
  });

  it('shrinks the position in a narrow market and says so', () => {
    const broad = run({ context: ctx({ breadth: 0.9 }) }).sizing!;
    const narrow = run({ context: ctx({ breadth: 0.25 }) }).sizing!;
    expect(narrow.fraction).toBeLessThan(broad.fraction);
    expect(narrow.fraction).toBeCloseTo(broad.fraction * 0.5, 6);
    expect(narrow.clampedBy).toBe('MARKET_CONTEXT');
  });

  it('names the clamp in the verdict reason', () => {
    const v = run({ context: ctx({ breadth: 0.25 }) });
    expect(v.decision).toBe('APPROVED');
    expect(v.reason).toContain('breadth');
    expect(v.reason).toContain('50%');
  });

  it('never turns an approval into a zero position', () => {
    const v = run({ context: ctx({ breadth: 0 }) });
    expect(v.decision).toBe('APPROVED');
    expect(v.sizing!.positionUsd).toBeGreaterThan(0);
  });
});

/** Minimal stand-in for the interceptor: counts calls and returns what it is told to. */
function fakeRyo(handler: () => Promise<{ payload: RyoEnvelope; raw: unknown; latencyMs: number }>) {
  const state = { calls: 0 };
  const ryo = {
    call: async () => {
      state.calls += 1;
      return handler();
    },
  } as unknown as InterceptedRyo;
  return { ryo, state };
}

const okRead = async () => ({
  payload: overview(LIVE_SHAPE),
  raw: { ok: true },
  latencyMs: 12,
});

describe('market context cache', () => {
  it('serves a second evaluation without a second upstream call', async () => {
    const { ryo, state } = fakeRyo(okRead);
    const cache = new MarketContextCache(60_000);

    const first = await cache.read(ryo);
    const second = await cache.read(ryo);

    expect(state.calls).toBe(1);
    expect(first.context!.breadth).toBeCloseTo(0.9348, 6);
    expect(second.context!.breadth).toBeCloseTo(0.9348, 6);
    expect(second.cached).toBe(true);
  });

  it('refetches once the entry passes its TTL', async () => {
    const { ryo, state } = fakeRyo(okRead);
    const cache = new MarketContextCache(10);

    await cache.read(ryo);
    await new Promise((r) => setTimeout(r, 25));
    await cache.read(ryo);

    expect(state.calls).toBe(2);
  });

  /**
   * A watchlist sweep evaluates several tokens at once. Without de-duplication each one
   * issues its own identical market_overview — precisely the burst the pacer exists to
   * avoid, and the one live RYO refuses while still reporting full quota.
   */
  it('collapses concurrent misses into a single upstream call', async () => {
    const { ryo, state } = fakeRyo(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return okRead();
    });
    const cache = new MarketContextCache(60_000);

    const reads = await Promise.all([cache.read(ryo), cache.read(ryo), cache.read(ryo)]);

    expect(state.calls).toBe(1);
    expect(reads.every((r) => r.context !== null)).toBe(true);
  });

  it('reports the fault rather than serving an expired entry when the refresh fails', async () => {
    let first = true;
    const { ryo } = fakeRyo(async () => {
      if (first) {
        first = false;
        return okRead();
      }
      throw new EngineError('UPSTREAM_RATE_LIMITED', 'refused');
    });
    const cache = new MarketContextCache(10);

    expect((await cache.read(ryo)).context).not.toBeNull();
    await new Promise((r) => setTimeout(r, 25));

    const stale = await cache.read(ryo);
    expect(stale.context).toBeNull();
    expect(stale.fault!.code).toBe('UPSTREAM_RATE_LIMITED');
  });

  it('reports a fault when the payload carries no measurable breadth', async () => {
    const { ryo } = fakeRyo(async () => ({
      payload: overview({ regime: 'risk_on' }),
      raw: null,
      latencyMs: 5,
    }));
    const read = await new MarketContextCache(60_000).read(ryo);
    expect(read.context).toBeNull();
    expect(read.fault!.code).toBe('NO_CONTEXT');
  });
});
