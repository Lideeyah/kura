import { config as loadEnv } from 'dotenv';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Walk up from this file to the workspace root (the dir holding the root package.json). */
function findRepoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(resolve(dir, 'package.json')) && existsSync(resolve(dir, 'apps'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

export const repoRoot = findRepoRoot();

// Root .env wins for the whole workspace; a package-local .env may still override.
loadEnv({ path: resolve(repoRoot, '.env') });
loadEnv({ path: resolve(process.cwd(), '.env') });

function num(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`CONFIG_INVALID: ${key} must be a finite number, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

function str(key: string, fallback: string): string {
  const raw = process.env[key];
  return raw === undefined || raw === '' ? fallback : raw;
}

export type TransportKind = 'http' | 'stdio';

export const config = {
  /** Engine HTTP port. */
  port: num('ENGINE_PORT', 4000),

  mcp: {
    /**
     * Transport selection.
     *  - 'http'  -> RYO_MCP_URL (Streamable HTTP, automatic SSE fallback)
     *  - 'stdio' -> RYO_MCP_COMMAND + RYO_MCP_ARGS
     */
    transport: str('RYO_MCP_TRANSPORT', 'http') as TransportKind,
    url: process.env.RYO_MCP_URL ?? '',
    command: process.env.RYO_MCP_COMMAND ?? '',
    args: (process.env.RYO_MCP_ARGS ?? '').split(' ').filter(Boolean),
    /** Bearer token injected as `Authorization: Bearer <token>` on HTTP transports. */
    token: process.env.RYO_MCP_TOKEN ?? '',
    /** Hard ceiling on a single tool call before the interceptor raises UPSTREAM_TIMEOUT. */
    requestTimeoutMs: num('RYO_REQUEST_TIMEOUT_MS', 10_000),
    /** Reconnect backoff after a transport-level failure. */
    reconnectBackoffMs: num('RYO_RECONNECT_BACKOFF_MS', 1_000),
    reconnectMaxBackoffMs: num('RYO_RECONNECT_MAX_BACKOFF_MS', 15_000),
  },

  /** Deterministic invariant thresholds. Changing these changes the arbiter's verdicts. */
  invariants: {
    maxLatencyMs: num('INV_MAX_LATENCY_MS', 1_200),
    minLiquidityUsd: num('INV_MIN_LIQUIDITY_USD', 1_000_000),
  },

  /** Fractional Kelly sizing parameters (see arbiter/kelly.ts for the derivation). */
  kelly: {
    bankrollUsd: num('KELLY_BANKROLL_USD', 100_000),
    fraction: num('KELLY_FRACTION', 0.25),
    payoffRatio: num('KELLY_PAYOFF_RATIO', 1.5),
    /**
     * Win probability at full confidence. The lower bound is NOT configurable: it is
     * pinned to the break-even probability 1/(1+b), so zero confidence yields exactly
     * zero edge and therefore exactly zero size.
     */
    pMax: num('KELLY_P_MAX', 0.55),
    maxPositionPct: num('KELLY_MAX_POSITION_PCT', 0.05),
  },

  ledger: {
    /** Resolved against the workspace root so every entrypoint hits the same file. */
    path: resolve(repoRoot, str('LEDGER_PATH', './kura_flight_recorder.db')),
  },

  telemetry: {
    /** Interval between health pings across the 7 tools. */
    pulseIntervalMs: num('PULSE_INTERVAL_MS', 5_000),
    /** Interval between full evaluation cycles of the watchlist. */
    evaluationIntervalMs: num('EVALUATION_INTERVAL_MS', 15_000),
    /** Set to 0 to disable the autonomous evaluation loop. */
    autoEvaluate: num('AUTO_EVALUATE', 1),
  },
} as const;

export const GENESIS_HASH = '0'.repeat(64);
