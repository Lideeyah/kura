/**
 * Cross-language provenance: the Python verifier and the TypeScript engine must agree
 * on every byte. They share no code, so agreement is evidence, not tautology.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { FlightRecorder } from '../src/ledger/ledger.js';
import { repoRoot } from '../src/config.js';

const TOOL = join(repoRoot, 'skills/verify_provenance/tool.py');

let dir: string;
let dbPath: string;
let ledger: FlightRecorder;

const runVerifier = (args: string[]): { code: number; json: any } => {
  try {
    const out = execFileSync('python3', [TOOL, '--db', dbPath, '--json', ...args], { encoding: 'utf8' });
    return { code: 0, json: JSON.parse(out) };
  } catch (err) {
    const e = err as { status: number; stdout: string };
    return { code: e.status, json: JSON.parse(e.stdout) };
  }
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'kura-prov-'));
  dbPath = join(dir, 'flight.db');
  ledger = new FlightRecorder(dbPath);

  // Numbers chosen to straddle every branch of the ECMAScript number-to-string
  // algorithm, including the ranges where Python's repr() disagrees with JS.
  const payloads: unknown[] = [
    { liquidity_usd: 48_200_000, price_usd: 172.44, change: -1.07 },
    { price_usd: 0.0000221, tiny: 1e-7, tinier: 1.5e-9 },
    { huge: 1e21, big: 1e20, exact: 9007199254740991 },
    { zero: 0, negZero: -0, one: 1.0, third: 1 / 3 },
    { nested: { z: [1, 2, { b: false, a: null }], a: 'ünïcødé "quoted" \n tab\t' } },
    { flags: [], empty: {}, nullish: null, t: true, f: false },
  ];
  payloads.forEach((rawPayload, i) =>
    ledger.append({
      token: `T${i}`,
      decision: i % 2 === 0 ? 'APPROVED' : 'VETOED',
      reason: 'provenance fixture',
      latencyMs: i,
      positionUsd: 0,
      invariants: [],
      rawPayload,
    }),
  );
});

afterAll(() => {
  ledger.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('verify_provenance CLI', () => {
  it('independently reproduces every hash the TypeScript engine wrote', () => {
    const { code, json } = runVerifier(['--all']);
    expect(code).toBe(0);
    expect(json.valid).toBe(true);
    expect(json.checked).toBe(6);
    for (const r of json.results) {
      expect(r.recomputed_payload_hash).toBe(r.stored_payload_hash);
      expect(r.recomputed_block_hash).toBe(r.stored_block_hash);
    }
  });

  it('agrees with the engine on small numbers, where Python repr() would not', () => {
    // 0.0000221 is 'JSON.stringify' -> "0.0000221" but Python repr -> '2.21e-05'.
    // If the ECMAScript port were wrong, this block alone would fail to verify.
    const { json } = runVerifier(['--all']);
    const smallNumberBlock = json.results.find((r: any) => r.seq === 2);
    expect(smallNumberBlock.valid).toBe(true);
  });

  it('verifies a single receipt in under 5 ms', () => {
    const head = ledger.head()!;
    const { code, json } = runVerifier(['--receipt', head.receipt_id]);
    expect(code).toBe(0);
    expect(json.valid).toBe(true);
    expect(json.elapsed_ms).toBeLessThan(5);
  });

  it('exits non-zero and names the break when a payload is altered on disk', () => {
    const target = ledger.list(10)[2]!;
    const db = new Database(dbPath);
    db.prepare('UPDATE ledger SET raw_payload_json = ? WHERE receipt_id = ?')
      .run(JSON.stringify({ forged: true }), target.receipt_id);
    db.close();

    const { code, json } = runVerifier(['--all']);
    expect(code).toBe(1);
    expect(json.valid).toBe(false);
    const broken = json.results.find((r: any) => r.receipt_id === target.receipt_id);
    expect(broken.failures).toContain('PAYLOAD_HASH_MISMATCH');
    expect(broken.failures).toContain('BLOCK_HASH_MISMATCH');
    // Every other block still verifies — the break is localised and provable.
    expect(json.results.filter((r: any) => r.valid)).toHaveLength(5);
  });

  it('reports RECEIPT_NOT_FOUND and exits non-zero for an unknown id', () => {
    const { code, json } = runVerifier(['--receipt', 'does-not-exist']);
    expect(code).toBe(1);
    expect(json.failures).toEqual(['RECEIPT_NOT_FOUND']);
  });
});
