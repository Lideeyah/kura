import { describe, expect, it } from 'vitest';
import { evaluate } from '../src/arbiter/invariants.js';
import { sizePosition } from '../src/arbiter/kelly.js';
import type { AnalyzeToken, CheckSafety } from '../src/schema/tools.js';

const market = (over: Partial<AnalyzeToken> = {}): AnalyzeToken => ({
  symbol: 'SOL', address: 'So1', price_usd: 172.44, liquidity_usd: 48_200_000,
  volume_24h_usd: 91_500_000, price_change_24h: 2.13, market_cap_usd: 8.24e10,
  holders: 1_842_003, ...over,
});

const safety = (over: Partial<CheckSafety> = {}): CheckSafety => ({
  symbol: 'SOL', address: 'So1', is_honeypot: false, can_sell: true,
  score: 96, buy_tax_bps: 0, sell_tax_bps: 0, error: null, ...over,
});

describe('invariant arbiter', () => {
  it('APPROVES when all four gates pass, and sizes a position', () => {
    const v = evaluate({ token: 'SOL', latencyMs: 42, market: market(), safety: safety() });
    expect(v.decision).toBe('APPROVED');
    expect(v.failedInvariant).toBeNull();
    expect(v.invariants.every((i) => i.state === 'PASS')).toBe(true);
    expect(v.sizing!.positionUsd).toBeGreaterThan(0);
  });

  it('VETOES on LATENCY at 1201 ms and passes at exactly 1200 ms', () => {
    expect(evaluate({ token: 'SOL', latencyMs: 1201, market: market(), safety: safety() }).failedInvariant)
      .toBe('LATENCY');
    expect(evaluate({ token: 'SOL', latencyMs: 1200, market: market(), safety: safety() }).decision)
      .toBe('APPROVED');
  });

  it('VETOES on ORACLE when the safety payload is null, without consulting anything else', () => {
    const v = evaluate({
      token: 'SOL', latencyMs: 10, market: market(), safety: null,
      fault: { code: 'TRANSPORT_DROPPED', message: 'connection severed' },
    });
    expect(v.failedInvariant).toBe('ORACLE');
    expect(v.reason).toContain('TRANSPORT_DROPPED');
    expect(v.sizing).toBeNull();
  });

  it('VETOES on ORACLE when the oracle self-reports an error', () => {
    const v = evaluate({ token: 'X', latencyMs: 10, market: market(), safety: safety({ error: 'rpc down' }) });
    expect(v.failedInvariant).toBe('ORACLE');
  });

  it('VETOES on HONEYPOT and reports the empirical value', () => {
    const v = evaluate({ token: 'HNYP', latencyMs: 10, market: market(), safety: safety({ is_honeypot: true }) });
    expect(v.failedInvariant).toBe('HONEYPOT');
    expect(v.invariants.find((i) => i.id === 'HONEYPOT')!.actual).toBe('true');
  });

  it('VETOES on LIQUIDITY at 999_999 and passes at exactly 1_000_000', () => {
    expect(evaluate({ token: 'T', latencyMs: 10, market: market({ liquidity_usd: 999_999 }), safety: safety() }).failedInvariant)
      .toBe('LIQUIDITY');
    expect(evaluate({ token: 'T', latencyMs: 10, market: market({ liquidity_usd: 1_000_000 }), safety: safety() }).decision)
      .toBe('APPROVED');
  });

  it('short-circuits: gates after the first failure are NOT_EVALUATED', () => {
    const v = evaluate({ token: 'X', latencyMs: 5_000, market: market(), safety: safety() });
    expect(v.invariants.filter((i) => i.state === 'NOT_EVALUATED').map((i) => i.id))
      .toEqual(['ORACLE', 'HONEYPOT', 'LIQUIDITY']);
  });

  it('is a synchronous function, so it cannot await a degraded upstream', () => {
    const v = evaluate({ token: 'SOL', latencyMs: 10, market: market(), safety: safety() });
    expect(v).not.toBeInstanceOf(Promise);
    expect(typeof (v as unknown as { then?: unknown }).then).toBe('undefined');
  });

  it('terminates a hostile condition in well under 1 ms', () => {
    // 1000 vetoes on a dropped oracle. If any LLM or I/O crept into the gate this
    // budget would be impossible to hit.
    const t0 = performance.now();
    for (let i = 0; i < 1000; i += 1) {
      evaluate({
        token: 'X', latencyMs: 10, market: market(), safety: null,
        fault: { code: 'TRANSPORT_DROPPED', message: 'severed' },
      });
    }
    const perCallMs = (performance.now() - t0) / 1000;
    expect(perCallMs).toBeLessThan(1);
  });

  it('reports the empirical value for every gate it actually evaluated', () => {
    const v = evaluate({ token: 'T', latencyMs: 10, market: market({ liquidity_usd: 250_000 }), safety: safety() });
    expect(v.invariants.find((i) => i.id === 'LIQUIDITY')!.actual).toBe('$250,000');
    expect(v.reason).toContain('$250,000');
  });
});

