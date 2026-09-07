/** The six tools RYO publishes. GET /api/mcp/health reports "tools": 6. */
export const TOOL_NAMES = [
  'market_overview',
  'scan_market',
  'analyze_token',
  'deep_analysis',
  'compare_tokens',
  'monitor_market_sentiment_shift',
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export type CallStatus =
  | 'OK'
  | 'DROPPED'
  | 'TIMEOUT'
  | 'SCHEMA_MISMATCH_OR_MISSING_FIELD'
  | 'TRANSPORT_ERROR';

export interface ToolPulse {
  tool: ToolName;
  latencyMs: number;
  status: CallStatus;
  at: string;
  detail?: string;
}

export type InvariantId = 'FRESHNESS' | 'ORACLE' | 'PROVENANCE' | 'EVIDENCE';
export type InvariantState = 'PASS' | 'FAIL' | 'NOT_EVALUATED';

export interface InvariantResult {
  id: InvariantId;
  predicate: string;
  state: InvariantState;
  expected: string;
  actual: string;
  detail: string;
}

export interface KellySizing {
  p: number;
  pBreakEven: number;
  b: number;
  fullKelly: number;
  fraction: number;
  positionUsd: number;
  bankrollUsd: number;
  pctOfCap: number;
  inputs: { volatilityScore: number; completenessScore: number; confidence: number; atrPct: number };
  clampedBy: string;
}

export interface ArbiterVerdict {
  token: string;
  decision: 'APPROVED' | 'VETOED';
  reason: string;
  failedInvariant: InvariantId | null;
  invariants: InvariantResult[];
  sizing: KellySizing | null;
  latencyMs: number;
  status: 'ok' | 'partial' | 'unavailable' | null;
  dataMode: 'live' | 'mixed' | 'simulated' | 'unknown' | null;
  asOfAgeMs: number | null;
  evaluationMicros: number;
  at: string;
}

export interface LedgerRecord {
  seq: number;
  receipt_id: string;
  timestamp: string;
  token: string;
  decision: 'APPROVED' | 'VETOED';
  reason: string;
  latency_ms: number;
  position_usd: number;
  invariants_json: string;
  raw_payload_json: string;
  payload_hash: string;
  prev_block_hash: string;
  block_hash: string;
}

export interface ChaosState {
  tool: ToolName | '*';
  action: 'DROP' | 'DELAY' | 'RESET';
  delayMs?: number;
}

export interface BackoffEvent {
  attempt: number;
  ofAttempts: number;
  delayMs: number;
  reason: 'RATE_LIMITED' | 'UPSTREAM_UNAVAILABLE' | 'NETWORK_ERROR';
  status: number | null;
  fromRetryAfter: boolean;
  rateLimit: { limit: number | null; remaining: number | null; reset: number | null } | null;
  at: string;
}

export interface EvidenceProbe {
  resolved: boolean;
  pricePath: string | null;
  atrPath: string | null;
  rsiPath: string | null;
  detail: string;
}

export type TelemetryEvent =
  | { type: 'hello'; connected: boolean; ledgerCount: number; chaos: ChaosState[]; at: string }
  | { type: 'tool_pulse'; pulse: ToolPulse }
  | { type: 'connection'; connected: boolean; transport: string; detail?: string; at: string }
  | { type: 'verdict'; verdict: ArbiterVerdict }
  | { type: 'ledger'; record: LedgerRecord }
  | { type: 'chaos'; chaos: ChaosState[]; at: string }
  | { type: 'rate_limit'; backoff: BackoffEvent }
  | { type: 'error'; code: string; message: string; tool?: ToolName; at: string };

export interface VerificationResult {
  receipt_id: string;
  valid: boolean;
  failures: string[];
  seq: number | null;
  recomputed_payload_hash: string | null;
  stored_payload_hash: string | null;
  recomputed_block_hash: string | null;
  stored_block_hash: string | null;
  parent_receipt_id: string | null;
  parent_block_hash: string | null;
  stored_prev_block_hash: string | null;
  is_genesis: boolean;
  elapsed_ms: number;
}
