import { z } from 'zod';

/**
 * Data contract for the 7 live RYO-CHAN tools.
 *
 * Rules enforced here, deliberately:
 *  - No `.default()`, no `.catch()`, no `.coerce`. A missing or mistyped field is a
 *    hard failure, never a silently substituted zero.
 *  - Invariant-critical fields (`liquidity_usd`, `is_honeypot`, `error`) are required
 *    and exactly typed. The arbiter is never handed an inferred value.
 *  - Unknown *extra* keys are passed through, so an upstream additive change does not
 *    take the engine down. Only missing/mistyped required fields are fatal.
 */

export const TOOL_NAMES = [
  'market_overview',
  'scan_market',
  'analyze_token',
  'deep_analysis',
  'compare_tokens',
  'check_safety',
  'supported_tokens',
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

const finite = z.number().finite();
const nonNegative = finite.min(0);
const isoTimestamp = z.string().min(1);

const TokenRef = z
  .object({
    symbol: z.string().min(1),
    address: z.string().min(1),
    chain: z.string().min(1),
  })
  .passthrough();

/** Market fields the liquidity invariant reads. Required, non-negative, never defaulted. */
const MarketCore = z.object({
  symbol: z.string().min(1),
  address: z.string().min(1),
  price_usd: nonNegative,
  liquidity_usd: nonNegative,
  volume_24h_usd: nonNegative,
  price_change_24h: finite,
});

export const MarketOverviewSchema = z
  .object({
    total_market_cap_usd: nonNegative,
    total_volume_24h_usd: nonNegative,
    btc_dominance: finite.min(0).max(100),
    sentiment: z.enum(['BULLISH', 'BEARISH', 'NEUTRAL']),
    updated_at: isoTimestamp,
  })
  .passthrough();

export const ScanMarketSchema = z
  .object({
    results: z.array(MarketCore.passthrough()),
    scanned_at: isoTimestamp,
  })
  .passthrough();

export const AnalyzeTokenSchema = MarketCore.extend({
  market_cap_usd: nonNegative,
  holders: z.number().int().min(0),
}).passthrough();

export const DeepAnalysisSchema = MarketCore.extend({
  holder_concentration_top10: finite.min(0).max(1),
  liquidity_locked_pct: finite.min(0).max(1),
  contract_verified: z.boolean(),
  risk_flags: z.array(z.string()),
}).passthrough();

export const CompareTokensSchema = z
  .object({
    tokens: z.array(AnalyzeTokenSchema).min(1),
    winner: z.string().min(1),
  })
  .passthrough();

/**
 * The safety oracle. `is_honeypot` MUST be a boolean and `error` MUST be present as
 * either a string or an explicit null — an absent `error` key is a schema violation,
 * because "absent" and "no error" are not the same claim.
 */
export const CheckSafetySchema = z
  .object({
    symbol: z.string().min(1),
    address: z.string().min(1),
    is_honeypot: z.boolean(),
    can_sell: z.boolean(),
    score: finite.min(0).max(100),
    buy_tax_bps: z.number().int().min(0),
    sell_tax_bps: z.number().int().min(0),
    error: z.string().min(1).nullable(),
  })
  .passthrough();

export const SupportedTokensSchema = z
  .object({
    tokens: z.array(TokenRef),
    count: z.number().int().min(0),
  })
  .passthrough();

export const TOOL_SCHEMAS = {
  market_overview: MarketOverviewSchema,
  scan_market: ScanMarketSchema,
  analyze_token: AnalyzeTokenSchema,
  deep_analysis: DeepAnalysisSchema,
  compare_tokens: CompareTokensSchema,
  check_safety: CheckSafetySchema,
  supported_tokens: SupportedTokensSchema,
} satisfies Record<ToolName, z.ZodTypeAny>;

export type MarketOverview = z.infer<typeof MarketOverviewSchema>;
export type ScanMarket = z.infer<typeof ScanMarketSchema>;
export type AnalyzeToken = z.infer<typeof AnalyzeTokenSchema>;
export type DeepAnalysis = z.infer<typeof DeepAnalysisSchema>;
export type CompareTokens = z.infer<typeof CompareTokensSchema>;
export type CheckSafety = z.infer<typeof CheckSafetySchema>;
export type SupportedTokens = z.infer<typeof SupportedTokensSchema>;

export type ToolPayload = {
  market_overview: MarketOverview;
  scan_market: ScanMarket;
  analyze_token: AnalyzeToken;
  deep_analysis: DeepAnalysis;
  compare_tokens: CompareTokens;
  check_safety: CheckSafety;
  supported_tokens: SupportedTokens;
};

export type SchemaIssue = {
  path: string;
  code: string;
  expected: string;
  received: string;
  message: string;
};

/**
 * Structured, catchable representation of a contract break. This is the event the
 * spec calls SCHEMA_MISMATCH_OR_MISSING_FIELD — thrown, never swallowed, never
 * replaced by a default.
 */
export class SchemaMismatchError extends Error {
  readonly code = 'SCHEMA_MISMATCH_OR_MISSING_FIELD' as const;
  readonly tool: ToolName;
  readonly issues: SchemaIssue[];
  readonly rawPayload: unknown;

  constructor(tool: ToolName, issues: SchemaIssue[], rawPayload: unknown) {
    const summary = issues
      .map((i) => `${i.path || '<root>'}: ${i.message} (expected ${i.expected}, received ${i.received})`)
      .join('; ');
    super(`SCHEMA_MISMATCH_OR_MISSING_FIELD [${tool}] ${summary}`);
    this.name = 'SchemaMismatchError';
    this.tool = tool;
    this.issues = issues;
    this.rawPayload = rawPayload;
  }

  toJSON() {
    return { code: this.code, tool: this.tool, issues: this.issues, message: this.message };
  }
}

function toIssue(issue: z.ZodIssue): SchemaIssue {
  const anyIssue = issue as z.ZodIssue & { expected?: string; received?: string };
  return {
    path: issue.path.join('.'),
    code: issue.code,
    expected: anyIssue.expected ?? 'see-message',
    received: anyIssue.received ?? 'see-message',
    message: issue.message,
  };
}

/** Runtime gate. Every payload crosses this boundary before any invariant reads it. */
export function validateToolPayload<T extends ToolName>(tool: T, raw: unknown): ToolPayload[T] {
  const schema = TOOL_SCHEMAS[tool];
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new SchemaMismatchError(tool, result.error.issues.map(toIssue), raw);
  }
  return result.data as ToolPayload[T];
}

export function isToolName(value: string): value is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(value);
}
