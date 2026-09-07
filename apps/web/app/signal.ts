import type { CallStatus, InvariantState } from './types';

/**
 * Single source of truth for what a colour means on this page.
 *
 * Emerald  healthy / approved / verified
 * Amber    degraded but still inside budget
 * Rose     halted / tripped / dropped / tampered
 * Muted    not evaluated — deliberately colourless, because a short-circuited gate
 *          made no claim either way and must not read as a pass or a fail.
 */
export type Signal = 'ok' | 'warn' | 'halt' | 'idle';

export const SIGNAL_TEXT: Record<Signal, string> = {
  ok: 'text-emerald',
  warn: 'text-amber',
  halt: 'text-rose',
  idle: 'text-text-muted',
};

export const SIGNAL_DOT: Record<Signal, string> = {
  ok: 'bg-emerald',
  warn: 'bg-amber',
  halt: 'bg-rose',
  idle: 'bg-text-muted/50',
};

export const SIGNAL_RING: Record<Signal, string> = {
  ok: 'border-emerald/30',
  warn: 'border-amber/35',
  halt: 'border-rose/45',
  idle: 'border-border',
};

/** Latency bands, matching the arbiter's own 1200 ms ceiling. */
export const LATENCY_OK_MS = 400;
export const LATENCY_CEILING_MS = 1200;

export function latencySignal(ms: number): Signal {
  if (ms < LATENCY_OK_MS) return 'ok';
  if (ms <= LATENCY_CEILING_MS) return 'warn';
  return 'halt';
}

export function statusSignal(status: CallStatus, latencyMs: number): Signal {
  return status === 'OK' ? latencySignal(latencyMs) : 'halt';
}

export function invariantSignal(state: InvariantState): Signal {
  if (state === 'PASS') return 'ok';
  if (state === 'FAIL') return 'halt';
  return 'idle';
}

export const GATE_GLYPH: Record<InvariantState, string> = {
  PASS: '✓',
  FAIL: '✕',
  NOT_EVALUATED: '—',
};

/**
 * Sub-millisecond figures are the whole point of the arbiter, so they render in µs;
 * anything slower reads in ms. Fixed decimal places keep the column width stable.
 */
export function formatLatency(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  if (ms < 1) return `${Math.round(ms * 1000)}µs`;
  if (ms < 1000) return `${ms.toFixed(ms < 10 ? 2 : 1)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export function formatMicros(us: number): string {
  return us < 1000 ? `${us}µs` : `${(us / 1000).toFixed(2)}ms`;
}

export function formatUsd(n: number): string {
  return `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

/** Zero-padded sequence, so #0007 and #0132 occupy identical width. */
export function formatSeq(seq: number): string {
  return `#${String(seq).padStart(4, '0')}`;
}

/** HH:MM:SS.mmm in the viewer's own zone — millisecond precision matters here. */
export function formatClock(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

export function truncateHash(hash: string, head = 8): string {
  return `${hash.slice(0, head)}…`;
}

/**
 * Scannable short form of a receipt id, e.g. REC-7F91B24A. This is a display label
 * only — the full UUID is always shown alongside it and is what every command and API
 * call uses, so the abbreviation can never be mistaken for the identifier itself.
 */
export function receiptLabel(receiptId: string): string {
  return `REC-${receiptId.replace(/-/g, '').slice(0, 8).toUpperCase()}`;
}

/** Human-readable label for the gate that halted execution. */
export function triggeredGate(reason: string, failedInvariant: string | null): string {
  if (!failedInvariant) return '—';
  if (reason.includes('TRANSPORT_DROPPED')) return 'ORACLE_DROP';
  if (reason.includes('SCHEMA_MISMATCH')) return 'SCHEMA_BREAK';
  if (reason.includes('UPSTREAM_TIMEOUT')) return 'UPSTREAM_TIMEOUT';
  return failedInvariant;
}

/**
 * A ledger row does not carry `failedInvariant` as a column, but its `invariants_json`
 * is the arbiter's own gate-by-gate record — so the failing gate is read from there
 * rather than guessed from the decision.
 */
export function failedGateOf(invariantsJson: string): string | null {
  try {
    const gates = JSON.parse(invariantsJson) as Array<{ id: string; state: string }>;
    return gates.find((g) => g.state === 'FAIL')?.id ?? null;
  } catch {
    return null;
  }
}

export const GATE_LABEL: Record<string, string> = {
  LATENCY: 'FRESHNESS',
  ORACLE: 'ORACLE INTEGRITY',
  HONEYPOT: 'CONTRACT SECURITY',
  LIQUIDITY: 'LIQUIDITY FLOOR',
};
