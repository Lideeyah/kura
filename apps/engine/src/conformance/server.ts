#!/usr/bin/env tsx
/**
 * RYO-CHAN conformance peer.
 *
 * A REAL MCP server — real @modelcontextprotocol/sdk, real JSON-RPC, real stdio
 * transport in a real child process. The engine talks to it exactly the way it talks
 * to the live RYO-CHAN endpoint; nothing in the client path is stubbed or bypassed.
 *
 * Its purpose is to give the arbiter, the interceptor, the ledger and the SSE bus a
 * peer that exhibits every failure mode we need to prove we handle, on demand and
 * reproducibly. Point RYO_MCP_URL at the live endpoint to run against production.
 *
 * Env knobs (used by the resilience benchmark):
 *   CONFORMANCE_BASE_LATENCY_MS  fixed think time per tool call (default 0)
 *   CONFORMANCE_EXIT_AFTER       exit(1) after N tool calls, to simulate a peer crash
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { findProfile, PROFILES, type Profile } from './fixtures.js';

const BASE_LATENCY_MS = Number(process.env.CONFORMANCE_BASE_LATENCY_MS ?? 0) || 0;
const EXIT_AFTER = Number(process.env.CONFORMANCE_EXIT_AFTER ?? 0) || 0;

let callCount = 0;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function gate(): Promise<void> {
  callCount += 1;
  if (BASE_LATENCY_MS > 0) await sleep(BASE_LATENCY_MS);
  if (EXIT_AFTER > 0 && callCount >= EXIT_AFTER) {
    process.stderr.write(`[conformance] simulated crash after ${callCount} calls\n`);
    process.exit(1);
  }
}

const json = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });

const marketCore = (p: Profile) => ({
  symbol: p.symbol,
  address: p.address,
  price_usd: p.price_usd,
  liquidity_usd: p.liquidity_usd,
  volume_24h_usd: p.volume_24h_usd,
  price_change_24h: p.price_change_24h,
});

const analyze = (p: Profile) => ({
  ...marketCore(p),
  market_cap_usd: p.market_cap_usd,
  holders: p.holders,
});

const server = new McpServer({ name: 'ryo-chan-conformance', version: '0.1.0' });

server.registerTool(
  'market_overview',
  { description: 'Aggregate market state.', inputSchema: {} },
  async () => {
    await gate();
    return json({
      total_market_cap_usd: 2_410_000_000_000,
      total_volume_24h_usd: 84_200_000_000,
      btc_dominance: 54.7,
      sentiment: 'NEUTRAL',
      updated_at: new Date().toISOString(),
    });
  },
);

server.registerTool(
  'scan_market',
  { description: 'Scan tradable pools.', inputSchema: { limit: z.number().int().min(1).max(50).optional() } },
  async ({ limit }) => {
    await gate();
    return json({
      results: PROFILES.slice(0, limit ?? PROFILES.length).map(marketCore),
      scanned_at: new Date().toISOString(),
    });
  },
);

server.registerTool(
  'analyze_token',
  { description: 'Single-token market analysis.', inputSchema: { symbol: z.string().optional(), address: z.string().optional() } },
  async ({ symbol, address }) => {
    await gate();
    return json(analyze(findProfile(symbol ?? address)));
  },
);

server.registerTool(
  'deep_analysis',
  { description: 'Contract and holder analysis.', inputSchema: { symbol: z.string().optional(), address: z.string().optional() } },
  async ({ symbol, address }) => {
    await gate();
    const p = findProfile(symbol ?? address);
    return json({
      ...marketCore(p),
      holder_concentration_top10: p.safety.is_honeypot ? 0.91 : 0.24,
      liquidity_locked_pct: p.safety.is_honeypot ? 0.0 : 0.82,
      contract_verified: !p.safety.is_honeypot,
      risk_flags: p.safety.is_honeypot ? ['HONEYPOT', 'UNLOCKED_LIQUIDITY', 'WHALE_CONCENTRATION'] : [],
    });
  },
);

server.registerTool(
  'compare_tokens',
  { description: 'Compare two or more tokens.', inputSchema: { symbols: z.array(z.string()).min(1) } },
  async ({ symbols }) => {
    await gate();
    const tokens = symbols.map((s) => analyze(findProfile(s)));
    const winner = tokens.reduce((a, b) => (b.liquidity_usd > a.liquidity_usd ? b : a));
    return json({ tokens, winner: winner.symbol });
  },
);

server.registerTool(
  'check_safety',
  { description: 'Honeypot and sellability oracle.', inputSchema: { symbol: z.string().optional(), address: z.string().optional() } },
  async ({ symbol, address }) => {
    await gate();
    const p = findProfile(symbol ?? address);
    if (p.breakSchema) {
      // Contract violation on purpose: is_honeypot arrives as a string and `error` is
      // absent entirely. The engine must raise SCHEMA_MISMATCH_OR_MISSING_FIELD.
      return json({
        symbol: p.symbol,
        address: p.address,
        is_honeypot: 'false',
        can_sell: true,
        score: 60,
        buy_tax_bps: 0,
        sell_tax_bps: 0,
      });
    }
    return json({ symbol: p.symbol, address: p.address, ...p.safety });
  },
);

server.registerTool(
  'supported_tokens',
  { description: 'Tokens this peer can price.', inputSchema: {} },
  async () => {
    await gate();
    return json({
      tokens: PROFILES.map((p) => ({ symbol: p.symbol, address: p.address, chain: p.chain })),
      count: PROFILES.length,
    });
  },
);

await server.connect(new StdioServerTransport());
process.stderr.write('[conformance] ryo-chan conformance peer ready on stdio\n');
