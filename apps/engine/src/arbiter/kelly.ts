import { config } from '../config.js';
import type { SizingSignals } from './signals.js';

export interface KellySizing {
  /** Estimated win probability, derived deterministically from observable evidence. */
  p: number;
  /** Break-even probability 1/(1+b). Below this the edge is negative by construction. */
  pBreakEven: number;
  b: number;
  fullKelly: number;
  fraction: number;
  positionUsd: number;
  bankrollUsd: number;
  inputs: {
    volatilityScore: number;
    completenessScore: number;
    confidence: number;
    atrPct: number;
  };
  /** Allocation as a percentage of the hard risk cap — the headline figure. */
  pctOfCap: number;
  clampedBy: 'NONE' | 'MAX_POSITION_PCT' | 'NON_POSITIVE_EDGE' | 'HYPER_VOLATILITY';
}

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);

/**
 * Heuristic volatility-adjusted sizing cap. **Not a theoretical Kelly proof.**
 *
 * This is worth stating plainly, because the shape of the formula invites more credit
 * than it deserves. Real Kelly requires an estimated edge. KURA has no edge estimate —
 * it has "the evidence was complete and the asset was not too volatile", which is a
 * statement about *data quality*, not about expected return. The weights below were
 * chosen for sane behaviour, not fitted to any backtest.
 *
 * What it therefore is: a deterministic, monotonic, auditable ceiling that shrinks as
 * volatility rises and as evidence thins, and collapses to zero at both extremes. Treat
 * the output as an illustrative risk allocation, never as a cash mandate.
 *
 * No model call and no randomness. Confidence is a fixed weighting of two observable
 * quantities that RYO actually publishes:
 *
 *   volatilityScore    1 at zero ATR, falling linearly to 0 at KELLY_MAX_ATR_PCT.
 *                      A more volatile asset earns a smaller position.
 *   completenessScore  fraction of declared availability sections reporting healthy.
 *                      Thinner evidence earns a smaller position.
 *
 *   confidence = 0.60*volatility + 0.40*completeness
 *   pBreakEven = 1 / (1 + b)               the p at which the edge is exactly zero
 *   p          = pBreakEven + (P_MAX - pBreakEven) * confidence
 *   fullKelly  = (p*b - (1-p)) / b
 *   fraction   = min(KELLY_FRACTION * fullKelly, KELLY_MAX_POSITION_PCT), floored at 0
 *
 * Because p is anchored at break-even, confidence == 0 produces fullKelly == 0 exactly.
 * The MAX_POSITION_PCT clamp is a hard risk limit and reports itself in `clampedBy`,
 * so a saturated size is never mistaken for a computed one.
 *
 * Above KELLY_HYPER_VOL_ATR_PCT the model refuses outright rather than extrapolating.
 * The volatility score already floors at zero at KELLY_MAX_ATR_PCT, which means without
 * this cutoff an asset with an ATR of 500% of its own price would size identically to
 * one at 15% — the model going blind exactly where the risk is most extreme. An asset
 * whose daily true range approaches its own price is not a position, it is a coin flip.
 *
 * `completeness` may legitimately be null (a tool that declares no availability map).
 * That is treated as zero *confidence contribution*, not as full confidence — an
 * unmeasured section never argues for a bigger position.
 */
export function sizePosition(signals: SizingSignals): KellySizing {
  const {
    bankrollUsd, fraction: kellyFraction, payoffRatio: b, pMax,
    maxPositionPct, maxAtrPct, hyperVolAtrPct,
  } = config.kelly;

  const pMin = 1 / (1 + b);
  const volatilityScore = clamp01(1 - signals.atrPct / maxAtrPct);
  const completenessScore = signals.completeness === null ? 0 : clamp01(signals.completeness);

  const confidence = 0.6 * volatilityScore + 0.4 * completenessScore;
  const p = pMin + (pMax - pMin) * confidence;
  const q = 1 - p;

  // (p*b - q)/b is exactly 0 at break-even in exact arithmetic, but binary floating
  // point leaves ~1e-16 of residue. Snapping that to zero keeps "no edge" reported as
  // NON_POSITIVE_EDGE rather than as an unclamped position of $0.00.
  const raw = (p * b - q) / b;
  const fullKelly = Math.abs(raw) < 1e-12 ? 0 : raw;

  let clampedBy: KellySizing['clampedBy'] = 'NONE';
  let fraction = kellyFraction * fullKelly;
  if (signals.atrPct >= hyperVolAtrPct) {
    // Hyper-volatile or illiquid: refuse rather than extrapolate past the model's range.
    fraction = 0;
    clampedBy = 'HYPER_VOLATILITY';
  } else if (fraction <= 0) {
    fraction = 0;
    clampedBy = 'NON_POSITIVE_EDGE';
  } else if (fraction > maxPositionPct) {
    fraction = maxPositionPct;
    clampedBy = 'MAX_POSITION_PCT';
  }

  return {
    p: round(p, 6),
    pBreakEven: round(pMin, 6),
    b,
    fullKelly: round(fullKelly, 6),
    fraction: round(fraction, 6),
    pctOfCap: round(maxPositionPct > 0 ? (fraction / maxPositionPct) * 100 : 0, 3),
    positionUsd: round(bankrollUsd * fraction, 2),
    bankrollUsd,
    inputs: {
      volatilityScore: round(volatilityScore, 6),
      completenessScore: round(completenessScore, 6),
      confidence: round(confidence, 6),
      atrPct: round(signals.atrPct, 6),
    },
    clampedBy,
  };
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
