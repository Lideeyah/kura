/**
 * End-to-end over real transport.
 *
 * Spawns the conformance MCP peer as a real child process, speaks real JSON-RPC to it
 * over real stdio, runs the real arbiter, writes the real SQLite ledger and reads the
 * real SSE stream. Nothing between the HTTP boundary and the MCP peer is stubbed.
 *
 * The headline assertion the handoff spec asks for: dropping a tool through the chaos
 * API must (a) veto, (b) commit a block to SQLite, and (c) stream the VETO to a
 * connected client.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Supervisor } from '../src/supervisor.js';
import { buildServer } from '../src/server.js';
import { repoRoot } from '../src/config.js';
import type { FastifyInstance } from 'fastify';

let dir: string;
let dbPath: string;
let sup: Supervisor;
let app: FastifyInstance;
let base: string;

/** Collects SSE events off a live /api/stream connection for later assertions. */
class StreamTap {
  readonly events: Array<{ type: string; data: any }> = [];
  private controller = new AbortController();
  private done!: Promise<void>;

  async open(url: string): Promise<void> {
    const res = await fetch(url, { signal: this.controller.signal });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    this.done = (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const type = /^event: (.+)$/m.exec(frame)?.[1];
            const data = /^data: (.+)$/m.exec(frame)?.[1];
            if (type && data) this.events.push({ type, data: JSON.parse(data) });
          }
        }
      } catch {
        /* aborted on teardown */
      }
    })();
  }

  of(type: string) {
    return this.events.filter((e) => e.type === type).map((e) => e.data);
  }

  async waitFor(predicate: (e: { type: string; data: any }) => boolean, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hit = this.events.find(predicate);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('timed out waiting for SSE event');
  }

  close() {
    this.controller.abort();
  }
}

let tap: StreamTap;

/** `Response.json()` is typed `unknown`; these assertions probe shapes deliberately. */
const jsonOf = (r: Response): Promise<any> => r.json() as Promise<any>;

const getJson = (path: string) => fetch(`${base}${path}`).then(jsonOf);

const post = (path: string, body: unknown) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kura-e2e-'));
  dbPath = join(dir, 'flight.db');
  sup = new Supervisor(
    {
      transport: 'stdio',
      command: 'npx',
      args: ['tsx', join(repoRoot, 'apps/engine/src/conformance/server.ts')],
    },
    dbPath,
  );
  const connected = await sup.reconnectNow();
  expect(connected).toBe(true);

  app = buildServer(sup);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

  tap = new StreamTap();
  await tap.open(`${base}/api/stream`);
});

