import { config } from '../config.js';
import { findNumber, findString } from './signals.js';
import type { RyoDataMode, RyoEnvelope, RyoStatus } from '../schema/tools.js';

/**
 * Market-wide context, read from `market_overview`.
 *
 * **This is not corroboration, and the distinction matters.** Every RYO tool reads the
 * same backend: `analyze_token`, `deep_analysis` and `compare_tokens` return bit-identical
 * price, ATR and RSI for the same symbol in the same instant. Cross-checking a token's
 * price against a second tool would therefore agree by construction and prove nothing —
 * an independence claim the transport cannot support.
 *
 * `market_overview` is different because it carries information no token tool returns at
 * all: regime, sentiment, breadth and dominance describe the market the token trades in,
 * not the token. That is a genuine second input to the decision, and it is the only
 * honest one available across this tool surface.
 *
 * What the gate then asserts is narrow and true: no position is sized without a live,
 * recent read of the market the position would be taken in.
 */
export interface MarketContext {
  /** Regime label as published, e.g. "risk_on". Recorded for audit, never load-bearing. */
  regime: string | null;
  /** Fear/greed index as published. Recorded, not load-bearing. */
  fearGreed: number | null;
  /** Fraction of the tracked market advancing, in [0,1]. This is the load-bearing term. */
  breadth: number;
  /** Age of the read this context came from, in ms. The gate bounds it. */
  ageMs: number;
  status: RyoStatus;
  dataMode: RyoDataMode;
}

const BREADTH_KEYS = ['breadth', 'market_breadth', 'advance_decline_ratio'];
const REGIME_KEYS = ['regime', 'market_regime'];
const FEAR_GREED_KEYS = ['fear_greed_index', 'fear_greed', 'sentiment_score'];

/**
 * Pull breadth out of a market payload.
 *
 * Live RYO publishes `data.market.breadth` as a fraction already. A payload may instead
 * declare raw advancing/declining counts, so that form is converted rather than refused.
 * Anything else returns null and the gate vetoes — breadth is never assumed.
 */
function extractBreadth(data: unknown): number | null {
  const direct = findNumber(data, BREADTH_KEYS);
  if (direct !== null && direct >= 0 && direct <= 1) return direct;

  const advancing = findNumber(data, ['advancing', 'advances', 'gainers_count']);
  const declining = findNumber(data, ['declining', 'declines', 'losers_count']);
  if (advancing !== null && declining !== null) {
    const total = advancing + declining;
    if (total > 0) return advancing / total;
  }

  // A percentage-scaled breadth (0-100) is the one remaining documented form.
  if (direct !== null && direct > 1 && direct <= 100) return direct / 100;
  return null;
}

/**
 * Build a context from a `market_overview` envelope.
 *
 * `ageMs` is supplied by the caller rather than derived here, because the gate bounds
 * the age of *our* read — how long the cached value has been held — which is a different
 * quantity from the envelope's own `as_of` staleness. Both matter; `as_of` is checked by
 * this envelope's own status/mode fields and by the cache refusing to store a stale read.
 */
export function extractContext(envelope: RyoEnvelope, ageMs: number): MarketContext | null {
  const breadth = extractBreadth(envelope.data);
  if (breadth === null) return null;

  return {
    regime: findString(envelope.data, REGIME_KEYS),
    fearGreed: findNumber(envelope.data, FEAR_GREED_KEYS),
    breadth,
    ageMs,
    status: envelope.status,
    dataMode: envelope.data_mode,
  };
}

/**
 * Deterministic size multiplier from market breadth.
 *
 * Breadth is used rather than the `regime` string deliberately. The regime label is an
 * enum this codebase does not own: RYO publishes `"risk_on"` today, and a value it has
 * never returned in testing would have to be mapped by guesswork. Breadth is a number
 * with one meaning — the fraction of the market participating — so the mapping is
 * monotone, inspectable, and cannot be invalidated by a label KURA has not seen.
 *
 *   multiplier = clamp(breadth / KELLY_BREADTH_REF, KELLY_MIN_CONTEXT_MULT, 1)
 *
 * At or above the reference breadth the multiplier is exactly 1 and sizing is unchanged.
 * Below it the position scales down linearly with participation. The floor keeps this a
 * clamp rather than a back-door veto: refusal is the gates' job, and a multiplier that
 * reached zero would refuse silently without recording which invariant said no.
 */
export function contextMultiplier(context: MarketContext): number {
  const { breadthRef, minContextMultiplier } = config.kelly;
  if (breadthRef <= 0) return 1;
  const scaled = context.breadth / breadthRef;
  if (scaled >= 1) return 1;
  return scaled < minContextMultiplier ? minContextMultiplier : scaled;
}
