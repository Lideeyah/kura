import { z } from 'zod';

/**
 * Data contract for the six live RYO-CHAN research tools.
 *
 * Source of truth: the RYO Builder MCP Guide (13 Aug 2026) and the authenticated
 * catalog at `GET /api/mcp/tools`, which the guide names as final if the two ever
 * differ. The unauthenticated health endpoint reports `"tools": 6`.
 *
 * Rules enforced here, deliberately:
 *  - No `.default()`, no `.catch()`, no `.coerce`. The guide is explicit: "Never
 *    convert an unavailable or null measurement to zero." A missing measurement is a
 *    hard failure that the arbiter sees, never a silently substituted zero.
 *  - The *envelope* is validated strictly, because it is the part of the contract RYO
 *    publishes and guarantees. Tool-specific `data` is passed through, because its
 *    inner shape is owned by the live catalog and varies per tool.
 *  - Every invariant the arbiter evaluates reads envelope fields only, so the gate
 *    logic rests on the documented public contract rather than on inferred internals.
 */

export const TOOL_NAMES = [
  'market_overview',
  'scan_market',
  'analyze_token',
  'deep_analysis',
  'compare_tokens',
  'monitor_market_sentiment_shift',
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

/** `ok` all primary evidence present · `partial` gaps · `unavailable` not enough. */
export const StatusSchema = z.enum(['ok', 'partial', 'unavailable']);
export type RyoStatus = z.infer<typeof StatusSchema>;

/** Provenance of the measurements behind this result. */
export const DataModeSchema = z.enum(['live', 'mixed', 'simulated', 'unknown']);
export type RyoDataMode = z.infer<typeof DataModeSchema>;

/**
 * The public builder envelope. Every successful call carries these top-level fields.
 * `data` is where tool-specific structured evidence lives; `summary` is for display and
 * is explicitly not a substitute for structured fields.
 */
export const EnvelopeSchema = z
  .object({
    schema_version: z.string().min(1),
    tool: z.string().min(1),
    status: StatusSchema,
    data_mode: DataModeSchema,
    as_of: z.string().min(1),
    request: z.record(z.unknown()),
    data: z.record(z.unknown()),
    summary: z.record(z.unknown()),
    availability: z.record(z.unknown()),
    warnings: z.array(z.string()),
  })
  .passthrough();

export type RyoEnvelope = z.infer<typeof EnvelopeSchema>;

/** Input schemas, mirroring the documented arguments for each tool. */
export const TOOL_INPUTS = {
  market_overview: z.object({}).strict(),
  scan_market: z
    .object({
      chain: z.string().min(1).optional(),
      theme: z.string().min(1).optional(),
      top_n: z.number().int().min(1).max(50).optional(),
    })
    .strict(),
  analyze_token: z.object({ symbol: z.string().min(1) }).strict(),
  deep_analysis: z
    .object({ symbol: z.string().min(1), include_perp: z.boolean().optional() })
    .strict(),
  // Two to four distinct symbols as ONE comma- or space-separated string, not an array.
  compare_tokens: z
    .object({ symbols: z.string().min(1), intent: z.enum(['swing', 'hold', 'spot']).optional() })
    .strict(),
  monitor_market_sentiment_shift: z
    .object({ time_window: z.literal('7d').optional() })
    .strict(),
} satisfies Record<ToolName, z.ZodTypeAny>;

export type SchemaIssue = {
  path: string;
  code: string;
  expected: string;
  received: string;
  message: string;
};

/**
 * Structured, catchable representation of a contract break — the event the spec calls
 * SCHEMA_MISMATCH_OR_MISSING_FIELD. Thrown, never swallowed, never defaulted away.
 */
export class SchemaMismatchError extends Error {
  readonly code = 'SCHEMA_MISMATCH_OR_MISSING_FIELD' as const;
  readonly tool: string;
  readonly issues: SchemaIssue[];
  readonly rawPayload: unknown;

  constructor(tool: string, issues: SchemaIssue[], rawPayload: unknown) {
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
export function validateEnvelope(tool: string, raw: unknown): RyoEnvelope {
  const result = EnvelopeSchema.safeParse(raw);
  if (!result.success) {
    throw new SchemaMismatchError(tool, result.error.issues.map(toIssue), raw);
  }
  return result.data;
}

export function isToolName(value: string): value is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(value);
}

/**
 * Age of the observation behind a result, in milliseconds. Returns null when `as_of`
 * is not a parseable timestamp — null propagates to a veto, it is never treated as 0.
 */
export function asOfAgeMs(asOf: string, now = Date.now()): number | null {
  const t = Date.parse(asOf);
  if (Number.isNaN(t)) return null;
  return now - t;
}

/**
 * Fraction of declared availability sections reporting a healthy state.
 * Returns null for an empty availability map rather than a misleading 1.0.
 */
export function completeness(availability: Record<string, unknown>): number | null {
  const entries = Object.entries(availability);
  if (entries.length === 0) return null;
  let ok = 0;
  for (const [, v] of entries) {
    if (v === true || v === 'ok' || v === 'available' || v === 'complete') ok += 1;
    else if (v && typeof v === 'object') {
      const s = (v as { status?: unknown }).status;
      if (s === 'ok' || s === 'available' || s === 'complete') ok += 1;
    }
  }
  return ok / entries.length;
}
