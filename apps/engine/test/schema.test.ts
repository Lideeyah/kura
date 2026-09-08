import { describe, expect, it } from 'vitest';
import {
  SchemaMismatchError,
  TOOL_NAMES,
  asOfAgeMs,
  completeness,
  validateEnvelope,
} from '../src/schema/tools.js';
import { unwrapEnvelope } from '../src/mcp/interceptor.js';
import { extractSignals, probeEvidence } from '../src/arbiter/signals.js';

const envelope = (over: Record<string, unknown> = {}) => ({
  schema_version: '1.0.0',
  tool: 'analyze_token',
  status: 'ok',
  data_mode: 'live',
  as_of: new Date().toISOString(),
  request: { symbol: 'SOL' },
  data: { symbol: 'SOL', market: { price_usd: 172.44 }, technicals: { rsi_14: 56, atr_14: 4.31 } },
  summary: { headline: 'SOL' },
  availability: { market: 'ok', technicals: 'ok' },
  warnings: [],
  ...over,
});

describe('the six published tools', () => {
  it('matches the live catalog count and names', () => {
    // The unauthenticated health endpoint reports "tools": 6.
    expect(TOOL_NAMES).toHaveLength(6);
    expect(TOOL_NAMES).toContain('monitor_market_sentiment_shift');
    // RYO publishes no symbol-only safety tool and no supported_tokens tool.
    expect(TOOL_NAMES as readonly string[]).not.toContain('check_safety');
    expect(TOOL_NAMES as readonly string[]).not.toContain('supported_tokens');
  });
});

describe('public builder envelope', () => {
  it('accepts a conforming envelope', () => {
    const parsed = validateEnvelope('analyze_token', envelope());
    expect(parsed.status).toBe('ok');
    expect(parsed.data_mode).toBe('live');
  });

  it('throws when data_mode is missing', () => {
    const { data_mode, ...without } = envelope();
    try {
      validateEnvelope('analyze_token', without);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SchemaMismatchError);
      expect((err as SchemaMismatchError).code).toBe('SCHEMA_MISMATCH_OR_MISSING_FIELD');
      expect((err as SchemaMismatchError).issues.some((i) => i.path === 'data_mode')).toBe(true);
    }
  });

  it('rejects a status outside the published set', () => {
    expect(() => validateEnvelope('analyze_token', envelope({ status: 'fine' }))).toThrow(
      /SCHEMA_MISMATCH_OR_MISSING_FIELD/,
    );
  });

  it('rejects a data_mode outside the published set', () => {
    expect(() => validateEnvelope('analyze_token', envelope({ data_mode: 'cached' }))).toThrow(
      /SCHEMA_MISMATCH_OR_MISSING_FIELD/,
    );
  });

  it('requires warnings to be present as an array, not absent', () => {
    const { warnings, ...without } = envelope();
    expect(() => validateEnvelope('analyze_token', without)).toThrow(/SCHEMA_MISMATCH/);
  });

  it('tolerates additive unknown envelope fields', () => {
    expect(validateEnvelope('analyze_token', envelope({ new_field: 1 })).status).toBe('ok');
  });

  it('never substitutes a default for a missing field', () => {
    const { as_of, ...without } = envelope();
    let produced: unknown = 'no-value';
    try {
      produced = validateEnvelope('analyze_token', without);
    } catch {
      /* expected */
    }
    expect(produced).toBe('no-value');
  });
});

describe('as_of age', () => {
  it('measures observation age in milliseconds', () => {
    const now = Date.parse('2026-09-07T12:00:00.000Z');
    expect(asOfAgeMs('2026-09-07T11:59:00.000Z', now)).toBe(60_000);
  });

  it('returns null for an unparseable timestamp rather than 0', () => {
    expect(asOfAgeMs('not-a-date')).toBeNull();
  });
});

describe('availability completeness', () => {
  it('scores the fraction of healthy sections', () => {
    expect(completeness({ a: 'ok', b: 'ok', c: 'partial', d: 'unavailable' })).toBe(0.5);
  });

  it('returns null for an empty map rather than a misleading 1.0', () => {
    expect(completeness({})).toBeNull();
  });
});

describe('signal extraction', () => {
  it('finds price and ATR wherever the catalog nests them', () => {
    const s = extractSignals(validateEnvelope('analyze_token', envelope()), 1);
    expect(s!.priceUsd).toBe(172.44);
    expect(s!.atr14).toBe(4.31);
    expect(s!.atrPct).toBeCloseTo(4.31 / 172.44, 10);
  });

  it('returns null when ATR is explicitly null, rather than coercing it to zero', () => {
    const env = validateEnvelope(
      'analyze_token',
      envelope({ data: { market: { price_usd: 10 }, technicals: { atr_14: null } } }),
    );
    expect(extractSignals(env, 1)).toBeNull();
  });

  it('returns null when price is absent', () => {
    const env = validateEnvelope('analyze_token', envelope({ data: { technicals: { atr_14: 1 } } }));
    expect(extractSignals(env, 1)).toBeNull();
  });
});

