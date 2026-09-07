/**
 * Deterministic profiles for the conformance MCP peer, shaped to the real RYO public
 * builder envelope (schema_version / tool / status / data_mode / as_of / request /
 * data / summary / availability / warnings).
 *
 * These exist so the engine can be exercised end to end over real transport without
 * spending metered quota, and so the resilience benchmark has a stable baseline. They
 * are NOT a fallback: the engine never reads this file, and if the configured MCP peer
 * is unreachable the engine fails loudly instead of using these.
 *
 * Each profile drives a different arbiter outcome:
 *   SOL     ok / live / fresh / low ATR   -> APPROVED, larger size
 *   AVAX    ok / live / fresh / high ATR  -> APPROVED, smaller size
 *   STALE   as_of far in the past         -> VETOED on FRESHNESS
 *   PARTL   status "partial"              -> VETOED on ORACLE
 *   SIMUL   data_mode "simulated"         -> VETOED on PROVENANCE
 *   NOEVD   ok / live but no ATR(14)      -> VETOED on EVIDENCE
 *   BADEV   envelope missing data_mode    -> SCHEMA_MISMATCH_OR_MISSING_FIELD
 */

export interface Profile {
  symbol: string;
  status: 'ok' | 'partial' | 'unavailable';
  dataMode: 'live' | 'mixed' | 'simulated' | 'unknown';
  priceUsd: number;
  atr14: number | null;
  rsi14: number;
  changePct: number;
  /** Seconds subtracted from now when stamping `as_of`. */
  asOfAgeSec: number;
  availability: Record<string, string>;
  warnings: string[];
  /** When true, the peer emits a contract-violating envelope on purpose. */
  breakEnvelope?: boolean;
}

const FULL = { market: 'ok', technicals: 'ok', intelligence: 'ok' };

export const PROFILES: Profile[] = [
  {
    symbol: 'SOL', status: 'ok', dataMode: 'live',
    priceUsd: 172.44, atr14: 4.31, rsi14: 56.2, changePct: 2.13,
    asOfAgeSec: 12, availability: FULL, warnings: [],
  },
  {
    symbol: 'AVAX', status: 'ok', dataMode: 'live',
    priceUsd: 27.9, atr14: 3.15, rsi14: 61.4, changePct: 5.02,
    asOfAgeSec: 20, availability: { ...FULL, intelligence: 'partial' },
    warnings: ['intelligence coverage is partial for this asset'],
  },
  {
    symbol: 'STALE', status: 'ok', dataMode: 'live',
    priceUsd: 1.02, atr14: 0.04, rsi14: 49.0, changePct: 0.1,
    asOfAgeSec: 3_600, availability: FULL,
    warnings: ['observation is older than the freshness budget'],
  },
  {
    symbol: 'PARTL', status: 'partial', dataMode: 'live',
    priceUsd: 8.4, atr14: 0.32, rsi14: 44.1, changePct: -1.2,
    asOfAgeSec: 15, availability: { ...FULL, technicals: 'partial' },
    warnings: ['technical section incomplete: insufficient price history'],
  },
  {
    symbol: 'SIMUL', status: 'ok', dataMode: 'simulated',
    priceUsd: 3.2, atr14: 0.09, rsi14: 52.0, changePct: 0.8,
    asOfAgeSec: 10, availability: FULL,
    warnings: ['values are simulated and must not be used for execution'],
  },
  {
    symbol: 'NOEVD', status: 'ok', dataMode: 'live',
    priceUsd: 0.51, atr14: null, rsi14: 50.0, changePct: -0.4,
    asOfAgeSec: 18, availability: { ...FULL, technicals: 'unavailable' },
    warnings: ['ATR(14) unavailable: not enough price history'],
  },
  {
    symbol: 'BADEV', status: 'ok', dataMode: 'live',
    priceUsd: 12.0, atr14: 0.5, rsi14: 55.0, changePct: 1.0,
    asOfAgeSec: 10, availability: FULL, warnings: [], breakEnvelope: true,
  },
];

export function findProfile(symbol: string | undefined): Profile {
  const needle = (symbol ?? 'SOL').trim().toUpperCase();
  return PROFILES.find((p) => p.symbol === needle) ?? PROFILES[0]!;
}
