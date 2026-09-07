import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { GENESIS_HASH } from '../config.js';
import { blockHash, canonicalJson, payloadHash, sha256 } from './hash.js';

export type Decision = 'APPROVED' | 'VETOED';

export interface LedgerRecord {
  seq: number;
  receipt_id: string;
  timestamp: string;
  token: string;
  decision: Decision;
  reason: string;
  latency_ms: number;
  position_usd: number;
  invariants_json: string;
  raw_payload_json: string;
  payload_hash: string;
  prev_block_hash: string;
  block_hash: string;
}

export interface AppendInput {
  token: string;
  decision: Decision;
  reason: string;
  latencyMs: number;
  positionUsd: number;
  invariants: unknown;
  /** The raw wire payloads exactly as they came off the transport. */
  rawPayload: unknown;
  /** Injectable for deterministic tests. */
  timestamp?: string;
}

export type VerificationFailure =
  | 'RECEIPT_NOT_FOUND'
  | 'PAYLOAD_HASH_MISMATCH'
  | 'BLOCK_HASH_MISMATCH'
  | 'PARENT_LINK_BROKEN'
  | 'PARENT_MISSING'
  | 'RAW_PAYLOAD_UNPARSEABLE';

export interface VerificationResult {
  receipt_id: string;
  valid: boolean;
  failures: VerificationFailure[];
  seq: number | null;
  recomputed_payload_hash: string | null;
  stored_payload_hash: string | null;
  recomputed_block_hash: string | null;
  stored_block_hash: string | null;
  parent_receipt_id: string | null;
  parent_block_hash: string | null;
  stored_prev_block_hash: string | null;
  is_genesis: boolean;
  elapsed_ms: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ledger (
  seq              INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_id       TEXT    NOT NULL UNIQUE,
  timestamp        TEXT    NOT NULL,
  token            TEXT    NOT NULL,
  decision         TEXT    NOT NULL CHECK (decision IN ('APPROVED','VETOED')),
  reason           TEXT    NOT NULL,
  latency_ms       INTEGER NOT NULL,
  position_usd     REAL    NOT NULL,
  invariants_json  TEXT    NOT NULL,
  raw_payload_json TEXT    NOT NULL,
  payload_hash     TEXT    NOT NULL,
  prev_block_hash  TEXT    NOT NULL,
  block_hash       TEXT    NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_ledger_receipt ON ledger(receipt_id);
CREATE INDEX IF NOT EXISTS idx_ledger_block ON ledger(block_hash);
`;

export class FlightRecorder {
  private readonly db: Database.Database;

  constructor(path: string) {
    const abs = resolve(path);
    mkdirSync(dirname(abs), { recursive: true });
    this.db = new Database(abs);
    // Write-ahead logging: readers (the /api/ledger and /api/verify handlers) never
    // block the append path, and a crash mid-append rolls back cleanly.
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);
  }

  get journalMode(): string {
    const rows = this.db.pragma('journal_mode') as Array<{ journal_mode: string }>;
    return rows[0]?.journal_mode ?? 'unknown';
  }

  /**
   * Append one decision. better-sqlite3 is synchronous, and the head read plus the
   * insert share a single IMMEDIATE transaction, so no two blocks can ever claim the
   * same parent.
   */
  append(input: AppendInput): LedgerRecord {
    const timestamp = input.timestamp ?? new Date().toISOString();
    const receiptId = randomUUID();
    const pHash = payloadHash(input.rawPayload);
    const rawJson = JSON.stringify(input.rawPayload ?? null);
    const invariantsJson = canonicalJson(input.invariants ?? null);

    const tx = this.db.transaction((): LedgerRecord => {
      const head = this.db
        .prepare('SELECT block_hash FROM ledger ORDER BY seq DESC LIMIT 1')
        .get() as { block_hash: string } | undefined;
      const prev = head?.block_hash ?? GENESIS_HASH;
      const bHash = blockHash({
        prevBlockHash: prev,
        payloadHash: pHash,
        timestamp,
        decision: input.decision,
      });

      const info = this.db
        .prepare(
          `INSERT INTO ledger
             (receipt_id, timestamp, token, decision, reason, latency_ms, position_usd,
              invariants_json, raw_payload_json, payload_hash, prev_block_hash, block_hash)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          receiptId,
          timestamp,
          input.token,
          input.decision,
          input.reason,
          Math.round(input.latencyMs),
          input.positionUsd,
          invariantsJson,
          rawJson,
          pHash,
          prev,
          bHash,
        );

