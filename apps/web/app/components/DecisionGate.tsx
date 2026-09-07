'use client';

import type { ArbiterVerdict } from '../types';
import { Field } from './Panel';
import {
  GATE_GLYPH,
  GATE_LABEL,
  SIGNAL_TEXT,
  formatClock,
  formatLatency,
  formatMicros,
  formatUsd,
  invariantSignal,
  triggeredGate,
} from '../signal';

export function DecisionGate({
  verdict,
  faults,
}: {
  verdict: ArbiterVerdict | null;
  faults: Array<{ code: string; message: string; at: string }>;
}) {
  if (!verdict) {
    return (
      <div className="flex h-full min-h-[280px] items-center justify-center px-6 text-center">
        <p className="max-w-xs text-xs leading-relaxed text-text-muted">
          Awaiting first verdict. Run an evaluation from the injector, or wait for the
          autonomous cycle.
        </p>
      </div>
    );
  }

  const halted = verdict.decision === 'VETOED';
  const sizing = verdict.sizing;

  return (
    <div className="flex h-full flex-col">
      {/* Verdict headline */}
      <div
        className={`flex flex-wrap items-baseline justify-between gap-x-6 gap-y-3 border-b px-4 py-3.5 ${
          halted ? 'border-rose/20 bg-rose/[0.05]' : 'border-emerald/20 bg-emerald/[0.04]'
        }`}
      >
        <div className="min-w-0">
          <div className="text-2xs uppercase tracking-[0.14em] text-text-muted">Target</div>
          <div className="tnum mt-0.5 truncate text-lg font-medium tracking-tight text-text-primary">
            {verdict.token}
            <span className="text-text-muted">/USDC</span>
          </div>
        </div>

        <div className="min-w-0">
          <div className="text-2xs uppercase tracking-[0.14em] text-text-muted">Verdict</div>
          <div
            className={`mt-0.5 truncate text-lg font-medium tracking-tight ${
              halted ? 'text-rose' : 'text-emerald'
            }`}
          >
            {halted ? 'VETO_HALT' : 'APPROVED'}
          </div>
        </div>

        <div className="min-w-0">
          <div className="text-2xs uppercase tracking-[0.14em] text-text-muted">Sizing</div>
          <div className="tnum mt-0.5 truncate text-lg font-medium tracking-tight text-text-primary">
            {sizing ? `${(sizing.fraction * 100).toFixed(3)}%` : '0.000%'}
            <span className="ml-2 text-xs text-text-muted">
              {sizing ? formatUsd(sizing.positionUsd) : 'no capital at risk'}
            </span>
          </div>
        </div>
      </div>

      {/* The four gates */}
      <ol className="divide-y divide-border">
        {verdict.invariants.map((inv) => {
          const signal = invariantSignal(inv.state);
          const skipped = inv.state === 'NOT_EVALUATED';
          return (
            <li
              key={inv.id}
              className={`flex items-center gap-3 px-4 py-2.5 ${skipped ? 'opacity-45' : ''}`}
            >
              <span className={`tnum w-4 shrink-0 text-center text-sm ${SIGNAL_TEXT[signal]}`}>
                {GATE_GLYPH[inv.state]}
              </span>
              <span className="w-[9.5rem] shrink-0 truncate text-2xs uppercase tracking-[0.1em] text-text-primary">
                {GATE_LABEL[inv.id] ?? inv.id}
              </span>
              <span className="tnum min-w-0 flex-1 truncate text-xs text-text-muted" title={inv.detail}>
                {skipped ? 'SHORT-CIRCUITED' : inv.actual}
              </span>
              <span className="tnum hidden shrink-0 text-2xs text-text-muted/70 lg:block">
                {skipped ? '' : inv.expected}
              </span>
            </li>
          );
        })}
      </ol>

      {/* Reason sits directly under the gates it explains */}
      <div className="border-t border-border px-4 py-2.5">
        <p className={`text-xs leading-relaxed ${halted ? 'text-rose/90' : 'text-emerald/90'}`}>
          {verdict.reason}
        </p>
      </div>

      {/* Fault tape — the structured errors the interceptor raised, newest first. */}
      <div className="min-h-0 flex-1 border-t border-border">
        <div className="flex items-center justify-between px-4 pt-2">
          <span className="text-2xs uppercase tracking-[0.14em] text-text-muted">Fault tape</span>
          <span className="tnum text-[9px] text-text-muted/60">
            {faults.length === 0 ? 'clear' : `${faults.length} recent`}
          </span>
        </div>
        <ul className="max-h-28 overflow-auto px-4 py-1.5">
          {faults.length === 0 ? (
            <li className="py-1 text-[10px] text-text-muted/60">
              No upstream faults raised this session.
            </li>
          ) : (
            faults.map((f, i) => (
              <li key={`${f.at}-${i}`} className="flex items-baseline gap-2 py-0.5">
                <span className="tnum shrink-0 text-[9px] text-text-muted/60">
                  {formatClock(f.at)}
                </span>
                <span className="shrink-0 rounded-sm border border-rose/30 bg-rose/[0.08] px-1 text-[9px] tracking-tight text-rose">
                  {f.code}
                </span>
                <span className="truncate text-[10px] text-text-muted" title={f.message}>
                  {f.message}
                </span>
              </li>
            ))
          )}
        </ul>
      </div>

      {/* Only the metrics strip is pinned, so the two sectors stay the same height */}
      <div className="mt-auto border-t border-border px-4 py-2.5">
        <div className="grid grid-cols-2 gap-x-6 sm:grid-cols-4">
          <Field label="Gate">{formatMicros(verdict.evaluationMicros)}</Field>
          <Field label="Upstream">{formatLatency(verdict.latencyMs)}</Field>
          <Field label="Status">{verdict.status ?? '—'}</Field>
          <Field label="Data mode">{verdict.dataMode ?? '—'}</Field>
          <Field label="Observation">
            {verdict.asOfAgeMs === null ? '—' : formatLatency(verdict.asOfAgeMs)}
          </Field>
          <Field label="Trigger">{triggeredGate(verdict.reason, verdict.failedInvariant)}</Field>
          <Field label="ATR">{sizing ? `${(sizing.inputs.atrPct * 100).toFixed(2)}%` : '—'}</Field>
          <Field label="p / Kelly">
            {sizing ? `${sizing.p.toFixed(3)} / ${sizing.fullKelly.toFixed(3)}` : '—'}
          </Field>
        </div>
        {sizing?.clampedBy === 'MAX_POSITION_PCT' ? (
          <p className="mt-1.5 text-2xs uppercase tracking-[0.1em] text-amber">
            ▲ risk cap engaged — size clamped at MAX_POSITION_PCT
          </p>
        ) : null}
      </div>
    </div>
  );
}
