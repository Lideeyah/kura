import { config } from '../config.js';
import type { AnalyzeToken, CheckSafety } from '../schema/tools.js';
import { sizePosition, type KellySizing } from './kelly.js';

export type InvariantId = 'LATENCY' | 'ORACLE' | 'HONEYPOT' | 'LIQUIDITY';
export type InvariantState = 'PASS' | 'FAIL' | 'NOT_EVALUATED';

export interface InvariantResult {
  id: InvariantId;
  predicate: string;
  state: InvariantState;
  expected: string;
  /** The empirical value the gate actually saw. Never inferred, never defaulted. */
  actual: string;
  detail: string;
}

export interface ArbiterInput {
  token: string;
  /** Worst observed latency across the tool calls that fed this decision. */
  latencyMs: number;
  /** null when the market oracle failed — the arbiter is told, not left to guess. */
  market: AnalyzeToken | null;
  /** null when the safety oracle dropped, timed out, or broke its schema. */
  safety: CheckSafety | null;
  /** Structured reason the upstream call failed, if it did. */
  fault?: { code: string; message: string } | null;
}

export interface ArbiterVerdict {
  token: string;
  decision: 'APPROVED' | 'VETOED';
  reason: string;
  failedInvariant: InvariantId | null;
  invariants: InvariantResult[];
  sizing: KellySizing | null;
  latencyMs: number;
  /** Wall-clock cost of the gate itself, in microseconds. Budget: < 1000 (1 ms). */
  evaluationMicros: number;
  at: string;
}

const NOT_EVALUATED = (id: InvariantId, predicate: string, expected: string): InvariantResult => ({
  id,
  predicate,
  state: 'NOT_EVALUATED',
  expected,
  actual: '—',
  detail: 'short-circuited by an earlier failing invariant',
});

/**
 * The zero-fallback invariant arbiter.
 *
 * Properties this function guarantees, and which the test suite asserts:
 *  - Fully synchronous. No promises, no I/O, no model call, no network. It cannot
 *    await anything, so it cannot hang on a degraded upstream.
 *  - No fallback branch. A missing oracle is a VETO, never a "best guess" or a retry
 *    against a language model.
 *  - Short-circuits on the first failure, so a hostile condition terminates execution
 *    in microseconds rather than after four round trips.
 *  - Every gate reports the empirical value it saw, so a veto is auditable after the
 *    fact from the ledger alone.
 */
