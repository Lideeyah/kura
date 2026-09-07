import type { RyoEnvelope } from '../schema/tools.js';

/**
 * Quantitative evidence the sizing model needs, pulled out of a tool's `data` block.
 *
 * The guide fixes the *envelope* but leaves each tool's `data` shape to the live
 * catalog, so this searches a small set of documented measurement names rather than
 * hard-coding one path. `analyze_token` is documented to return "current USD market
 * data, multi-window performance, calculated technical measurements such as RSI(14)
 * and ATR(14)", so price and ATR are what we look for.
 *
 * When the authenticated catalog is available, pin these to exact paths — the guide
 * names `GET /api/mcp/tools` as the final source of truth.
 *
 * Critically: a measurement that cannot be found comes back as `null`, never as 0.
 * The arbiter turns a null into a veto. "Never convert an unavailable or null
 * measurement to zero" is a rule from the guide, and it is load-bearing here.
 */
export interface SizingSignals {
  priceUsd: number;
  atr14: number;
  /** ATR as a fraction of price — the volatility term in the sizing model. */
  atrPct: number;
  rsi14: number | null;
  /** Fraction of declared availability sections reporting healthy, if declarable. */
  completeness: number | null;
}

const PRICE_KEYS = ['price_usd', 'price', 'current_price', 'usd_price', 'last_price'];
const ATR_KEYS = ['atr_14', 'atr14', 'atr', 'atr_value'];
const RSI_KEYS = ['rsi_14', 'rsi14', 'rsi', 'rsi_value'];

/** Depth-first search for the first finite number stored under any of `keys`. */
function findNumber(node: unknown, keys: string[], depth = 0): number | null {
  if (depth > 6 || node === null || typeof node !== 'object') return null;

  if (!Array.isArray(node)) {
    const obj = node as Record<string, unknown>;
    for (const key of keys) {
      const v = obj[key];
      if (typeof v === 'number' && Number.isFinite(v)) return v;
      // Some measurements arrive wrapped, e.g. { atr_14: { value: 4.2 } }
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const inner = (v as Record<string, unknown>).value;
        if (typeof inner === 'number' && Number.isFinite(inner)) return inner;
      }
    }
  }

  for (const child of Array.isArray(node) ? node : Object.values(node as object)) {
    const found = findNumber(child, keys, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

export function extractSignals(
  envelope: RyoEnvelope,
  completenessValue: number | null,
): SizingSignals | null {
  const price = findNumber(envelope.data, PRICE_KEYS);
  const atr = findNumber(envelope.data, ATR_KEYS);

  // No price or no volatility measurement means no defensible size. Veto, never guess.
  if (price === null || atr === null || price <= 0 || atr < 0) return null;

  return {
    priceUsd: price,
    atr14: atr,
    atrPct: atr / price,
    rsi14: findNumber(envelope.data, RSI_KEYS),
    completeness: completenessValue,
  };
}
