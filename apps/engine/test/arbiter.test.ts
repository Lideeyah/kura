import { describe, expect, it } from 'vitest';
import { evaluate } from '../src/arbiter/invariants.js';
import { sizePosition } from '../src/arbiter/kelly.js';
import type { SizingSignals } from '../src/arbiter/signals.js';
import { validateEnvelope, type RyoEnvelope } from '../src/schema/tools.js';

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

const staleAsOf = () => new Date(Date.now() - 3_600_000).toISOString();

describe('invariant arbiter', () => {
  it('APPROVES when all four gates pass, and sizes a position', () => {
    const v = evaluate({ token: 'SOL', latencyMs: 42, envelope: env(), signals: sig() });
    expect(v.decision).toBe('APPROVED');
    expect(v.failedInvariant).toBeNull();
    expect(v.invariants.every((i) => i.state === 'PASS')).toBe(true);
    expect(v.sizing!.positionUsd).toBeGreaterThan(0);
  });

  it('VETOES on FRESHNESS at 1201 ms and passes at exactly 1200 ms', () => {
    expect(
      evaluate({ token: 'SOL', latencyMs: 1201, envelope: env(), signals: sig() }).failedInvariant,
    ).toBe('FRESHNESS');
    expect(
      evaluate({ token: 'SOL', latencyMs: 1200, envelope: env(), signals: sig() }).decision,
    ).toBe('APPROVED');
  });

  it('VETOES on FRESHNESS when the observation itself is stale', () => {
    const v = evaluate({
      token: 'SOL', latencyMs: 10, envelope: env({ as_of: staleAsOf() }), signals: sig(),
    });
    expect(v.failedInvariant).toBe('FRESHNESS');
    expect(v.reason).toContain('observation');
  });

  it('VETOES on FRESHNESS when no envelope came back at all', () => {
    const v = evaluate({
      token: 'SOL', latencyMs: 10, envelope: null, signals: null,
      fault: { code: 'TRANSPORT_DROPPED', message: 'connection severed' },
    });
    expect(v.failedInvariant).toBe('FRESHNESS');
    expect(v.reason).toContain('TRANSPORT_DROPPED');
    expect(v.sizing).toBeNull();
  });

  it('VETOES on ORACLE for status "partial" — a gap is a refusal, not a degradation', () => {
    const v = evaluate({
      token: 'X', latencyMs: 10, envelope: env({ status: 'partial' }), signals: sig(),
    });
    expect(v.failedInvariant).toBe('ORACLE');
    expect(v.invariants.find((i) => i.id === 'ORACLE')!.actual).toBe('partial');
  });

  it('VETOES on ORACLE for status "unavailable"', () => {
    expect(
      evaluate({ token: 'X', latencyMs: 10, envelope: env({ status: 'unavailable' }), signals: sig() })
        .failedInvariant,
    ).toBe('ORACLE');
  });

  it('VETOES on PROVENANCE for simulated data', () => {
    const v = evaluate({
      token: 'X', latencyMs: 10, envelope: env({ data_mode: 'simulated' }), signals: sig(),
    });
    expect(v.failedInvariant).toBe('PROVENANCE');
    expect(v.reason).toContain('simulated');
    expect(v.sizing).toBeNull();
  });

  it('VETOES on PROVENANCE for mixed and unknown too — only live sizes capital', () => {
    for (const mode of ['mixed', 'unknown'] as const) {
      expect(
        evaluate({ token: 'X', latencyMs: 10, envelope: env({ data_mode: mode }), signals: sig() })
          .failedInvariant,
      ).toBe('PROVENANCE');
    }
  });

  it('VETOES on EVIDENCE when the required measurements are absent', () => {
    const v = evaluate({ token: 'X', latencyMs: 10, envelope: env(), signals: null });
    expect(v.failedInvariant).toBe('EVIDENCE');
    expect(v.sizing).toBeNull();
  });

  it('short-circuits: gates after the first failure are NOT_EVALUATED', () => {
    const v = evaluate({ token: 'X', latencyMs: 5_000, envelope: env(), signals: sig() });
    expect(v.invariants.filter((i) => i.state === 'NOT_EVALUATED').map((i) => i.id)).toEqual([
      'ORACLE',
      'PROVENANCE',
      'EVIDENCE',
    ]);
  });

  it('is a synchronous function, so it cannot await a degraded upstream', () => {
    const v = evaluate({ token: 'SOL', latencyMs: 10, envelope: env(), signals: sig() });
    expect(v).not.toBeInstanceOf(Promise);
    expect(typeof (v as unknown as { then?: unknown }).then).toBe('undefined');
  });

  it('terminates a hostile condition in well under 1 ms', () => {
    const t0 = performance.now();
    for (let i = 0; i < 1000; i += 1) {
      evaluate({
        token: 'X', latencyMs: 10, envelope: null, signals: null,
        fault: { code: 'TRANSPORT_DROPPED', message: 'severed' },
      });
    }
    expect((performance.now() - t0) / 1000).toBeLessThan(1);
  });

  it('surfaces status and data_mode on the verdict for the ledger', () => {
    const v = evaluate({ token: 'SOL', latencyMs: 10, envelope: env(), signals: sig() });
    expect(v.status).toBe('ok');
    expect(v.dataMode).toBe('live');
    expect(v.asOfAgeMs).not.toBeNull();
  });
});

