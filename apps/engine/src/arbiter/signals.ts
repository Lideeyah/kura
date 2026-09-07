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

interface Found {
  value: number;
  /** Dotted path the measurement was resolved at, for the startup probe report. */
  path: string;
}

/** Depth-first search for the first finite number stored under any of `keys`. */
function find(node: unknown, keys: string[], trail = '', depth = 0): Found | null {
  if (depth > 6 || node === null || typeof node !== 'object') return null;

  if (!Array.isArray(node)) {
    const obj = node as Record<string, unknown>;
    for (const key of keys) {
      const v = obj[key];
      if (typeof v === 'number' && Number.isFinite(v)) {
        return { value: v, path: trail ? `${trail}.${key}` : key };
      }
      // Some measurements arrive wrapped, e.g. { atr_14: { value: 4.2 } }
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const inner = (v as Record<string, unknown>).value;
        if (typeof inner === 'number' && Number.isFinite(inner)) {
          return { value: inner, path: `${trail ? `${trail}.` : ''}${key}.value` };
        }
      }
    }
  }

  const entries: Array<[string, unknown]> = Array.isArray(node)
    ? node.map((v, i) => [String(i), v])
    : Object.entries(node as object);
  for (const [k, child] of entries) {
    const found = find(child, keys, trail ? `${trail}.${k}` : k, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

const findNumber = (node: unknown, keys: string[]): number | null => find(node, keys)?.value ?? null;

export interface EvidenceProbe {
  resolved: boolean;
  pricePath: string | null;
  atrPath: string | null;
  rsiPath: string | null;
  detail: string;
}

/**
 * Report which measurement paths resolve in a live payload.
 *
 * Without this, a change in RYO's `data` shape degrades into silence: `extractSignals`
 * returns null, the EVIDENCE gate fails, and KURA vetoes every token forever while every
 * test still passes. The engine should say so at boot instead.
 */
export function probeEvidence(envelope: RyoEnvelope): EvidenceProbe {
  const price = find(envelope.data, PRICE_KEYS);
  const atr = find(envelope.data, ATR_KEYS);
  const rsi = find(envelope.data, RSI_KEYS);
  const missing = [!price && 'price', !atr && 'ATR(14)'].filter(Boolean) as string[];
  return {
    resolved: price !== null && atr !== null,
    pricePath: price?.path ?? null,
    atrPath: atr?.path ?? null,
    rsiPath: rsi?.path ?? null,
    detail:
      missing.length === 0
        ? `resolved price at data.${price!.path}, ATR(14) at data.${atr!.path}`
        : `could not resolve ${missing.join(' and ')} in data — searched ${[...PRICE_KEYS, ...ATR_KEYS].join(', ')}`,
  };
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
