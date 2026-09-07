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