describe('fractional Kelly sizing', () => {
  it('is deterministic — identical inputs give identical sizes', () => {
    expect(sizePosition(sig())).toEqual(sizePosition(sig()));
  });

  it('sizes smaller as volatility rises', () => {
    const calm = sizePosition(sig({ atrPct: 0.01 }));
    const wild = sizePosition(sig({ atrPct: 0.12 }));
    expect(calm.fraction).toBeGreaterThan(wild.fraction);
  });

  it('sizes smaller when evidence is less complete', () => {
    const full = sizePosition(sig({ atrPct: 0.05, completeness: 1 }));
    const thin = sizePosition(sig({ atrPct: 0.05, completeness: 0.4 }));
    expect(full.fraction).toBeGreaterThan(thin.fraction);
  });

  it('treats an undeclarable availability map as zero confidence, not full confidence', () => {
    const declared = sizePosition(sig({ completeness: 1 }));
    const nullish = sizePosition(sig({ completeness: null }));
    expect(nullish.fraction).toBeLessThan(declared.fraction);
  });

  it('never exceeds the per-position ceiling', () => {
    const s = sizePosition(sig({ atrPct: 0, completeness: 1 }));
    expect(s.fraction).toBeLessThanOrEqual(0.05);
    expect(s.clampedBy).toBe('MAX_POSITION_PCT');
  });

  it('sizes exactly zero at zero confidence, because p is anchored at break-even', () => {
    const s = sizePosition(sig({ atrPct: 0.15, completeness: 0 }));
    expect(s.inputs.confidence).toBe(0);
    expect(s.p).toBe(s.pBreakEven);
    expect(s.fullKelly).toBe(0);
    expect(s.positionUsd).toBe(0);
    expect(s.clampedBy).toBe('NON_POSITIVE_EDGE');
  });
});

describe('hyper-volatility refusal and the illustrative framing', () => {
  it('refuses to size at all at or above the hyper-volatility threshold', () => {
    const s = sizePosition(sig({ atrPct: 0.5, completeness: 1 }));
    expect(s.clampedBy).toBe('HYPER_VOLATILITY');
    expect(s.fraction).toBe(0);
    expect(s.positionUsd).toBe(0);
    expect(s.pctOfCap).toBe(0);
  });

  it('no longer treats a 500%-ATR asset the same as a 15% one', () => {
    // The bug this closes: volatilityScore floors at zero at maxAtrPct, so without an
    // explicit cutoff every asset beyond it sized identically — the model going blind
    // exactly where the risk is most extreme.
    const at15 = sizePosition(sig({ atrPct: 0.15, completeness: 1 }));
    const at500 = sizePosition(sig({ atrPct: 5.0, completeness: 1 }));
    expect(at15.positionUsd).toBeGreaterThan(0);
    expect(at500.positionUsd).toBe(0);
    expect(at500.clampedBy).toBe('HYPER_VOLATILITY');
  });

  it('reports allocation as a percentage of the hard cap', () => {
    const capped = sizePosition(sig({ atrPct: 0.005, completeness: 1 }));
    expect(capped.clampedBy).toBe('MAX_POSITION_PCT');
    expect(capped.pctOfCap).toBe(100);

    const partial = sizePosition(sig({ atrPct: 0.1, completeness: 1 }));
    expect(partial.pctOfCap).toBeGreaterThan(0);
    expect(partial.pctOfCap).toBeLessThan(100);
  });

  it('stays monotonic: more volatility never earns a bigger allocation', () => {
    let previous = Number.POSITIVE_INFINITY;
    for (const atrPct of [0.01, 0.03, 0.05, 0.08, 0.12, 0.15, 0.3, 0.49, 0.5, 1.0]) {
      const s = sizePosition(sig({ atrPct, completeness: 1 }));
      expect(s.fraction).toBeLessThanOrEqual(previous);
      previous = s.fraction;
    }
    expect(previous).toBe(0);
  });
});

describe('fault attribution on a slow round-trip', () => {
  it('names the underlying fault when latency breached because of one', () => {
    const v = evaluate({
      token: 'SOL', latencyMs: 2004, envelope: null, signals: null,
      fault: { code: 'UPSTREAM_RATE_LIMITED', message: 'retry budget exhausted' },
    });
    expect(v.failedInvariant).toBe('FRESHNESS');
    expect(v.reason).toContain('UPSTREAM_RATE_LIMITED');
  });

  it('reports a plain breach when latency was slow for no attributable reason', () => {
    const v = evaluate({ token: 'SOL', latencyMs: 2004, envelope: env(), signals: sig() });
    expect(v.reason).toContain('FRESHNESS breached');
    expect(v.reason).not.toContain('(');
  });
});