describe('MCP envelope unwrapping', () => {
  it('parses the JSON string inside the text content block', () => {
    const wire = { content: [{ type: 'text', text: JSON.stringify(envelope()) }] };
    expect((unwrapEnvelope('analyze_token', wire) as { tool: string }).tool).toBe('analyze_token');
  });

  it('raises TOOL_ERROR when the peer sets isError, per the documented contract', () => {
    expect(() =>
      unwrapEnvelope('analyze_token', { isError: true, content: [{ type: 'text', text: 'quota' }] }),
    ).toThrow(/TOOL_ERROR/);
  });

  it('raises MALFORMED_ENVELOPE on non-JSON text', () => {
    expect(() =>
      unwrapEnvelope('analyze_token', { content: [{ type: 'text', text: 'not json' }] }),
    ).toThrow(/MALFORMED_ENVELOPE/);
  });
});

describe('boot-time evidence probe', () => {
  it('reports the resolved paths when the payload is well shaped', () => {
    const p = probeEvidence(validateEnvelope('analyze_token', envelope()));
    expect(p.resolved).toBe(true);
    expect(p.pricePath).toBe('market.price_usd');
    expect(p.atrPath).toBe('technicals.atr_14');
    expect(p.detail).toContain('resolved price at data.market.price_usd');
  });

  it('resolves through a differently nested shape, which is the point of searching', () => {
    const p = probeEvidence(
      validateEnvelope(
        'analyze_token',
        envelope({ data: { a: { b: { price_usd: 1 } }, c: [{ atr_14: { value: 2 } }] } }),
      ),
    );
    expect(p.resolved).toBe(true);
    expect(p.pricePath).toBe('a.b.price_usd');
    expect(p.atrPath).toBe('c.0.atr_14.value');
  });

  it('reports unresolved paths loudly instead of failing silently', () => {
    const p = probeEvidence(
      validateEnvelope(
        'analyze_token',
        envelope({ data: { market: { mid: 10 }, technicals: { true_range_14: 1 } } }),
      ),
    );
    expect(p.resolved).toBe(false);
    expect(p.pricePath).toBeNull();
    expect(p.atrPath).toBeNull();
    expect(p.detail).toContain('could not resolve price and ATR(14)');
  });
});

describe('the real live RYO payload shape', () => {
  /**
   * Captured verbatim from https://app-ryochan.com/api/mcp on 2026-09-08 with a real
   * builder key. Pinned because the ATR field is a percentage, not an absolute — a
   * distinction that fails silently and in a price-dependent way if it is ever lost.
   */
  const live = () =>
    envelope({
      as_of: new Date().toISOString(),
      data: {
        asset: { symbol: 'SOL', name: 'Solana', chain: 'solana', rank: 5 },
        market: {
          price_usd: 102.8507617609701,
          market_cap_usd: 5.6e10,
          volume_24h_usd: 3.1e9,
        },
        performance: { change_1h_pct: 0.4, change_24h_pct: 2.1, change_7d_pct: -3.2 },
        technical_analysis: {
          trend: 'up',
          rsi_14: 63.3,
          momentum_30d_pct: 34.87106998,
          atr_14_pct: 4.23,
        },
        intelligence: { narrative: 'x', catalysts: [], risks: [] },
        verdict: 'constructive',
      },
      availability: {
        market_data: 'available',
        technical_analysis: 'available',
        market_intelligence: 'available',
      },
      warnings: [],
      summary: { headline: 'SOL', key_points: [] },
    });

  it('validates against the envelope schema unchanged', () => {
    const parsed = validateEnvelope('analyze_token', live());
    expect(parsed.status).toBe('ok');
    expect(parsed.data_mode).toBe('live');
  });

  it('resolves price and ATR at their real paths', () => {
    const p = probeEvidence(validateEnvelope('analyze_token', live()));
    expect(p.resolved).toBe(true);
    expect(p.pricePath).toBe('market.price_usd');
    expect(p.atrPath).toBe('technical_analysis.atr_14_pct');
    expect(p.atrForm).toBe('percentage');
    expect(p.rsiPath).toBe('technical_analysis.rsi_14');
  });

  it('reads atr_14_pct as a percentage, NOT as an absolute divided by price', () => {
    const s = extractSignals(validateEnvelope('analyze_token', live()), 1)!;
    // 4.23% is 0.0423. The naive reading, 4.23 / 102.85, gives 0.0411 — close enough
    // at this price to pass a careless eye, and wrong.
    expect(s.atrPct).toBeCloseTo(0.0423, 10);
    expect(s.atrPct).not.toBeCloseTo(4.23 / 102.8507617609701, 6);
  });

  it('stays correct on a low-priced asset, where the naive reading explodes', () => {
    const cheap = live();
    (cheap.data as any).market.price_usd = 0.5;
    const s = extractSignals(validateEnvelope('analyze_token', cheap), 1)!;
    // Naive would be 4.23/0.5 = 8.46 → 846% ATR → HYPER_VOLATILITY on every cheap token.
    expect(s.atrPct).toBeCloseTo(0.0423, 10);
    expect(s.atr14).toBeCloseTo(0.02115, 10);
  });

  it('still supports an absolute ATR when that is all the payload offers', () => {
    const abs = live();
    delete (abs.data as any).technical_analysis.atr_14_pct;
    (abs.data as any).technical_analysis.atr_14 = 4.31;
    const s = extractSignals(validateEnvelope('analyze_token', abs), 1)!;
    expect(s.atr14).toBe(4.31);
    expect(s.atrPct).toBeCloseTo(4.31 / 102.8507617609701, 10);
  });

  it('scores the live availability vocabulary correctly', () => {
    expect(completeness(live().availability as Record<string, unknown>)).toBe(1);
  });
});
