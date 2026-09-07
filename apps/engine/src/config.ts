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
    url: str('RYO_MCP_URL', 'https://app-ryochan.com/api/mcp'),
    command: process.env.RYO_MCP_COMMAND ?? '',
    args: (process.env.RYO_MCP_ARGS ?? '').split(' ').filter(Boolean),
    /**
     * Builder credential, sent as `Authorization: Bearer <key>`.
     * The guide names this RYO_MCP_KEY; RYO_MCP_TOKEN is accepted as a legacy alias.
     */
    key: process.env.RYO_MCP_KEY ?? process.env.RYO_MCP_TOKEN ?? '',
    /** Hard ceiling on a single tool call before the interceptor raises UPSTREAM_TIMEOUT. */
    requestTimeoutMs: num('RYO_REQUEST_TIMEOUT_MS', 10_000),
    /**
     * Per-request retry policy for 429 / 503 / network errors, with full jitter.
     * The guide: "Use exponential backoff with jitter for 429, 503, and temporary
     * network errors" and "Do not retry invalid arguments or unknown tools".
     */
    retryMaxAttempts: num('RYO_RETRY_MAX_ATTEMPTS', 4),
    retryBaseDelayMs: num('RYO_RETRY_BASE_DELAY_MS', 500),
    retryMaxDelayMs: num('RYO_RETRY_MAX_DELAY_MS', 20_000),

    /** Reconnect backoff after a transport-level failure. */
    reconnectBackoffMs: num('RYO_RECONNECT_BACKOFF_MS', 1_000),
    reconnectMaxBackoffMs: num('RYO_RECONNECT_MAX_BACKOFF_MS', 15_000),
  },

  /** Deterministic invariant thresholds. Changing these changes the arbiter's verdicts. */
  invariants: {
    /** Round-trip ceiling for a single upstream call. */
    maxLatencyMs: num('INV_MAX_LATENCY_MS', 1_200),
    /** How stale the `as_of` observation may be before a result is refused. */
    maxAsOfAgeMs: num('INV_MAX_AS_OF_AGE_MS', 300_000),
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
    /** ATR/price at which the volatility score reaches zero. */
    maxAtrPct: num('KELLY_MAX_ATR_PCT', 0.15),
    /**
     * ATR/price at or above which the model refuses to size at all. Beyond the
     * volatility score's floor the formula stops discriminating, so this is a hard
     * refusal rather than an extrapolation into a range it cannot model.
     */
    hyperVolAtrPct: num('KELLY_HYPER_VOL_ATR_PCT', 0.5),
    maxPositionPct: num('KELLY_MAX_POSITION_PCT', 0.05),
  },

  ledger: {
    /** Resolved against the workspace root so every entrypoint hits the same file. */
    path: resolve(repoRoot, str('LEDGER_PATH', './kura_flight_recorder.db')),
  },

  telemetry: {
    /**
     * Liveness polling interval. This hits GET /health, which needs no auth and
     * consumes no tool-call quota — the guide explicitly warns against tight polling
     * loops over the metered tools, so per-tool latency is sampled from real
     * evaluations instead of from a synthetic heartbeat.
     */
    pulseIntervalMs: num('PULSE_INTERVAL_MS', 15_000),
    /** Interval between full evaluation cycles of the watchlist. */
    evaluationIntervalMs: num('EVALUATION_INTERVAL_MS', 15_000),
    /** Set to 0 to disable the autonomous evaluation loop. */
    autoEvaluate: num('AUTO_EVALUATE', 1),
    /** Fan the heartbeat across all six metered tools instead of the free /health. */
    pulseSweepTools: num('PULSE_SWEEP_TOOLS', 0),
    /** Boot-time measurement-path probe. Costs one tool call; set 0 to skip. */
    evidenceProbe: num('EVIDENCE_PROBE', 1),
  },

  /**
   * Candidate symbols. RYO publishes no supported_tokens tool, so this is the
   * operator's own list rather than something discovered upstream.
   */
  watchlist: str('KURA_WATCHLIST', 'SOL,BTC,ETH,AVAX,BNB')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean),
} as const;

export const GENESIS_HASH = '0'.repeat(64);
