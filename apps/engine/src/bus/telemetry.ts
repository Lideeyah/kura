import { EventEmitter } from 'node:events';
import type { ToolName } from '../schema/tools.js';
import type { LedgerRecord } from '../ledger/ledger.js';
import type { ArbiterVerdict } from '../arbiter/invariants.js';
import type { BackoffEvent } from '../mcp/retry.js';

export type CallStatus = 'OK' | 'DROPPED' | 'TIMEOUT' | 'SCHEMA_MISMATCH_OR_MISSING_FIELD' | 'TRANSPORT_ERROR';

export interface ToolPulse {
  tool: ToolName;
  latencyMs: number;
  status: CallStatus;
  at: string;
  detail?: string;
}

export interface ChaosState {
  tool: ToolName | '*';
  action: 'DROP' | 'DELAY' | 'RESET';
  delayMs?: number;
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

/**
 * Single in-process fan-out point. Every SSE subscriber attaches here; nothing in the
 * engine writes to a socket directly.
 */
class TelemetryBus extends EventEmitter {
  private readonly ring: TelemetryEvent[] = [];
  private readonly ringSize = 200;

  constructor() {
    super();
    this.setMaxListeners(0);
  }

  publish(event: TelemetryEvent): void {
    this.ring.push(event);
    if (this.ring.length > this.ringSize) this.ring.shift();
    this.emit('event', event);
  }

  /** Replayed to a new SSE client so a late connection is not staring at a blank page. */
  replay(): TelemetryEvent[] {
    return [...this.ring];
  }

  subscribe(listener: (event: TelemetryEvent) => void): () => void {
    this.on('event', listener);
    return () => this.off('event', listener);
  }
}

export const bus = new TelemetryBus();