afterAll(async () => {
  tap?.close();
  await app?.close();
  await sup?.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe('live transport', () => {
  it('connects to the MCP peer and discovers all 7 tools', async () => {
    const tools = await sup.client.listTools();
    expect(tools.sort()).toEqual(
      [
        'analyze_token', 'check_safety', 'compare_tokens', 'deep_analysis',
        'market_overview', 'scan_market', 'supported_tokens',
      ].sort(),
    );
  });

  it('reports WAL journalling and a live connection over /api/health', async () => {
    const health = await getJson('/api/health');
    expect(health.connected).toBe(true);
    expect(health.journal_mode).toBe('wal');
  });

  it('pulses every tool through the interceptor and out to the stream', async () => {
    await sup.pulseAll();
    const tools = new Set(tap.of('tool_pulse').map((p: any) => p.pulse.tool));
    expect(tools.size).toBe(7);
  });
});

describe('happy path', () => {
  it('APPROVES a clean, deep token and sizes a position', async () => {
    const res = await post('/api/evaluate', { symbol: 'SOL' }).then(jsonOf);
    expect(res.verdict.decision).toBe('APPROVED');
    expect(res.verdict.invariants.every((i: any) => i.state === 'PASS')).toBe(true);
    expect(res.verdict.sizing.positionUsd).toBeGreaterThan(0);
    expect(res.record.position_usd).toBe(res.verdict.sizing.positionUsd);
  });

  it('changes the outcome based on the data, not on a fixed script', async () => {
    const bonk = await post('/api/evaluate', { symbol: 'BONK' }).then(jsonOf);
    expect(bonk.verdict.decision).toBe('VETOED');
    expect(bonk.verdict.failedInvariant).toBe('LIQUIDITY');
    expect(bonk.record.position_usd).toBe(0);

    const hnyp = await post('/api/evaluate', { symbol: 'HNYP' }).then(jsonOf);
    expect(hnyp.verdict.failedInvariant).toBe('HONEYPOT');
  });

  it('raises SCHEMA_MISMATCH_OR_MISSING_FIELD on a contract-breaking payload', async () => {
    const res = await post('/api/evaluate', { symbol: 'BADS' }).then(jsonOf);
    expect(res.verdict.decision).toBe('VETOED');
    expect(res.verdict.reason).toContain('SCHEMA_MISMATCH_OR_MISSING_FIELD');
    expect(res.verdict.failedInvariant).toBe('ORACLE');
  });
});

describe('chaos: a dropped tool vetoes, commits to SQLite, and streams', () => {
  it('drops check_safety, vetoes, writes the block, and pushes it down the stream', async () => {
    const before = new Database(dbPath, { readonly: true })
      .prepare('SELECT COUNT(*) AS n FROM ledger')
      .get() as { n: number };

    const toggled = await post('/api/chaos/toggle', { tool: 'check_safety', action: 'DROP' }).then(jsonOf);
    expect(toggled.chaos).toEqual([{ tool: 'check_safety', action: 'DROP' }]);

    const res = await post('/api/evaluate', { symbol: 'SOL' }).then(jsonOf);

    // (a) the arbiter vetoed, deterministically and without an LLM in the path
    expect(res.verdict.decision).toBe('VETOED');
    expect(res.verdict.failedInvariant).toBe('ORACLE');
    expect(res.verdict.reason).toContain('TRANSPORT_DROPPED');
    expect(res.verdict.sizing).toBeNull();
    expect(res.verdict.evaluationMicros).toBeLessThan(1000);

    // (b) the decision is committed to the SQLite ledger and chained
    const db = new Database(dbPath, { readonly: true });
    const after = db.prepare('SELECT COUNT(*) AS n FROM ledger').get() as { n: number };
    expect(after.n).toBe(before.n + 1);
    const row = db.prepare('SELECT * FROM ledger WHERE receipt_id = ?').get(res.record.receipt_id) as any;
    expect(row).toBeTruthy();
    expect(row.decision).toBe('VETOED');
    expect(JSON.parse(row.raw_payload_json).fault.code).toBe('TRANSPORT_DROPPED');
    const parent = db.prepare('SELECT * FROM ledger WHERE seq = ?').get(row.seq - 1) as any;
    expect(row.prev_block_hash).toBe(parent.block_hash);
    db.close();

    // (c) the VETO reached a connected SSE client
    const streamed = await tap.waitFor(
      (e) => e.type === 'ledger' && e.data.record.receipt_id === res.record.receipt_id,
    );
    expect(streamed.data.record.decision).toBe('VETOED');
    const verdictEvent = await tap.waitFor(
      (e) => e.type === 'verdict' && e.data.verdict.reason.includes('TRANSPORT_DROPPED'),
    );
    expect(verdictEvent.data.verdict.decision).toBe('VETOED');
    const pulse = tap.of('tool_pulse').find((p: any) => p.pulse.status === 'DROPPED');
    expect(pulse.pulse.tool).toBe('check_safety');

    // and the committed block verifies cryptographically
    const verified = await post('/api/verify', { receipt_id: res.record.receipt_id }).then(jsonOf);
    expect(verified.valid).toBe(true);
    expect(verified.recomputed_block_hash).toBe(verified.stored_block_hash);
  });

  it('recovers: after RESET and reconnect, the same token is APPROVED again', async () => {
    await post('/api/chaos/toggle', { tool: '*', action: 'RESET' });
    expect(await sup.reconnectNow()).toBe(true);
    const res = await post('/api/evaluate', { symbol: 'SOL' }).then(jsonOf);
    expect(res.verdict.decision).toBe('APPROVED');
  });

  it('trips the LATENCY gate under an injected delay', async () => {
    await post('/api/chaos/toggle', { tool: 'analyze_token', action: 'DELAY', delayMs: 1400 });
    const res = await post('/api/evaluate', { symbol: 'SOL' }).then(jsonOf);
    expect(res.verdict.decision).toBe('VETOED');
    expect(res.verdict.failedInvariant).toBe('LATENCY');
    expect(res.verdict.latencyMs).toBeGreaterThan(1200);
    expect(res.verdict.invariants.filter((i: any) => i.state === 'NOT_EVALUATED')).toHaveLength(3);
    await post('/api/chaos/toggle', { tool: '*', action: 'RESET' });
  });

  it('rejects malformed chaos instructions instead of silently ignoring them', async () => {
    expect((await post('/api/chaos/toggle', { tool: 'nope', action: 'DROP' })).status).toBe(400);
    expect((await post('/api/chaos/toggle', { tool: '*', action: 'EXPLODE' })).status).toBe(400);
    expect((await post('/api/chaos/toggle', { tool: '*', action: 'DELAY' })).status).toBe(400);
  });
});

describe('ledger API', () => {
  it('returns the chain in chronological order', async () => {
    const res = await getJson('/api/ledger');
    const seqs = res.records.map((r: any) => r.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(res.count).toBe(res.records.length);
  });

  it('verifies the whole chain', async () => {
    const chain = await getJson('/api/verify/chain');
    expect(chain.valid).toBe(true);
    expect(chain.length).toBeGreaterThan(5);
  });

  it('returns 409 and a named failure for a receipt that does not exist', async () => {
    const res = await post('/api/verify', { receipt_id: 'nope' });
    expect(res.status).toBe(409);
    expect((await jsonOf(res)).failures).toEqual(['RECEIPT_NOT_FOUND']);
  });
});
