'use client';

import { useEffect, useRef, useState } from 'react';
import type {
  ArbiterVerdict,
  BackoffEvent,
  ChaosState,
  LedgerRecord,
  TelemetryEvent,
  ToolName,
  ToolPulse,
} from './types';

export type StreamState = 'OPEN' | 'CONNECTING' | 'CLOSED';

export interface TelemetryState {
  streamState: StreamState;
  connected: boolean;
  transport: string;
  pulses: Partial<Record<ToolName, ToolPulse>>;
  verdicts: ArbiterVerdict[];
  records: LedgerRecord[];
  chaos: ChaosState[];
  errors: Array<{ code: string; message: string; at: string }>;
  backoffs: BackoffEvent[];
}

const EMPTY: TelemetryState = {
  streamState: 'CONNECTING',
  connected: false,
  transport: '',
  pulses: {},
  verdicts: [],
  records: [],
  chaos: [],
  errors: [],
  backoffs: [],
};

const MAX_VERDICTS = 25;
const MAX_RECORDS = 200;
const MAX_ERRORS = 15;

/**
 * Single EventSource against GET /api/stream. The engine replays its recent ring
 * buffer on connect, so a page load mid-session is not staring at an empty table.
 */
export function useTelemetry(): TelemetryState {
  const [state, setState] = useState<TelemetryState>(EMPTY);
  const sourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const source = new EventSource('/api/stream');
    sourceRef.current = source;

    // EventSource reconnects on its own after a transient drop, so a single onerror
    // does not mean the stream is dead. Read the real readyState instead of latching
    // a boolean that a StrictMode double-mount or one blip can leave stuck on false.
    const syncReadyState = () =>
      setState((s) => {
        const next: StreamState =
          source.readyState === EventSource.OPEN
            ? 'OPEN'
            : source.readyState === EventSource.CONNECTING
              ? 'CONNECTING'
              : 'CLOSED';
        return s.streamState === next ? s : { ...s, streamState: next };
      });

    source.onopen = syncReadyState;
    source.onerror = syncReadyState;
    const readyStatePoll = setInterval(syncReadyState, 1000);

    const handle = (raw: MessageEvent<string>) => {
      let event: TelemetryEvent;
      try {
        event = JSON.parse(raw.data) as TelemetryEvent;
      } catch {
        return;
      }
      setState((s) => reduce(s, event));
    };

    for (const type of ['hello', 'tool_pulse', 'connection', 'verdict', 'ledger', 'chaos', 'rate_limit', 'error']) {
      source.addEventListener(type, handle as EventListener);
    }

    return () => {
      clearInterval(readyStatePoll);
      source.close();
      sourceRef.current = null;
    };
  }, []);

  return state;
}

function reduce(s: TelemetryState, event: TelemetryEvent): TelemetryState {
  switch (event.type) {
    case 'hello':
      return { ...s, streamState: 'OPEN', connected: event.connected, chaos: event.chaos };
    case 'connection':
      return { ...s, connected: event.connected, transport: event.transport };
    case 'tool_pulse':
      return { ...s, pulses: { ...s.pulses, [event.pulse.tool]: event.pulse } };
    case 'verdict':
      return { ...s, verdicts: [event.verdict, ...s.verdicts].slice(0, MAX_VERDICTS) };
    case 'ledger':
      return s.records.some((r) => r.receipt_id === event.record.receipt_id)
        ? s
        : { ...s, records: [event.record, ...s.records].slice(0, MAX_RECORDS) };
    case 'chaos':
      return { ...s, chaos: event.chaos };
    case 'rate_limit':
      return { ...s, backoffs: [event.backoff, ...s.backoffs].slice(0, 12) };
    case 'error':
      return {
        ...s,
        errors: [{ code: event.code, message: event.message, at: event.at }, ...s.errors].slice(0, MAX_ERRORS),
      };
    default:
      return s;
  }
}
