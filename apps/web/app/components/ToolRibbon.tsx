'use client';

import { TOOL_NAMES, type ChaosState, type ToolPulse } from '../types';
import { Dot } from './Panel';
import { SIGNAL_DOT, SIGNAL_RING, SIGNAL_TEXT, formatLatency, statusSignal } from '../signal';

/**
 * Seven micro-cards, one per live tool. A chaos-targeted tool flips to rose the
 * instant its next pulse lands, which is the fastest visible proof that the injector
 * reached the transport rather than the UI.
 */
export function ToolRibbon({
  pulses,
  chaos,
}: {
  pulses: Partial<Record<string, ToolPulse>>;
  chaos: ChaosState[];
}) {
  return (
    // 7 tools tile evenly into neither 2 nor 4 columns, so the last chip absorbs the
    // remainder at both breakpoints until the full 7-across ribbon fits at xl.
    <div className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-border bg-border [&>*:last-child]:col-span-2 sm:grid-cols-4 xl:grid-cols-7 xl:[&>*:last-child]:col-span-1">
      {TOOL_NAMES.map((tool) => {
        const pulse = pulses[tool];
        const injected = chaos.find((c) => c.tool === tool || c.tool === '*');
        const signal = pulse ? statusSignal(pulse.status, pulse.latencyMs) : 'idle';

        return (
          <div
            key={tool}
            className={`group relative flex min-w-0 flex-col gap-1.5 bg-surface px-3 py-2.5 transition-colors ${
              signal === 'halt' ? 'bg-rose/[0.04]' : ''
            }`}
            title={pulse?.detail ?? tool}
          >
            <div className="flex items-center gap-1.5">
              <Dot className={SIGNAL_DOT[signal]} pulse={signal === 'ok'} />
              <span className="truncate text-2xs tracking-tight text-text-muted">{tool}</span>
            </div>
            <div className="flex items-baseline justify-between gap-2">
              <span className={`tnum text-sm font-medium ${SIGNAL_TEXT[signal]}`}>
                {pulse ? formatLatency(pulse.latencyMs) : '—'}
              </span>
              {injected ? (
                <span className="rounded-sm border border-rose/40 bg-rose/10 px-1 py-px text-[9px] font-medium uppercase tracking-[0.08em] text-rose">
                  {injected.action}
                </span>
              ) : null}
            </div>
            <span
              className={`truncate text-[9px] uppercase tracking-[0.1em] ${
                signal === 'halt' ? 'text-rose/80' : 'text-text-muted/70'
              }`}
            >
              {pulse?.status ?? 'no data'}
            </span>
            <span
              aria-hidden
              className={`pointer-events-none absolute inset-x-0 top-0 h-px ${SIGNAL_DOT[signal]} opacity-40`}
            />
          </div>
        );
      })}
    </div>
  );
}