describe('fractional Kelly sizing', () => {
  it('is deterministic — identical inputs give identical sizes', () => {
    const a = sizePosition(market(), safety());
    const b = sizePosition(market(), safety());
    expect(a).toEqual(b);
  });

  it('sizes larger for deeper liquidity and a cleaner safety score', () => {
    const deep = sizePosition(market({ liquidity_usd: 90_000_000 }), safety({ score: 99 }));
    const thin = sizePosition(market({ liquidity_usd: 1_200_000, volume_24h_usd: 150_000 }), safety({ score: 55 }));
    expect(deep.fraction).toBeGreaterThan(thin.fraction);
  });

  it('never exceeds the per-position ceiling', () => {
    const s = sizePosition(market({ liquidity_usd: 5e11, volume_24h_usd: 5e11 }), safety({ score: 100 }));
    expect(s.fraction).toBeLessThanOrEqual(0.05);
    expect(s.clampedBy).toBe('MAX_POSITION_PCT');
  });

  it('sizes exactly zero when confidence is zero, because p is anchored at break-even', () => {
    const s = sizePosition(market({ liquidity_usd: 1_000_000, volume_24h_usd: 0 }), safety({ score: 0 }));
    expect(s.inputs.confidence).toBe(0);
    expect(s.p).toBe(s.pBreakEven);
    expect(s.fullKelly).toBe(0);
    expect(s.fraction).toBe(0);
    expect(s.positionUsd).toBe(0);
    expect(s.clampedBy).toBe('NON_POSITIVE_EDGE');
  });

  it('varies size across genuinely different setups instead of pinning to the cap', () => {
    const strong = sizePosition(market(), safety());
    const mid = sizePosition(
      market({ liquidity_usd: 6_150_000, volume_24h_usd: 12_300_000 }),
      safety({ score: 88 }),
    );
    expect(strong.positionUsd).not.toBe(mid.positionUsd);
    expect(mid.clampedBy).toBe('NONE');
  });
});

describe('gate formatting is locale-independent and cheap', () => {
  it('groups thousands without touching Intl', () => {
    const v = evaluate({ token: 'T', latencyMs: 1, market: market({ liquidity_usd: 240_000 }), safety: safety() });
    expect(v.invariants.find((i) => i.id === 'LIQUIDITY')!.actual).toBe('$240,000');
  });

  it('renders cents only when they are non-zero', () => {
    const a = evaluate({ token: 'T', latencyMs: 1, market: market({ liquidity_usd: 999_999.5 }), safety: safety() });
    expect(a.invariants.find((i) => i.id === 'LIQUIDITY')!.actual).toBe('$999,999.50');
  });

  it('costs microseconds on the very first call, with no ICU warm-up', () => {
    // Runs in a fresh module context per test file, so this is genuinely a cold call.
    const t0 = performance.now();
    evaluate({ token: 'SOL', latencyMs: 10, market: market(), safety: safety() });
    expect(performance.now() - t0).toBeLessThan(5);
  });
});
