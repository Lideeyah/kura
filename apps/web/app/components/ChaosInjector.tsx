'use client';

import { TOOL_NAMES, type ChaosState, type ToolName } from '../types';
import { FAULT_LABEL, RESILIENCE } from '../benchmarks';
import { formatMicros } from '../signal';

interface Props {
  chaos: ChaosState[];
  busy: boolean;
  target: ToolName;
  delayMs: number;
  symbol: string;
  watchlist: Array<{ symbol: string }>;
  minGateMicros: number | null;
  lastVerifyMs: number | null;
  onTarget: (t: ToolName) => void;
  onDelay: (ms: number) => void;
  onSymbol: (s: string) => void;
  onChaos: (action: 'DROP' | 'DELAY' | 'RESET', tool?: ToolName | '*') => void;
  onEvaluate: (symbol: string) => void;
}

const ACTION_BUTTON =
  'w-full rounded border px-3 py-2 text-left text-xs tracking-tight transition-colors disabled:cursor-not-allowed disabled:opacity-40';

export function ChaosInjector({
  chaos,
  busy,
  target,
  delayMs,
  symbol,
  watchlist,
  minGateMicros,
  lastVerifyMs,
  onTarget,
  onDelay,
  onSymbol,
  onChaos,
  onEvaluate,
}: Props) {
  const active = chaos.length > 0;

  return (
    <div className="flex h-full flex-col">
      <div className="space-y-3 px-3 py-3">
        {/* Target selector */}
        <label className="block">
          <span className="mb-1 block text-2xs uppercase tracking-[0.1em] text-text-muted">
            Fault target
          </span>
          <select
            value={target}
            onChange={(e) => onTarget(e.target.value as ToolName)}
            className="tnum w-full rounded border border-border bg-surface-subtle px-2 py-1.5 text-xs text-text-primary outline-none transition-colors hover:border-border-bright focus:border-border-bright"
          >
            {TOOL_NAMES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>

        {/* Injection actions */}
        <div className="space-y-1.5">
          <button
            type="button"
            disabled={busy}
            onClick={() => onChaos('DROP')}
            className={`${ACTION_BUTTON} border-rose/30 bg-rose/[0.07] text-rose hover:border-rose/60 hover:bg-rose/[0.12]`}
          >
            <span className="mr-2">◉</span>DROP {target} <span className="text-rose/60">(503)</span>
          </button>

          <button
            type="button"
            disabled={busy}
            onClick={() => onChaos('DELAY')}
            className={`${ACTION_BUTTON} border-amber/30 bg-amber/[0.07] text-amber hover:border-amber/60 hover:bg-amber/[0.12]`}
          >
            <span className="mr-2">◉</span>INJECT <span className="tnum">{delayMs}ms</span> latency
          </button>

          <input
            type="range"
            min={0}
            max={5000}
            step={50}
            value={delayMs}
            onChange={(e) => onDelay(Number(e.target.value))}
            aria-label="Injected delay in milliseconds"
            className="h-1 w-full cursor-pointer appearance-none rounded-full bg-border accent-amber"
          />
          <div className="tnum flex justify-between text-[9px] text-text-muted">
            <span>0</span>
            <span className="text-amber/70">ceiling 1200ms</span>
            <span>5000</span>
          </div>

          <button
            type="button"
            disabled={busy}
            onClick={() => onEvaluate('BADEV')}
            className={`${ACTION_BUTTON} border-rose/30 bg-rose/[0.07] text-rose hover:border-rose/60 hover:bg-rose/[0.12]`}
          >
            <span className="mr-2">◉</span>MALFORMED envelope
            <span className="ml-1 text-rose/60">(drops data_mode)</span>
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onEvaluate('SIMUL')}
            className={`${ACTION_BUTTON} border-rose/30 bg-rose/[0.07] text-rose hover:border-rose/60 hover:bg-rose/[0.12]`}
          >
            <span className="mr-2">◉</span>SIMULATED data
            <span className="ml-1 text-rose/60">(data_mode !== live)</span>
          </button>
        </div>

        {/* Evaluate + reset */}
        <div className="flex gap-1.5 border-t border-border pt-3">
          <input
            list="kura-watchlist"
            value={symbol}
            onChange={(e) => onSymbol(e.target.value.toUpperCase())}
            placeholder="SYMBOL"
            aria-label="Token symbol"
            className="tnum min-w-0 flex-1 rounded border border-border bg-surface-subtle px-2 py-1.5 text-xs uppercase text-text-primary outline-none transition-colors placeholder:text-text-muted/50 hover:border-border-bright focus:border-border-bright"
          />
          <datalist id="kura-watchlist">
            {watchlist.map((t) => (
              <option key={t.symbol} value={t.symbol} />
            ))}
          </datalist>
          <button
            type="button"
            disabled={busy || !symbol}
            onClick={() => onEvaluate(symbol)}
            className="shrink-0 rounded border border-border-bright bg-surface-subtle px-3 py-1.5 text-xs tracking-tight text-text-primary transition-colors hover:bg-border disabled:opacity-40"
          >
            Evaluate
          </button>
        </div>

        <button
          type="button"
          disabled={busy || !active}
          onClick={() => onChaos('RESET', '*')}
          className={`${ACTION_BUTTON} border-border bg-surface-subtle text-center text-text-muted hover:border-border-bright hover:text-text-primary`}
        >
          RESET ALL FAULTS
          {active ? <span className="ml-2 text-rose">({chaos.length} active)</span> : null}
        </button>
      </div>

      {/* Diagnostics */}
      <div className="mt-auto border-t border-border px-3 py-3">
        <h3 className="mb-2 text-2xs uppercase tracking-[0.14em] text-text-muted">
          Benchmark diagnostics
        </h3>
        <dl className="space-y-1">
          <Diag
            label="Gate evaluation"
            value={minGateMicros === null ? '—' : formatMicros(minGateMicros)}
            note="best observed"
          />
          <Diag
            label="Receipt verification"
            value={lastVerifyMs === null ? '—' : `${lastVerifyMs.toFixed(3)}ms`}
            note="last audit"
          />
          {RESILIENCE.reports.map((r) => (
            <Diag
              key={r.fault}
              label={FAULT_LABEL[r.fault] ?? r.fault}
              value={`${r.medianMs}ms`}
              note={`p95 ${r.p95Ms}ms · ${r.trials}×`}
            />
          ))}
        </dl>
        <p className="mt-2 border-t border-border/60 pt-2 text-[9px] leading-relaxed text-text-muted/70">
          Recovery medians from {RESILIENCE.trialsPerClass} real trials per fault class ·
          chain intact across {RESILIENCE.chain.length} blocks
        </p>
      </div>
    </div>
  );
}

function Diag({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="truncate text-2xs text-text-muted">{label}</dt>
      <dd className="flex shrink-0 items-baseline gap-2">
        <span className="text-[9px] text-text-muted/60">{note}</span>
        <span className="tnum text-xs text-text-primary">{value}</span>
      </dd>
    </div>
  );
}
