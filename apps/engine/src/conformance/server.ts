#!/usr/bin/env tsx
/**
 * RYO-CHAN conformance peer.
 *
 * A REAL MCP server — real @modelcontextprotocol/sdk, real JSON-RPC, real stdio
 * transport in a real child process — publishing the same six tools and the same
 * public builder envelope as the live endpoint. The engine talks to it exactly the way
 * it talks to production; nothing in the client path is stubbed or bypassed.
 *
 * Its purpose is to give the arbiter, the interceptor, the ledger and the SSE bus a
 * peer that exhibits every failure mode we need to prove we handle, on demand and
 * without spending metered quota. Point RYO_MCP_URL at the live endpoint to run
 * against production.
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
const SCHEMA_VERSION = '1.0.0';

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

/** Wrap tool-specific evidence in the public builder envelope. */
function envelope(
  tool: string,
  request: Record<string, unknown>,
  data: Record<string, unknown>,
  opts: {
    status?: Profile['status'];
    dataMode?: Profile['dataMode'];
    asOfAgeSec?: number;
    availability?: Record<string, string>;
    warnings?: string[];
    headline?: string;
  } = {},
) {
  return {
    schema_version: SCHEMA_VERSION,
    tool,
    status: opts.status ?? 'ok',
    data_mode: opts.dataMode ?? 'live',
    as_of: new Date(Date.now() - (opts.asOfAgeSec ?? 5) * 1000).toISOString(),
    request,
    data,
    summary: { headline: opts.headline ?? `${tool} result`, key_points: [] },
    availability: opts.availability ?? { market: 'ok' },
    warnings: opts.warnings ?? [],
  };
}

const json = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });

function tokenData(p: Profile) {
  return {
    symbol: p.symbol,
    market: { price_usd: p.priceUsd, change_24h_pct: p.changePct },
    technicals: {
      rsi_14: p.rsi14,
      // A null ATR is emitted as null, never as 0 — the guide forbids that coercion,
      // and the EVIDENCE gate is what must catch it.
      ...(p.atr14 === null ? { atr_14: null } : { atr_14: p.atr14 }),
    },
  };
}

const server = new McpServer({ name: 'ryo-chan-conformance', version: '0.1.0' });

server.registerTool(
  'market_overview',
  { description: 'Market regime, totals, dominance, sentiment, breadth and movers.', inputSchema: {} },
  async () => {
    await gate();
    return json(
      envelope('market_overview', {}, {
        totals: { market_cap_usd: 2_410_000_000_000, volume_24h_usd: 84_200_000_000 },
        dominance: { btc: 54.7 },
        sentiment: { label: 'neutral', score: 51 },
        breadth: { advancing: 612, declining: 588 },
      }, { availability: { totals: 'ok', dominance: 'ok', breadth: 'ok' }, headline: 'Market is range-bound' }),
    );
  },
);

server.registerTool(
  'scan_market',
  {
    description: 'Ranked research shortlist from live market momentum.',
    inputSchema: {
      chain: z.string().optional(),
      theme: z.string().optional(),
      top_n: z.number().int().min(1).max(50).optional(),
    },
  },
  async ({ chain, theme, top_n }) => {
    await gate();
    return json(
      envelope('scan_market', { chain, theme, top_n }, {
        candidates: PROFILES.slice(0, top_n ?? 5).map((p) => ({
          symbol: p.symbol,
          price_usd: p.priceUsd,
          change_24h_pct: p.changePct,
        })),
      }, { availability: { candidates: 'ok' }, headline: 'Shortlist ranked by momentum' }),
    );
  },
);

server.registerTool(
  'analyze_token',
  {
    description: 'USD market data, multi-window performance, RSI(14) and ATR(14) for one token.',
    inputSchema: { symbol: z.string() },
  },
  async ({ symbol }) => {
    await gate();
    const p = findProfile(symbol);
    if (p.breakEnvelope) {
      // Contract violation on purpose: data_mode is absent and status is a bare
      // string outside the published set. The engine must raise
      // SCHEMA_MISMATCH_OR_MISSING_FIELD rather than reading around it.
      return json({
        schema_version: SCHEMA_VERSION,
        tool: 'analyze_token',
        status: 'fine',
        as_of: new Date().toISOString(),
        request: { symbol },
        data: tokenData(p),
        summary: { headline: 'broken envelope' },
        availability: { market: 'ok' },
        warnings: [],
      });
    }
    return json(
      envelope('analyze_token', { symbol: p.symbol }, tokenData(p), {
        status: p.status,
        dataMode: p.dataMode,
        asOfAgeSec: p.asOfAgeSec,
        availability: p.availability,
        warnings: p.warnings,
        headline: `${p.symbol} at $${p.priceUsd}`,
      }),
    );
  },
);

server.registerTool(
  'deep_analysis',
  {
    description: 'Comprehensive evidence pack for one token, with optional derivatives evidence.',
    inputSchema: { symbol: z.string(), include_perp: z.boolean().optional() },
  },
  async ({ symbol, include_perp }) => {
    await gate();
    const p = findProfile(symbol);
    return json(
      envelope('deep_analysis', { symbol: p.symbol, include_perp: include_perp ?? false }, {
        ...tokenData(p),
        confluence: { score: 0.62, signals: ['trend', 'volume'] },
        verdict: { label: p.status === 'ok' ? 'constructive' : 'inconclusive' },
        risks: p.warnings,
        ...(include_perp ? { derivatives: { funding_rate: 0.0001, open_interest_usd: 4.2e8 } } : {}),
      }, {
        status: p.status,
        dataMode: p.dataMode,
        asOfAgeSec: p.asOfAgeSec,
        availability: { ...p.availability, token_profile: 'partial' },
        warnings: p.warnings,
        headline: `${p.symbol} evidence pack`,
      }),
    );
  },
);

server.registerTool(
  'compare_tokens',
  {
    description: 'Compare two to four tokens on momentum, market activity and volatility.',
    // The guide specifies ONE comma- or space-separated string, not an array.
    inputSchema: { symbols: z.string(), intent: z.enum(['swing', 'hold', 'spot']).optional() },
  },
  async ({ symbols, intent }) => {
    await gate();
    const list = symbols.split(/[,\s]+/).filter(Boolean).slice(0, 4).map(findProfile);
    return json(
      envelope('compare_tokens', { symbols, intent }, {
        tokens: list.map(tokenData),
        leader: list.reduce((a, b) => (b.changePct > a.changePct ? b : a)).symbol,
      }, { availability: { tokens: 'ok' }, headline: `Compared ${list.length} assets` }),
    );
  },
);

server.registerTool(
  'monitor_market_sentiment_shift',
  {
    description: 'Seven-day view of sentiment change, market phase and derivatives context.',
    inputSchema: { time_window: z.literal('7d').optional() },
  },
  async ({ time_window }) => {
    await gate();
    return json(
      envelope('monitor_market_sentiment_shift', { time_window: time_window ?? '7d' }, {
        sentiment: { current: 51, previous: 44, change: 7 },
        phase: 'recovery',
        observation_dates: { from: '2026-08-31', to: '2026-09-07' },
        gaps: [],
      }, { availability: { sentiment: 'ok', phase: 'ok' }, headline: 'Sentiment up 7 points over 7d' }),
    );
  },
);

await server.connect(new StdioServerTransport());
process.stderr.write('[conformance] ryo-chan conformance peer ready on stdio (6 tools)\n');
