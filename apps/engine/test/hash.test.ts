import { describe, expect, it } from 'vitest';
import { blockHash, canonicalJson, payloadHash, sha256 } from '../src/ledger/hash.js';

describe('canonical JSON', () => {
  it('sorts object keys at every depth', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it('is stable across key insertion order', () => {
    const a = { liquidity_usd: 1, safety: { error: null, is_honeypot: false } };
    const b = { safety: { is_honeypot: false, error: null }, liquidity_usd: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(payloadHash(a)).toBe(payloadHash(b));
  });

  it('preserves array order', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
  });

  it('refuses to hash a non-finite number rather than coercing it', () => {
    expect(() => canonicalJson({ x: Number.NaN })).toThrow(/CANONICAL_JSON_NON_FINITE/);
  });
});

describe('hash chain primitives', () => {
  it('matches the documented SHA-256 of a known string', () => {
    expect(sha256('kura')).toHaveLength(64);
    expect(sha256('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('changes the block hash when any component changes', () => {
    const base = { prevBlockHash: 'a'.repeat(64), payloadHash: 'b'.repeat(64), timestamp: 't', decision: 'APPROVED' };
    const h = blockHash(base);
    expect(blockHash({ ...base, decision: 'VETOED' })).not.toBe(h);
    expect(blockHash({ ...base, timestamp: 't2' })).not.toBe(h);
    expect(blockHash({ ...base, payloadHash: 'c'.repeat(64) })).not.toBe(h);
    expect(blockHash({ ...base, prevBlockHash: 'd'.repeat(64) })).not.toBe(h);
  });
});
