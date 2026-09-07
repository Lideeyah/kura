import { config } from '../config.js';
import type { AnalyzeToken, CheckSafety } from '../schema/tools.js';

export interface KellySizing {
  /** Estimated win probability, derived deterministically from observable market data. */
  p: number;
  /** Break-even probability 1/(1+b). Below this the edge is negative by construction. */
  pBreakEven: number;
  /** Reward-to-risk ratio assumed by the sizing model. */
  b: number;
  /** Full Kelly fraction, (p*b - q) / b. */
  fullKelly: number;
  /** Full Kelly scaled by KELLY_FRACTION and clamped to the per-position ceiling. */
  fraction: number;
  positionUsd: number;
  bankrollUsd: number;
  inputs: {
    liquidityScore: number;
    volumeScore: number;
    safetyScore: number;
    confidence: number;
  };
  clampedBy: 'NONE' | 'MAX_POSITION_PCT' | 'NON_POSITIVE_EDGE';
}

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);

/**
 * Log-scaled score: 0 at `floor`, 1 at `floor * span`. Anything below the floor is 0.
 * Deterministic and monotonic — the same inputs always yield the same size.
 */
function logScore(value: number, floor: number, span: number): number {
  if (value <= floor) return 0;
  return clamp01(Math.log10(value / floor) / Math.log10(span));
}

/**
 * Fractional Kelly position sizing.
 *
 * There is no model call and no randomness here. Win probability is a fixed affine
 * function of a confidence score built from three observable quantities:
 *
 *   liquidityScore  log-scaled depth from the liquidity floor up to 100x the floor
 *   volumeScore     log-scaled 24h volume from 10% of the floor up to 100x that
 *   safetyScore     the oracle's own 0-100 score, normalised
 *
 *   confidence = 0.40*safety + 0.35*liquidity + 0.25*volume
 *   pBreakEven = 1 / (1 + b)                  the p at which the edge is exactly zero
 *   p          = pBreakEven + (P_MAX - pBreakEven) * confidence
 *   fullKelly  = (p*b - (1-p)) / b            with b = KELLY_PAYOFF_RATIO
 *   fraction   = min(KELLY_FRACTION * fullKelly, KELLY_MAX_POSITION_PCT), floored at 0
 *
 * Because p is anchored at break-even, confidence == 0 produces fullKelly == 0 exactly.
 * The MAX_POSITION_PCT clamp is a hard risk limit and reports itself in `clampedBy`, so
 * a saturated size is never mistaken for a computed one.
 */
export function sizePosition(market: AnalyzeToken, safety: CheckSafety): KellySizing {
  const { bankrollUsd, fraction: kellyFraction, payoffRatio: b, pMax, maxPositionPct } = config.kelly;
  // Anchoring p at the break-even probability makes the model honest at the bottom:
  // a token with no measurable edge is sized at zero, not at some residual floor.
  const pMin = 1 / (1 + b);
  const floor = config.invariants.minLiquidityUsd;

  const liquidityScore = logScore(market.liquidity_usd, floor, 100);
  const volumeScore = logScore(market.volume_24h_usd, floor / 10, 100);
  const safetyScore = clamp01(safety.score / 100);

  const confidence = 0.4 * safetyScore + 0.35 * liquidityScore + 0.25 * volumeScore;
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
      liquidityScore: round(liquidityScore, 6),
      volumeScore: round(volumeScore, 6),
      safetyScore: round(safetyScore, 6),
      confidence: round(confidence, 6),
    },
    clampedBy,
  };
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
