import { config } from '../config.js';
import { asOfAgeMs, type RyoDataMode, type RyoEnvelope, type RyoStatus } from '../schema/tools.js';
import { sizePosition, type KellySizing } from './kelly.js';
import type { SizingSignals } from './signals.js';

export type InvariantId = 'FRESHNESS' | 'ORACLE' | 'PROVENANCE' | 'EVIDENCE';
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
  /** Worst observed round-trip across the calls that fed this decision. */
  latencyMs: number;
  /** null when the upstream call dropped, timed out, or broke its schema. */
  envelope: RyoEnvelope | null;
  /** null when the required numeric evidence could not be measured. */
  signals: SizingSignals | null;
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
  status: RyoStatus | null;
  dataMode: RyoDataMode | null;
  asOfAgeMs: number | null;
  /** Wall-clock cost of the gate itself, in microseconds. Budget: < 1000 (1 ms). */
  evaluationMicros: number;
  at: string;
}

/**
 * The zero-fallback invariant arbiter.
 *
 * All four gates read the *documented public envelope* — `status`, `data_mode`,
 * `as_of`, plus measured round-trip and the extracted measurements. That is
 * deliberate: the envelope is the part of the contract RYO publishes and guarantees,
 * so the gate logic never rests on inferred internals that a catalog change could
 * silently invalidate.
 *
 * Properties the test suite asserts:
 *  - Fully synchronous. No promises, no I/O, no model call, no network. It cannot
 *    await anything, so it cannot hang on a degraded upstream.
 *  - No fallback branch. A missing envelope is a VETO, never a best guess.
 *  - Short-circuits on the first failure, so a hostile condition terminates in
 *    microseconds rather than after four round trips.
 *  - Every gate reports the empirical value it saw, so a veto is auditable after the
 *    fact from the ledger alone.
 */
