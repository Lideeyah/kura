/**
 * Step 2 of the user flow, executed rather than described.
 *
 * A real @modelcontextprotocol/sdk Client connects over real Streamable HTTP to
 * KURA's own /mcp endpoint — the same way Claude Desktop, Cursor, or an autonomous
 * loop would after registering the gateway in its config. Behind that endpoint the
 * engine is simultaneously an MCP *client* to the upstream peer over stdio.
 *
 * So this exercises the full gateway shape: agent → MCP → KURA → MCP → RYO-CHAN.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Supervisor } from '../src/supervisor.js';
import { buildServer } from '../src/server.js';
import { repoRoot } from '../src/config.js';
import type { FastifyInstance } from 'fastify';

let dir: string;
let sup: Supervisor;
let app: FastifyInstance;
let base: string;
let agent: Client;

/** Tool results come back as JSON in a text block, exactly as an agent would see them. */
async function callJson(name: string, args: Record<string, unknown> = {}): Promise<any> {
  const res: any = await agent.callTool({ name, arguments: args });
  const text = (res.content ?? [])
    .filter((c: any) => c.type === 'text')
    .map((c: any) => c.text)
    .join('');
  // Error results carry a plain-text code, not JSON, so parsing is best-effort.
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  return { parsed, isError: res.isError === true, text };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kura-gateway-'));
  sup = new Supervisor(
    {
      transport: 'stdio',
      command: 'npx',
      args: ['tsx', join(repoRoot, 'apps/engine/src/conformance/server.ts')],
    },
    join(dir, 'gateway.db'),
  );
  expect(await sup.reconnectNow()).toBe(true);

  app = buildServer(sup);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

  agent = new Client({ name: 'external-trading-agent', version: '1.0.0' }, { capabilities: {} });
  await agent.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
});

afterAll(async () => {
  await agent?.close();
  await app?.close();
  await sup?.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe('KURA as an MCP gateway', () => {
  it('an external agent can discover the gate tools over Streamable HTTP', async () => {
    const { tools } = await agent.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'chain_status',
      'evaluate_candidate',
      'gate_policy',
      'get_receipt',
      'verify_receipt',
    ]);
    // The gate is self-describing, so an agent knows the rules before it asks.
    expect(tools.find((t) => t.name === 'evaluate_candidate')!.description).toContain(
      'Never calls a language model',
    );
  });

  it('publishes the policy the agent is held to', async () => {
    const { parsed } = await callJson('gate_policy');
    expect(parsed.invariants.map((i: any) => i.id)).toEqual([
      'LATENCY',
      'ORACLE',
      'HONEYPOT',
      'LIQUIDITY',
    ]);
    expect(parsed.sizing.model).toContain('break-even');
    expect(parsed.upstream_connected).toBe(true);
  });

  it('APPROVES a clean candidate and hands back a bounded size plus a receipt', async () => {
    const { parsed } = await callJson('evaluate_candidate', { symbol: 'SOL' });
    expect(parsed.decision).toBe('APPROVED');
    expect(parsed.gates.every((g: any) => g.state === 'PASS')).toBe(true);
    expect(parsed.sizing.position_usd).toBeGreaterThan(0);
    expect(parsed.sizing.break_even_probability).toBe(0.4);
    expect(parsed.receipt.receipt_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(parsed.receipt.block_hash).toHaveLength(64);
    expect(parsed.gate_evaluation_micros).toBeLessThan(1000);
  });

  it('VETOES a thin pool through the gateway, with no size and a named gate', async () => {
    const { parsed } = await callJson('evaluate_candidate', { symbol: 'BONK' });
    expect(parsed.decision).toBe('VETOED');
    expect(parsed.failed_invariant).toBe('LIQUIDITY');
    expect(parsed.sizing).toBeNull();
    expect(parsed.gates.filter((g: any) => g.state === 'NOT_EVALUATED')).toHaveLength(0);
  });

  it('cannot be routed around: a dropped oracle vetoes rather than degrading', async () => {
    sup.chaos.set('check_safety', 'DROP');
    const { parsed } = await callJson('evaluate_candidate', { symbol: 'SOL' });
    expect(parsed.decision).toBe('VETOED');
    expect(parsed.failed_invariant).toBe('ORACLE');
    expect(parsed.reason).toContain('TRANSPORT_DROPPED');
    expect(parsed.sizing).toBeNull();
    // Downstream gates were never evaluated — the agent can see the short circuit.
    const skipped = parsed.gates.filter((g: any) => g.state === 'NOT_EVALUATED').map((g: any) => g.id);
    expect(skipped).toEqual(['HONEYPOT', 'LIQUIDITY']);

    sup.chaos.set('*', 'RESET');
    expect(await sup.reconnectNow()).toBe(true);
  });

  it('lets the agent verify any receipt it was handed', async () => {
    const { parsed: verdict } = await callJson('evaluate_candidate', { symbol: 'JUP' });
    const { parsed: verified } = await callJson('verify_receipt', {
      receipt_id: verdict.receipt.receipt_id,
    });
    expect(verified.valid).toBe(true);
    expect(verified.recomputed_block_hash).toBe(verdict.receipt.block_hash);
    expect(verified.recomputed_payload_hash).toBe(verified.stored_payload_hash);
  });

  it('returns the raw wire payload the hash actually covers', async () => {
    const { parsed: verdict } = await callJson('evaluate_candidate', { symbol: 'SOL' });
    const { parsed: receipt } = await callJson('get_receipt', {
      receipt_id: verdict.receipt.receipt_id,
    });
    expect(receipt.raw_payload.check_safety.is_honeypot).toBe(false);
    expect(receipt.raw_payload.analyze_token.liquidity_usd).toBeGreaterThan(0);
    expect(receipt.invariants).toHaveLength(4);
  });

  it('reports an unknown receipt as a tool error rather than inventing one', async () => {
    const { isError, text } = await callJson('get_receipt', { receipt_id: 'nope' });
    expect(isError).toBe(true);
    expect(text).toContain('RECEIPT_NOT_FOUND');
  });

  it('reports chain height and integrity to the agent', async () => {
    const { parsed } = await callJson('chain_status');
    expect(parsed.valid).toBe(true);
    expect(parsed.height).toBeGreaterThan(0);
    expect(parsed.journal_mode).toBe('wal');
    expect(parsed.head_block_hash).toHaveLength(64);
  });
});
