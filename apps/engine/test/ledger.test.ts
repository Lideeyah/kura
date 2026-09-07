import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FlightRecorder } from '../src/ledger/ledger.js';
import { GENESIS_HASH } from '../src/config.js';
import { blockHash, payloadHash } from '../src/ledger/hash.js';

let dir: string;
let ledger: FlightRecorder;

const append = (n: number, decision: 'APPROVED' | 'VETOED' = 'VETOED') =>
  ledger.append({
    token: `T${n}`,
    decision,
    reason: `reason ${n}`,
    latencyMs: n,
    positionUsd: decision === 'APPROVED' ? 1000 : 0,
    invariants: [{ id: 'LATENCY', state: 'PASS' }],
    rawPayload: { n, nested: { b: 2, a: 1 }, list: [3, 1, 2] },
  });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kura-ledger-'));
  ledger = new FlightRecorder(join(dir, 'test.db'));
});

afterEach(() => {
  ledger.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('flight recorder', () => {
  it('opens the database in WAL mode', () => {
    expect(ledger.journalMode).toBe('wal');
  });

  it('links the genesis block from a 64-zero string', () => {
    const first = append(1);
    expect(first.prev_block_hash).toBe(GENESIS_HASH);
    expect(GENESIS_HASH).toHaveLength(64);
    expect(first.seq).toBe(1);
  });

  it('chains each block to its predecessor', () => {
    const a = append(1);
    const b = append(2);
    const c = append(3);
    expect(b.prev_block_hash).toBe(a.block_hash);
    expect(c.prev_block_hash).toBe(b.block_hash);
  });

  it('computes block_hash as SHA256(prev : payloadHash : timestamp : decision)', () => {
    const r = append(1, 'APPROVED');
    expect(r.block_hash).toBe(
      blockHash({
        prevBlockHash: r.prev_block_hash,
        payloadHash: r.payload_hash,
        timestamp: r.timestamp,
        decision: r.decision,
      }),
    );
  });

  it('computes payload_hash over the canonical form of the raw payload', () => {
    const r = append(7);
    expect(r.payload_hash).toBe(payloadHash(JSON.parse(r.raw_payload_json)));
  });

  it('verifies an intact chain', () => {
    for (let i = 1; i <= 20; i += 1) append(i, i % 3 === 0 ? 'APPROVED' : 'VETOED');
    const chain = ledger.verifyChain();
    expect(chain).toMatchObject({ valid: true, length: 20, brokenAtSeq: null });
  });

  it('detects a tampered payload and names the failure', () => {
    append(1);
    const target = append(2);
    append(3);

    ledger.__tamper(target.receipt_id, { n: 2, nested: { b: 2, a: 1 }, list: [3, 1, 999] });

    const single = ledger.verify(target.receipt_id);
    expect(single.valid).toBe(false);
    expect(single.failures).toContain('PAYLOAD_HASH_MISMATCH');
    expect(single.failures).toContain('BLOCK_HASH_MISMATCH');
    expect(single.recomputed_payload_hash).not.toBe(single.stored_payload_hash);

    const chain = ledger.verifyChain();
    expect(chain.valid).toBe(false);
    expect(chain.brokenAtSeq).toBe(target.seq);
  });

  it('still verifies the blocks either side of a tampered one', () => {
    const before = append(1);
    const target = append(2);
    const after = append(3);
    ledger.__tamper(target.receipt_id, { tampered: true });
    expect(ledger.verify(before.receipt_id).valid).toBe(true);
    // `after` still hashes correctly on its own — the break shows up as a chain walk
    // failure at `target`, which is exactly what a Merkle-style link is for.
    expect(ledger.verify(after.receipt_id).valid).toBe(true);
    expect(ledger.verifyChain().brokenAtSeq).toBe(target.seq);
  });

  it('reports RECEIPT_NOT_FOUND for an unknown id', () => {
    const result = ledger.verify('00000000-0000-0000-0000-000000000000');
    expect(result.valid).toBe(false);
    expect(result.failures).toEqual(['RECEIPT_NOT_FOUND']);
  });

  it('assigns a unique receipt id and block hash to every append', () => {
    const rows = Array.from({ length: 50 }, (_, i) => append(i));
    expect(new Set(rows.map((r) => r.receipt_id)).size).toBe(50);
    expect(new Set(rows.map((r) => r.block_hash)).size).toBe(50);
  });

  it('verifies a single receipt in well under 5 ms', () => {
    for (let i = 1; i <= 50; i += 1) append(i);
    const head = ledger.head()!;
    const t0 = performance.now();
    for (let i = 0; i < 20; i += 1) ledger.verify(head.receipt_id);
    expect((performance.now() - t0) / 20).toBeLessThan(5);
  });
});
