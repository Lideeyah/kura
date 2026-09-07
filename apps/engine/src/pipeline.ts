import { bus } from './bus/telemetry.js';
import { evaluate, type ArbiterVerdict } from './arbiter/invariants.js';
import type { FlightRecorder, LedgerRecord } from './ledger/ledger.js';
import type { InterceptedRyo } from './mcp/interceptor.js';
import { EngineError } from './mcp/errors.js';
import { SchemaMismatchError, type AnalyzeToken, type CheckSafety } from './schema/tools.js';

export interface EvaluationOutcome {
  verdict: ArbiterVerdict;
  record: LedgerRecord;
}

interface Fault {
  code: string;
  message: string;
}

function faultOf(err: unknown): Fault {
  if (err instanceof SchemaMismatchError) return { code: err.code, message: err.message };
  if (err instanceof EngineError) return { code: err.code, message: err.message };
  return { code: 'UNKNOWN_FAULT', message: err instanceof Error ? err.message : String(err) };
}

/**
 * One full decision cycle for a single token.
 *
 * The ordering is the circuit breaker: the safety oracle is queried first, and if it
 * drops, times out, or breaks its schema, the market call is never issued at all. The
 * arbiter is then handed `safety: null` plus the structured fault and vetoes
 * synchronously. No LLM is consulted at any point on this path.
 */
export async function evaluateToken(
  ryo: InterceptedRyo,
  ledger: FlightRecorder,
  token: { symbol: string; address?: string },
): Promise<EvaluationOutcome> {
  const label = token.symbol;
  const args: Record<string, unknown> = { symbol: token.symbol };
  if (token.address) args.address = token.address;

  let safety: CheckSafety | null = null;
  let rawSafety: unknown = null;
  let market: AnalyzeToken | null = null;
  let rawMarket: unknown = null;
  let fault: Fault | null = null;
  let safetyMs = 0;
  let marketMs = 0;

  try {
    const res = await ryo.call('check_safety', args);
    safety = res.payload;
    rawSafety = res.raw;
    safetyMs = res.latencyMs;
  } catch (err) {
    fault = faultOf(err);
    safetyMs = err instanceof EngineError ? err.latencyMs : 0;
  }

  // Circuit breaker: only reach for market data if the safety oracle actually answered.
  if (fault === null) {
    try {
      const res = await ryo.call('analyze_token', args);
      market = res.payload;
      rawMarket = res.raw;
      marketMs = res.latencyMs;
    } catch (err) {
      fault = faultOf(err);
      marketMs = err instanceof EngineError ? err.latencyMs : 0;
    }
  }

  const worstMs = Math.max(safetyMs, marketMs);
  const verdict = evaluate({ token: label, latencyMs: worstMs, market, safety, fault });

  const rawPayload = {
    token: label,
    address: token.address ?? null,
    check_safety: rawSafety,
    analyze_token: rawMarket,
    fault,
    latency: {
      check_safety_ms: round2(safetyMs),
      analyze_token_ms: round2(marketMs),
      worst_ms: round2(worstMs),
    },
  };

  const record = ledger.append({
    token: label,
    decision: verdict.decision,
    reason: verdict.reason,
    latencyMs: worstMs,
    positionUsd: verdict.sizing?.positionUsd ?? 0,
    invariants: verdict.invariants,
    rawPayload,
  });

  bus.publish({ type: 'verdict', verdict });
  bus.publish({ type: 'ledger', record });
  if (fault) {
    bus.publish({
      type: 'error',
      code: fault.code,
      message: fault.message,
      at: new Date().toISOString(),
    });
  }

  return { verdict, record };
}

const round2 = (n: number) => Math.round(n * 100) / 100;
