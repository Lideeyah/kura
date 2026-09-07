import { bus } from './bus/telemetry.js';
import { evaluate, type ArbiterVerdict } from './arbiter/invariants.js';
import { extractSignals, type SizingSignals } from './arbiter/signals.js';
import type { FlightRecorder, LedgerRecord } from './ledger/ledger.js';
import type { InterceptedRyo } from './mcp/interceptor.js';
import { EngineError } from './mcp/errors.js';
import { completeness, SchemaMismatchError, type RyoEnvelope } from './schema/tools.js';

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
 * `analyze_token` is the primary evidence source: the guide documents it as returning
 * current USD market data plus calculated technicals including RSI(14) and ATR(14),
 * and every tool is independently callable — no call is a prerequisite for another, so
 * there is nothing to chain and no quota to waste on warm-up calls.
 *
 * If that single call drops, times out, or breaks its schema, the arbiter is handed
 * `envelope: null` plus the structured fault and vetoes synchronously. No LLM is
 * consulted at any point on this path.
 */
export async function evaluateToken(
  ryo: InterceptedRyo,
  ledger: FlightRecorder,
  token: { symbol: string },
): Promise<EvaluationOutcome> {
  const symbol = token.symbol;

  let envelope: RyoEnvelope | null = null;
  let raw: unknown = null;
  let signals: SizingSignals | null = null;
  let fault: Fault | null = null;
  let latencyMs = 0;

  try {
    const res = await ryo.call('analyze_token', { symbol });
    envelope = res.payload;
    raw = res.raw;
    latencyMs = res.latencyMs;
    signals = extractSignals(envelope, completeness(envelope.availability));
  } catch (err) {
    fault = faultOf(err);
    latencyMs = err instanceof EngineError ? err.latencyMs : 0;
  }

  const verdict = evaluate({ token: symbol, latencyMs, envelope, signals, fault });

  const rawPayload = {
    token: symbol,
    analyze_token: raw,
    fault,
    signals: signals
      ? {
          price_usd: signals.priceUsd,
          atr_14: signals.atr14,
          atr_pct: signals.atrPct,
          rsi_14: signals.rsi14,
          completeness: signals.completeness,
        }
      : null,
    latency: { analyze_token_ms: round2(latencyMs) },
  };

  const record = ledger.append({
    token: symbol,
    decision: verdict.decision,
    reason: verdict.reason,
    latencyMs,
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