export function evaluate(input: ArbiterInput): ArbiterVerdict {
  const t0 = performance.now();
  const { maxLatencyMs, minLiquidityUsd } = config.invariants;

  const latencyPredicate = `latencyMs <= ${maxLatencyMs}`;
  const oraclePredicate = 'safety !== null && !safety.error';
  const honeypotPredicate = 'safety.is_honeypot === false';
  const liquidityPredicate = `market.liquidity_usd >= ${minLiquidityUsd}`;

  const results: InvariantResult[] = [];
  let failed: InvariantId | null = null;
  let reason = '';

  // 1 — LATENCY
  const latencyOk = input.latencyMs <= maxLatencyMs;
  results.push({
    id: 'LATENCY',
    predicate: latencyPredicate,
    state: latencyOk ? 'PASS' : 'FAIL',
    expected: `<= ${maxLatencyMs} ms`,
    actual: `${round2(input.latencyMs)} ms`,
    detail: latencyOk
      ? 'upstream responded inside the latency budget'
      : `upstream exceeded the latency budget by ${round2(input.latencyMs - maxLatencyMs)} ms`,
  });
  if (!latencyOk) {
    failed = 'LATENCY';
    reason = `LATENCY breached: ${round2(input.latencyMs)} ms > ${maxLatencyMs} ms`;
    results.push(NOT_EVALUATED('ORACLE', oraclePredicate, 'non-null, error-free safety oracle'));
    results.push(NOT_EVALUATED('HONEYPOT', honeypotPredicate, 'is_honeypot === false'));
    results.push(NOT_EVALUATED('LIQUIDITY', liquidityPredicate, `>= ${minLiquidityUsd} USD`));
    return finish(input, results, failed, reason, null, t0);
  }

  // 2 — ORACLE
  const safety = input.safety;
  const oracleOk = safety !== null && !safety.error;
  results.push({
    id: 'ORACLE',
    predicate: oraclePredicate,
    state: oracleOk ? 'PASS' : 'FAIL',
    expected: 'non-null, error-free safety oracle',
    actual:
      safety === null
        ? `null (${input.fault?.code ?? 'ORACLE_UNAVAILABLE'})`
        : `error=${JSON.stringify(safety.error)}`,
    detail: oracleOk
      ? 'safety oracle answered without an error'
      : safety === null
        ? `safety oracle unavailable: ${input.fault?.message ?? 'no payload returned'}`
        : `safety oracle self-reported an error: ${safety.error}`,
  });
  if (!oracleOk) {
    failed = 'ORACLE';
    reason =
      safety === null
        ? `ORACLE unavailable: ${input.fault?.code ?? 'ORACLE_UNAVAILABLE'} — ${input.fault?.message ?? 'no payload'}`
        : `ORACLE reported error: ${safety.error}`;
    results.push(NOT_EVALUATED('HONEYPOT', honeypotPredicate, 'is_honeypot === false'));
    results.push(NOT_EVALUATED('LIQUIDITY', liquidityPredicate, `>= ${minLiquidityUsd} USD`));
    return finish(input, results, failed, reason, null, t0);
  }

  // 3 — HONEYPOT
  const honeypotOk = safety.is_honeypot === false;
  results.push({
    id: 'HONEYPOT',
    predicate: honeypotPredicate,
    state: honeypotOk ? 'PASS' : 'FAIL',
    expected: 'is_honeypot === false',
    actual: String(safety.is_honeypot),
    detail: honeypotOk
      ? 'oracle cleared the contract as sellable'
      : 'oracle flagged the contract as a honeypot',
  });
  if (!honeypotOk) {
    failed = 'HONEYPOT';
    reason = 'HONEYPOT gate tripped: safety.is_honeypot === true';
    results.push(NOT_EVALUATED('LIQUIDITY', liquidityPredicate, `>= ${minLiquidityUsd} USD`));
    return finish(input, results, failed, reason, null, t0);
  }

  // 4 — LIQUIDITY
  const market = input.market;
  const liquidityOk = market !== null && market.liquidity_usd >= minLiquidityUsd;
  results.push({
    id: 'LIQUIDITY',
    predicate: liquidityPredicate,
    state: liquidityOk ? 'PASS' : 'FAIL',
    expected: `>= ${fmtUsd(minLiquidityUsd)}`,
    actual: market === null ? `null (${input.fault?.code ?? 'MARKET_UNAVAILABLE'})` : fmtUsd(market.liquidity_usd),
    detail:
      market === null
        ? `market oracle unavailable: ${input.fault?.message ?? 'no payload returned'}`
        : liquidityOk
          ? 'pool depth clears the floor'
          : `pool depth is ${fmtUsd(minLiquidityUsd - market.liquidity_usd)} short of the floor`,
  });
  if (!liquidityOk) {
    failed = 'LIQUIDITY';
    reason =
      market === null
        ? `LIQUIDITY unavailable: ${input.fault?.code ?? 'MARKET_UNAVAILABLE'}`
        : `LIQUIDITY below floor: ${fmtUsd(market.liquidity_usd)} < ${fmtUsd(minLiquidityUsd)}`;
    return finish(input, results, failed, reason, null, t0);
  }

  const sizing = sizePosition(market, safety);
  return finish(
    input,
    results,
    null,
    `all 4 invariants satisfied — fractional Kelly size ${fmtUsd(sizing.positionUsd)} (${(sizing.fraction * 100).toFixed(3)}% of bankroll)`,
    sizing,
    t0,
  );
}

function finish(
  input: ArbiterInput,
  invariants: InvariantResult[],
  failedInvariant: InvariantId | null,
  reason: string,
  sizing: KellySizing | null,
  t0: number,
): ArbiterVerdict {
  return {
    token: input.token,
    decision: failedInvariant === null ? 'APPROVED' : 'VETOED',
    reason,
    failedInvariant,
    invariants,
    sizing,
    latencyMs: round2(input.latencyMs),
    evaluationMicros: Math.round((performance.now() - t0) * 1000),
    at: new Date().toISOString(),
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Thousands-grouped USD, hand-rolled on purpose.
 *
 * `Number.prototype.toLocaleString` was the obvious choice and is the wrong one twice
 * over: its first call pays ~15 ms of one-time ICU locale initialisation, which lands
 * inside the gate's own timing budget, and its output varies with how the host Node
 * was built. A deterministic arbiter must not carry a locale dependency, least of all
 * one whose result is written into the ledger.
 */
function fmtUsd(n: number): string {
  const negative = n < 0;
  const fixed = round2(Math.abs(n)).toFixed(2);
  const [whole = '0', cents = '00'] = fixed.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const body = cents === '00' ? grouped : `${grouped}.${cents}`;
  return `${negative ? '-' : ''}$${body}`;
}
