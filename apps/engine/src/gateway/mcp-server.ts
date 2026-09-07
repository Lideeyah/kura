import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { config } from '../config.js';
import type { Supervisor } from '../supervisor.js';

/**
 * KURA as an MCP **server**.
 *
 * The engine is a gateway, not an endpoint: it speaks MCP *client* upstream to
 * RYO-CHAN, and MCP *server* downstream to whatever agent wants a protective
 * pre-trade gate. An external agent registers this URL and calls
 * `evaluate_candidate` instead of calling market tools directly — so the four
 * deterministic invariants sit between the agent's intent and any execution, and the
 * agent cannot route around them.
 *
 * Every call returns a receipt id and a block hash. The agent's own reasoning is not
 * trusted to report what happened; the ledger is.
 */
export function buildGatewayServer(sup: Supervisor): McpServer {
  const server = new McpServer(
    { name: 'kura-gateway', version: '0.1.0' },
    {
      instructions:
        'KURA is a deterministic pre-trade gate. Call evaluate_candidate before acting on any ' +
        'market decision: it runs four synchronous invariants (latency, safety-oracle integrity, ' +
        'honeypot, liquidity floor) with no model in the path, returns APPROVED with a fractional ' +
        'Kelly size or VETOED with the exact failing gate, and commits the decision to a SHA-256 ' +
        'hash chain. A VETOED verdict is final — there is no override and no fallback estimate. ' +
        'Use verify_receipt to prove any past decision was not altered.',
    },
  );

  const json = (value: unknown) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  });

  server.registerTool(
    'evaluate_candidate',
    {
      description:
        'Run the deterministic invariant gate against one token and commit the verdict to the ' +
        'tamper-evident ledger. Returns APPROVED with a bounded position size, or VETOED with ' +
        'the invariant that failed and the empirical value it saw. Never calls a language model.',
      inputSchema: {
        symbol: z.string().min(1).describe('Token symbol, e.g. SOL'),
        address: z.string().min(1).optional().describe('Optional contract address to disambiguate'),
      },
    },
    async ({ symbol, address }) => {
      const { verdict, record } = await sup.evaluate({ symbol, address });
      return json({
        decision: verdict.decision,
        token: verdict.token,
        reason: verdict.reason,
        failed_invariant: verdict.failedInvariant,
        gates: verdict.invariants.map((i) => ({
          id: i.id,
          state: i.state,
          predicate: i.predicate,
          expected: i.expected,
          actual: i.actual,
        })),
        sizing: verdict.sizing
          ? {
              position_usd: verdict.sizing.positionUsd,
              bankroll_fraction: verdict.sizing.fraction,
              win_probability: verdict.sizing.p,
              break_even_probability: verdict.sizing.pBreakEven,
              clamped_by: verdict.sizing.clampedBy,
            }
          : null,
        upstream_latency_ms: verdict.latencyMs,
        gate_evaluation_micros: verdict.evaluationMicros,
        receipt: {
          receipt_id: record.receipt_id,
          seq: record.seq,
          block_hash: record.block_hash,
          prev_block_hash: record.prev_block_hash,
          payload_hash: record.payload_hash,
          committed_at: record.timestamp,
        },
      });
    },
  );

  server.registerTool(
    'verify_receipt',
    {
      description:
        'Recompute the SHA-256 payload and block hashes for a past decision from its stored raw ' +
        'wire payload, and re-check its link to the preceding block. Proves the record was not ' +
        'altered after the fact.',
      inputSchema: { receipt_id: z.string().min(1) },
    },
    async ({ receipt_id }) => json(sup.ledger.verify(receipt_id)),
  );

  server.registerTool(
    'get_receipt',
    {
      description:
        'Fetch one committed decision in full, including the canonical raw wire payload that the ' +
        'payload hash covers and the gate-by-gate invariant record.',
      inputSchema: { receipt_id: z.string().min(1) },
    },
    async ({ receipt_id }) => {
      const record = sup.ledger.get(receipt_id);
      if (!record) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `RECEIPT_NOT_FOUND: ${receipt_id}` }],
        };
      }
      return json({
        ...record,
        invariants: JSON.parse(record.invariants_json),
        raw_payload: JSON.parse(record.raw_payload_json),
      });
    },
  );

  server.registerTool(
    'chain_status',
    {
      description:
        'Walk the entire hash chain from genesis and report whether it is intact, plus the ' +
        'sequence number of the first break if there is one.',
      inputSchema: {},
    },
    async () => {
      const chain = sup.ledger.verifyChain();
      const head = sup.ledger.head();
      return json({
        ...chain,
        height: head?.seq ?? 0,
        head_block_hash: head?.block_hash ?? null,
        ledger_path: config.ledger.path,
        journal_mode: sup.ledger.journalMode,
      });
    },
  );

  server.registerTool(
    'gate_policy',
    {
      description:
        'The invariant thresholds and sizing parameters currently in force, plus the tokens the ' +
        'upstream peer can price. Read this before evaluating so the agent knows the rules it is ' +
        'being held to.',
      inputSchema: {},
    },
    async () =>
      json({
        invariants: [
          { id: 'LATENCY', predicate: `latencyMs <= ${config.invariants.maxLatencyMs}` },
          { id: 'ORACLE', predicate: 'safety !== null && !safety.error' },
          { id: 'HONEYPOT', predicate: 'safety.is_honeypot === false' },
          { id: 'LIQUIDITY', predicate: `market.liquidity_usd >= ${config.invariants.minLiquidityUsd}` },
        ],
        sizing: {
          model: 'fractional Kelly, p anchored at break-even 1/(1+b)',
          bankroll_usd: config.kelly.bankrollUsd,
          kelly_fraction: config.kelly.fraction,
          payoff_ratio: config.kelly.payoffRatio,
          max_position_pct: config.kelly.maxPositionPct,
        },
        upstream_connected: sup.connected,
        candidates: sup.tokens,
      }),
  );

  return server;
}