export function evaluate(input: ArbiterInput): ArbiterVerdict {
  const t0 = performance.now();
  const { maxLatencyMs, maxAsOfAgeMs } = config.invariants;

  const freshnessPredicate = `latencyMs <= ${maxLatencyMs} && asOfAgeMs <= ${maxAsOfAgeMs}`;
  const oraclePredicate = "envelope !== null && status === 'ok'";
  const provenancePredicate = "data_mode === 'live'";
  const evidencePredicate = 'price and ATR(14) both measurable';

  const results: InvariantResult[] = [];
  const env = input.envelope;
  const ageMs = env ? asOfAgeMs(env.as_of) : null;

  const skip = (id: InvariantId, predicate: string, expected: string): InvariantResult => ({
    id,
    predicate,
    state: 'NOT_EVALUATED',
    expected,
    actual: '—',
    detail: 'short-circuited by an earlier failing invariant',
  });

  const finish = (
    failedInvariant: InvariantId | null,
    reason: string,
    sizing: KellySizing | null,
  ): ArbiterVerdict => ({
    token: input.token,
    decision: failedInvariant === null ? 'APPROVED' : 'VETOED',
    reason,
    failedInvariant,
    invariants: results,
    sizing,
    latencyMs: round2(input.latencyMs),
    status: env?.status ?? null,
    dataMode: env?.data_mode ?? null,
    asOfAgeMs: ageMs,
    evaluationMicros: Math.round((performance.now() - t0) * 1000),
    at: new Date().toISOString(),
  });

  // 1 — FRESHNESS. Round-trip inside budget AND the observation itself recent.
  const rttOk = input.latencyMs <= maxLatencyMs;
  const ageOk = ageMs !== null && ageMs <= maxAsOfAgeMs;
  const freshnessOk = rttOk && (env === null ? false : ageOk);
  results.push({
    id: 'FRESHNESS',
    predicate: freshnessPredicate,
    state: freshnessOk ? 'PASS' : 'FAIL',
    expected: `rtt <= ${maxLatencyMs} ms, observation <= ${maxAsOfAgeMs} ms old`,
    actual:
      env === null
        ? `rtt ${round2(input.latencyMs)} ms, as_of unavailable (${input.fault?.code ?? 'NO_PAYLOAD'})`
        : `rtt ${round2(input.latencyMs)} ms, as_of ${ageMs === null ? 'unparseable' : `${round2(ageMs)} ms old`}`,
    detail: !rttOk
      ? `round-trip exceeded budget by ${round2(input.latencyMs - maxLatencyMs)} ms`
      : env === null
        ? `no envelope returned: ${input.fault?.message ?? 'upstream produced no payload'}`
        : ageMs === null
          ? 'as_of is not a parseable timestamp'
          : ageOk
            ? 'round-trip and observation both inside budget'
            : `observation is ${round2(ageMs - maxAsOfAgeMs)} ms staler than permitted`,
  });
  if (!freshnessOk) {
    results.push(skip('ORACLE', oraclePredicate, "status === 'ok'"));
    results.push(skip('PROVENANCE', provenancePredicate, "data_mode === 'live'"));
    results.push(skip('EVIDENCE', evidencePredicate, 'price and ATR(14) present'));
    // When a fault caused the slow round-trip, name it. "Latency breached" alone sends
    // an operator hunting for a network problem that is really a rate limit.
    const cause = input.fault ? ` (${input.fault.code})` : '';
    const why = !rttOk
      ? `FRESHNESS breached: ${round2(input.latencyMs)} ms > ${maxLatencyMs} ms${cause}`
      : env === null
        ? `FRESHNESS unavailable: ${input.fault?.code ?? 'NO_PAYLOAD'} — ${input.fault?.message ?? 'no envelope'}`
        : `FRESHNESS breached: observation ${ageMs === null ? 'unparseable' : `${round2(ageMs)} ms old`}`;
    return finish('FRESHNESS', why, null);
  }

  // 2 — ORACLE INTEGRITY. 'partial' and 'unavailable' are refusals, not degradations.
  const oracleOk = env !== null && env.status === 'ok';
  results.push({
    id: 'ORACLE',
    predicate: oraclePredicate,
    state: oracleOk ? 'PASS' : 'FAIL',
    expected: "status === 'ok'",
    actual: env === null ? `null (${input.fault?.code ?? 'NO_PAYLOAD'})` : env.status,
    detail: oracleOk
      ? 'all primary evidence for this tool was available'
      : env === null
        ? `upstream returned no envelope: ${input.fault?.message ?? 'no payload'}`
        : `upstream reported status="${env.status}"${env.warnings.length ? ` — ${env.warnings[0]}` : ''}`,
  });
  if (!oracleOk) {
    results.push(skip('PROVENANCE', provenancePredicate, "data_mode === 'live'"));
    results.push(skip('EVIDENCE', evidencePredicate, 'price and ATR(14) present'));
    return finish(
      'ORACLE',
      env === null
        ? `ORACLE unavailable: ${input.fault?.code ?? 'NO_PAYLOAD'} — ${input.fault?.message ?? 'no envelope'}`
        : `ORACLE incomplete: status="${env.status}"`,
      null,
    );
  }

  // 3 — DATA PROVENANCE. Refuse to size real capital on anything but live measurement.
  const provenanceOk = env.data_mode === 'live';
  results.push({
    id: 'PROVENANCE',
    predicate: provenancePredicate,
    state: provenanceOk ? 'PASS' : 'FAIL',
    expected: "data_mode === 'live'",
    actual: env.data_mode,
    detail: provenanceOk
      ? 'every measurement behind this result is a live read'
      : `result is data_mode="${env.data_mode}" — not a live read, so it cannot size capital`,
  });
  if (!provenanceOk) {
    results.push(skip('EVIDENCE', evidencePredicate, 'price and ATR(14) present'));
    return finish('PROVENANCE', `PROVENANCE rejected: data_mode="${env.data_mode}" is not live`, null);
  }

  // 4 — EVIDENCE FLOOR. We do not size what we cannot measure.
  const signals = input.signals;
  const evidenceOk = signals !== null;
  results.push({
    id: 'EVIDENCE',
    predicate: evidencePredicate,
    state: evidenceOk ? 'PASS' : 'FAIL',
    expected: 'price and ATR(14) present',
    actual: signals === null ? 'missing' : `price $${signals.priceUsd}, ATR ${round2(signals.atrPct * 100)}%`,
    detail: evidenceOk
      ? 'required measurements present, so a size can be computed rather than assumed'
      : 'price or ATR(14) could not be measured — refusing to substitute zero',
  });
  if (!evidenceOk) {
    return finish('EVIDENCE', 'EVIDENCE FLOOR: required measurements absent — no size computed', null);
  }

  const sizing = sizePosition(signals);
  return finish(
    null,
    `all 4 invariants satisfied — illustrative allocation ${sizing.pctOfCap.toFixed(1)}% of cap ` +
      `(${(sizing.fraction * 100).toFixed(3)}% of bankroll)`,
    sizing,
  );
}

const round2 = (n: number) => Math.round(n * 100) / 100;
