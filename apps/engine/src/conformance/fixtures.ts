/**
 * Deterministic token profiles used by the conformance MCP peer.
 *
 * These exist so the engine can be exercised end-to-end over real transport before a
 * live RYO-CHAN endpoint is wired in, and so the resilience benchmark has a stable
 * baseline. They are NOT a fallback: the engine never reads this file, and if the
 * configured MCP peer is unreachable the engine fails loudly instead of using these.
 *
 * Each profile is chosen to drive a different arbiter outcome:
 *   SOL   clean, deep    -> APPROVED with a sized position
 *   JUP   clean, mid     -> APPROVED with a smaller position
 *   BONK  thin liquidity -> VETOED on LIQUIDITY
 *   HNYP  honeypot       -> VETOED on HONEYPOT
 *   ORCL  oracle error   -> VETOED on ORACLE
 *   BADS  broken schema  -> SCHEMA_MISMATCH_OR_MISSING_FIELD, then VETOED on ORACLE
 */

export interface Profile {
  symbol: string;
  address: string;
  chain: string;
  price_usd: number;
  liquidity_usd: number;
  volume_24h_usd: number;
  market_cap_usd: number;
  price_change_24h: number;
  holders: number;
  safety: {
    is_honeypot: boolean;
    can_sell: boolean;
    score: number;
    buy_tax_bps: number;
    sell_tax_bps: number;
    error: string | null;
  };
  /** When true, check_safety deliberately emits a contract-violating payload. */
  breakSchema?: boolean;
}

export const PROFILES: Profile[] = [
  {
    symbol: 'SOL', address: 'So11111111111111111111111111111111111111112', chain: 'solana',
    price_usd: 172.44, liquidity_usd: 48_200_000, volume_24h_usd: 91_500_000,
    market_cap_usd: 82_400_000_000, price_change_24h: 2.13, holders: 1_842_003,
    safety: { is_honeypot: false, can_sell: true, score: 96, buy_tax_bps: 0, sell_tax_bps: 0, error: null },
  },
  {
    symbol: 'JUP', address: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', chain: 'solana',
    price_usd: 0.8412, liquidity_usd: 6_150_000, volume_24h_usd: 12_300_000,
    market_cap_usd: 1_140_000_000, price_change_24h: -1.07, holders: 612_450,
    safety: { is_honeypot: false, can_sell: true, score: 88, buy_tax_bps: 0, sell_tax_bps: 0, error: null },
  },
  {
    symbol: 'BONK', address: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', chain: 'solana',
    price_usd: 0.0000221, liquidity_usd: 240_000, volume_24h_usd: 3_100_000,
    market_cap_usd: 1_620_000_000, price_change_24h: 5.88, holders: 921_004,
    safety: { is_honeypot: false, can_sell: true, score: 71, buy_tax_bps: 0, sell_tax_bps: 0, error: null },
  },
  {
    symbol: 'HNYP', address: 'HnYp1111111111111111111111111111111111111111', chain: 'solana',
    price_usd: 0.0134, liquidity_usd: 9_400_000, volume_24h_usd: 2_050_000,
    market_cap_usd: 13_400_000, price_change_24h: 41.2, holders: 1_204,
    safety: { is_honeypot: true, can_sell: false, score: 4, buy_tax_bps: 300, sell_tax_bps: 9_900, error: null },
  },
  {
    symbol: 'ORCL', address: 'OrCL1111111111111111111111111111111111111111', chain: 'solana',
    price_usd: 1.02, liquidity_usd: 4_800_000, volume_24h_usd: 700_000,
    market_cap_usd: 22_000_000, price_change_24h: 0.4, holders: 8_402,
    safety: {
      is_honeypot: false, can_sell: true, score: 0, buy_tax_bps: 0, sell_tax_bps: 0,
      error: 'simulation_unavailable: rpc node returned no trace',
    },
  },
  {
    symbol: 'BADS', address: 'BaDs1111111111111111111111111111111111111111', chain: 'solana',
    price_usd: 0.51, liquidity_usd: 3_300_000, volume_24h_usd: 480_000,
    market_cap_usd: 9_100_000, price_change_24h: -3.2, holders: 3_112,
    safety: { is_honeypot: false, can_sell: true, score: 60, buy_tax_bps: 0, sell_tax_bps: 0, error: null },
    breakSchema: true,
  },
];

export function findProfile(symbolOrAddress: string | undefined): Profile {
  const needle = (symbolOrAddress ?? 'SOL').toLowerCase();
  return (
    PROFILES.find((p) => p.symbol.toLowerCase() === needle || p.address.toLowerCase() === needle) ??
    PROFILES[0]!
  );
}
