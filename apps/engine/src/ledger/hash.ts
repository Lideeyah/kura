import { createHash } from 'node:crypto';

/**
 * Deterministic JSON serialization: object keys sorted lexicographically at every
 * depth, array order preserved, `undefined` dropped from objects and encoded as
 * `null` inside arrays. Two structurally identical payloads always produce the same
 * string, so they always produce the same SHA-256.
 *
 * This must stay byte-identical to `canonical_json()` in
 * skills/verify_provenance/tool.py — the independent verifier depends on it.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map((v) => (v === undefined ? null : canonicalize(v)));
  if (typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const v = source[key];
      if (v === undefined) continue;
      out[key] = canonicalize(v);
    }
    return out;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error(`CANONICAL_JSON_NON_FINITE: cannot hash non-finite number ${String(value)}`);
  }
  return value;
}

export function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export function payloadHash(rawPayload: unknown): string {
  return sha256(canonicalJson(rawPayload));
}

/** H_n = SHA256( H_{n-1} : payloadHash : timestamp : decision ) */
export function blockHash(args: {
  prevBlockHash: string;
  payloadHash: string;
  timestamp: string;
  decision: string;
}): string {
  return sha256(`${args.prevBlockHash}:${args.payloadHash}:${args.timestamp}:${args.decision}`);
}
