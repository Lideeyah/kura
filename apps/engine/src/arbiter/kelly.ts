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
  clampedBy: 'NONE' | 'MAX_POSITION_PCT' | 'NON_POSITIVE_EDGE';
}

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);

/**
 * Fractional Kelly position sizing on real RYO measurements.
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
 * `completeness` may legitimately be null (a tool that declares no availability map).
 * That is treated as zero *confidence contribution*, not as full confidence — an
 * unmeasured section never argues for a bigger position.
 */
export function sizePosition(signals: SizingSignals): KellySizing {
  const { bankrollUsd, fraction: kellyFraction, payoffRatio: b, pMax, maxPositionPct, maxAtrPct } =
    config.kelly;

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
  if (fraction <= 0) {
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
