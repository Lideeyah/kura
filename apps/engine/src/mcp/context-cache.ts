import { config } from '../config.js';
import { extractContext, type MarketContext } from '../arbiter/context.js';
import { EngineError } from './errors.js';
import { SchemaMismatchError, type RyoEnvelope } from '../schema/tools.js';
import type { InterceptedRyo } from './interceptor.js';

export interface ContextRead {
  /** null when the read failed or breadth could not be measured. The gate vetoes. */
  context: MarketContext | null;
  fault: { code: string; message: string } | null;
  raw: unknown;
  /** Round-trip of the upstream call, or 0 when this read was served from cache. */
  latencyMs: number;
  cached: boolean;
}

/**
 * TTL cache for the `market_overview` read behind the CONTEXT gate.
 *
 * Market regime is a property of the market, not of the token being evaluated, so one
 * read legitimately serves every token evaluated inside the window. Without this the
 * gate would double the call volume of every evaluation — and against a key whose
 * binding constraint is burst rate rather than the published per-minute ceiling, that
 * is the difference between the gate being free and the gate being the reason
 * evaluations start getting refused.
 *
 * Two properties it is careful about:
 *
 *  - **It never serves a stale entry.** Past the TTL the entry is not a cheap
 *    approximation to be used while a refresh fails; it is evidence the gate has
 *    already declared too old. A failed refresh returns the fault, and the gate
 *    vetoes. Fail closed, like every other path in the arbiter.
 *  - **Concurrent misses share one call.** Evaluating a watchlist fans out, and
 *    without de-duplication every token in flight would issue its own identical
 *    `market_overview` — the exact burst the pacer exists to avoid.
 */
export class MarketContextCache {
  private entry: { envelope: RyoEnvelope; raw: unknown; at: number; latencyMs: number } | null = null;
  private inflight: Promise<void> | null = null;

  constructor(private readonly ttlMs: number = config.invariants.maxContextAgeMs) {}

  /** Drop the cached read, so the next call goes upstream. Used by the chaos lab. */
  invalidate(): void {
    this.entry = null;
  }

  async read(ryo: InterceptedRyo): Promise<ContextRead> {
    const fresh = this.fresh();
    if (fresh) return fresh;

    if (!this.inflight) {
      this.inflight = this.refresh(ryo).finally(() => {
        this.inflight = null;
      });
    }

    let fault: { code: string; message: string } | null = null;
    try {
      await this.inflight;
    } catch (err) {
      fault = faultOf(err);
    }

    // This call performed the fetch (or waited on the one that did), so the round-trip
    // it measured belongs to this decision rather than to a cached read.
    const after = this.fresh();
    if (after) return { ...after, cached: false, latencyMs: this.entry?.latencyMs ?? 0 };
    return {
      context: null,
      fault: fault ?? {
        code: 'NO_CONTEXT',
        message: 'market_overview returned no usable market context',
      },
      raw: null,
      latencyMs: 0,
      cached: false,
    };
  }

  /** The cached read, if it is still inside the TTL. */
  private fresh(): ContextRead | null {
    if (!this.entry) return null;
    const ageMs = Date.now() - this.entry.at;
    if (ageMs > this.ttlMs) return null;

    const context = extractContext(this.entry.envelope, ageMs);
    if (context === null) return null;
    return {
      context,
      fault: null,
      raw: this.entry.raw,
      // A cached read costs no round-trip. Reporting the original call's latency here
      // would charge one decision's wall clock to every later decision that reused it.
      latencyMs: 0,
      cached: true,
    };
  }

  private async refresh(ryo: InterceptedRyo): Promise<void> {
    const res = await ryo.call('market_overview', {});
    this.entry = { envelope: res.payload, raw: res.raw, at: Date.now(), latencyMs: res.latencyMs };
  }
}

function faultOf(err: unknown): { code: string; message: string } {
  if (err instanceof SchemaMismatchError) return { code: err.code, message: err.message };
  if (err instanceof EngineError) return { code: err.code, message: err.message };
  return { code: 'UNKNOWN_FAULT', message: err instanceof Error ? err.message : String(err) };
}