      return {
        seq: Number(info.lastInsertRowid),
        receipt_id: receiptId,
        timestamp,
        token: input.token,
        decision: input.decision,
        reason: input.reason,
        latency_ms: Math.round(input.latencyMs),
        position_usd: input.positionUsd,
        invariants_json: invariantsJson,
        raw_payload_json: rawJson,
        payload_hash: pHash,
        prev_block_hash: prev,
        block_hash: bHash,
      };
    });

    return tx.immediate();
  }

  list(limit = 200, offset = 0): LedgerRecord[] {
    return this.db
      .prepare('SELECT * FROM ledger ORDER BY seq ASC LIMIT ? OFFSET ?')
      .all(limit, offset) as LedgerRecord[];
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM ledger').get() as { n: number };
    return row.n;
  }

  get(receiptId: string): LedgerRecord | undefined {
    return this.db.prepare('SELECT * FROM ledger WHERE receipt_id = ?').get(receiptId) as
      | LedgerRecord
      | undefined;
  }

  head(): LedgerRecord | undefined {
    return this.db.prepare('SELECT * FROM ledger ORDER BY seq DESC LIMIT 1').get() as
      | LedgerRecord
      | undefined;
  }

  /** Recompute both hashes from the stored raw payload and re-check the parent link. */
  verify(receiptId: string): VerificationResult {
    const started = performance.now();
    const record = this.get(receiptId);
    if (!record) {
      return {
        receipt_id: receiptId,
        valid: false,
        failures: ['RECEIPT_NOT_FOUND'],
        seq: null,
        recomputed_payload_hash: null,
        stored_payload_hash: null,
        recomputed_block_hash: null,
        stored_block_hash: null,
        parent_receipt_id: null,
        parent_block_hash: null,
        stored_prev_block_hash: null,
        is_genesis: false,
        elapsed_ms: performance.now() - started,
      };
    }

    const failures: VerificationFailure[] = [];

    let recomputedPayloadHash: string | null = null;
    try {
      recomputedPayloadHash = payloadHash(JSON.parse(record.raw_payload_json));
    } catch {
      failures.push('RAW_PAYLOAD_UNPARSEABLE');
    }
    if (recomputedPayloadHash !== null && recomputedPayloadHash !== record.payload_hash) {
      failures.push('PAYLOAD_HASH_MISMATCH');
    }

    const recomputedBlockHash = blockHash({
      prevBlockHash: record.prev_block_hash,
      payloadHash: recomputedPayloadHash ?? record.payload_hash,
      timestamp: record.timestamp,
      decision: record.decision,
    });
    if (recomputedBlockHash !== record.block_hash) failures.push('BLOCK_HASH_MISMATCH');

    const isGenesis = record.prev_block_hash === GENESIS_HASH;
    const parent = isGenesis
      ? undefined
      : (this.db.prepare('SELECT * FROM ledger WHERE seq = ?').get(record.seq - 1) as
          | LedgerRecord
          | undefined);

    if (!isGenesis) {
      if (!parent) failures.push('PARENT_MISSING');
      else if (parent.block_hash !== record.prev_block_hash) failures.push('PARENT_LINK_BROKEN');
    }

    return {
      receipt_id: receiptId,
      valid: failures.length === 0,
      failures,
      seq: record.seq,
      recomputed_payload_hash: recomputedPayloadHash,
      stored_payload_hash: record.payload_hash,
      recomputed_block_hash: recomputedBlockHash,
      stored_block_hash: record.block_hash,
      parent_receipt_id: parent?.receipt_id ?? null,
      parent_block_hash: parent?.block_hash ?? null,
      stored_prev_block_hash: record.prev_block_hash,
      is_genesis: isGenesis,
      elapsed_ms: performance.now() - started,
    };
  }

  /** Walk the whole chain from genesis. Returns the first break, if any. */
  verifyChain(): { valid: boolean; length: number; brokenAtSeq: number | null; failures: VerificationFailure[] } {
    const rows = this.db.prepare('SELECT * FROM ledger ORDER BY seq ASC').all() as LedgerRecord[];
    let prev = GENESIS_HASH;
    for (const row of rows) {
      const result = this.verify(row.receipt_id);
      if (!result.valid || row.prev_block_hash !== prev) {
        const failures = result.failures.length ? result.failures : (['PARENT_LINK_BROKEN'] as VerificationFailure[]);
        return { valid: false, length: rows.length, brokenAtSeq: row.seq, failures };
      }
      prev = row.block_hash;
    }
    return { valid: true, length: rows.length, brokenAtSeq: null, failures: [] };
  }

  /** Test-only: rewrite a stored payload to prove the chain detects tampering. */
  __tamper(receiptId: string, mutatedPayload: unknown): void {
    this.db
      .prepare('UPDATE ledger SET raw_payload_json = ? WHERE receipt_id = ?')
      .run(JSON.stringify(mutatedPayload), receiptId);
  }

  close(): void {
    this.db.close();
  }
}

export { sha256, canonicalJson, payloadHash, blockHash };
