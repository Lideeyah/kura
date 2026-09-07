import { describe, expect, it } from 'vitest';
import { SchemaMismatchError, validateToolPayload } from '../src/schema/tools.js';
import { unwrapEnvelope } from '../src/mcp/interceptor.js';

const validSafety = {
  symbol: 'SOL', address: 'So1', is_honeypot: false, can_sell: true,
  score: 96, buy_tax_bps: 0, sell_tax_bps: 0, error: null,
};

const validMarket = {
  symbol: 'SOL', address: 'So1', price_usd: 172.44, liquidity_usd: 48_200_000,
  volume_24h_usd: 91_500_000, price_change_24h: 2.13, market_cap_usd: 8e10, holders: 1_842_003,
};

describe('runtime schema validation', () => {
  it('accepts a conforming payload and returns it typed', () => {
    expect(validateToolPayload('check_safety', validSafety).is_honeypot).toBe(false);
    expect(validateToolPayload('analyze_token', validMarket).liquidity_usd).toBe(48_200_000);
  });

  it('throws SCHEMA_MISMATCH_OR_MISSING_FIELD when liquidity_usd is missing', () => {
    const { liquidity_usd, ...missing } = validMarket;
    try {
      validateToolPayload('analyze_token', missing);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SchemaMismatchError);
      const e = err as SchemaMismatchError;
      expect(e.code).toBe('SCHEMA_MISMATCH_OR_MISSING_FIELD');
      expect(e.issues.some((i) => i.path === 'liquidity_usd')).toBe(true);
    }
  });

  it('throws when is_honeypot arrives as a string instead of a boolean', () => {
    expect(() => validateToolPayload('check_safety', { ...validSafety, is_honeypot: 'false' }))
      .toThrow(/SCHEMA_MISMATCH_OR_MISSING_FIELD/);
  });

  it('treats an absent `error` key as a violation, not as "no error"', () => {
    const { error, ...withoutError } = validSafety;
    expect(() => validateToolPayload('check_safety', withoutError))
      .toThrow(/SCHEMA_MISMATCH_OR_MISSING_FIELD/);
  });

  it('never substitutes a default for a missing numeric field', () => {
    const { liquidity_usd, ...missing } = validMarket;
    let produced: unknown = 'no-value';
    try {
      produced = validateToolPayload('analyze_token', missing);
    } catch {
      /* expected */
    }
    expect(produced).toBe('no-value');
  });

  it('tolerates additive unknown fields from an evolving upstream', () => {
    const parsed = validateToolPayload('check_safety', { ...validSafety, new_upstream_field: 42 });
    expect(parsed.is_honeypot).toBe(false);
  });
});

describe('MCP envelope unwrapping', () => {
  it('prefers structuredContent', () => {
    expect(unwrapEnvelope('check_safety', { structuredContent: validSafety })).toEqual(validSafety);
  });

  it('parses concatenated text blocks', () => {
    const envelope = { content: [{ type: 'text', text: JSON.stringify(validSafety) }] };
    expect(unwrapEnvelope('check_safety', envelope)).toEqual(validSafety);
  });

  it('raises TOOL_ERROR when the peer sets isError', () => {
    expect(() => unwrapEnvelope('check_safety', { isError: true, content: [{ type: 'text', text: 'rpc down' }] }))
      .toThrow(/TOOL_ERROR/);
  });

  it('raises MALFORMED_ENVELOPE on non-JSON text', () => {
    expect(() => unwrapEnvelope('check_safety', { content: [{ type: 'text', text: 'not json' }] }))
      .toThrow(/MALFORMED_ENVELOPE/);
  });
});
