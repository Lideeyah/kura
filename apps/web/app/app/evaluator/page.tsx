'use client';

import { useCallback, useState } from 'react';
import { useConsole } from '../TelemetryProvider';
import { Button, Metric, Panel, PageTitle, Spinner } from '../ui';
import { GATE_LABEL, formatLatency, formatMicros } from '../../signal';
import type { ArbiterVerdict, InvariantResult, LedgerRecord } from '../../types';

export default function EvaluatorPage() {
  const { health, watchlist, busy, evaluate } = useConsole();
  const [symbol, setSymbol] = useState('SOL');
  const [open, setOpen] = useState<string | null>(null);

  /**
   * This page shows the result of the evaluation *you* ran, taken from the POST
   * response — not the newest verdict on the shared stream. The autonomous loop and
   * the Chaos Lab both publish there, so reading the stream here would answer a
   * question the operator did not ask.
   */
  const [result, setResult] = useState<{ verdict: ArbiterVerdict; record: LedgerRecord } | null>(null);

  const run = useCallback(async () => {
    if (!symbol) return;
    const res = (await evaluate(symbol.trim().toUpperCase())) as {
      verdict: ArbiterVerdict;
      record: LedgerRecord;
    };
    setResult(res);
    setOpen(null);
  }, [evaluate, symbol]);

  const verdict = result?.verdict ?? null;
  const record = result?.record ?? null;

  return (
    <>
      <PageTitle
        title="Pre-Trade Evaluator"
        blurb="Run one candidate through the four deterministic gates and read the exact values each one saw. No model is consulted at any point on this path."
      />

      {/* A — Candidate input */}
      <Panel className="mb-4">
        <form
          className="flex flex-wrap items-center gap-3 p-4"
          onSubmit={(e) => {
            e.preventDefault();
            void run();
          }}
        >
          <label htmlFor="symbol" className="text-2xs uppercase tracking-[0.1em] text-text-muted">
            Candidate
          </label>
          <input
            id="symbol"
            list="kura-watchlist"
            value={symbol}
            onChange={(e) => setSymbol(e.target.value.toUpperCase())}
            placeholder="SYMBOL"
            className="tnum w-40 rounded border border-border bg-surface-2 px-2.5 py-1.5 text-xs uppercase text-text-primary outline-none transition-colors placeholder:text-text-dim hover:border-border-strong focus:border-border-strong"
          />
          <datalist id="kura-watchlist">
            {watchlist.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>

          <Button type="submit" tone="primary" disabled={busy || !symbol}>
            {busy ? (
              <span className="flex items-center gap-2">
                <Spinner /> Evaluating
              </span>
            ) : (
              'Evaluate Candidate'
            )}
          </Button>

          <span className="ml-auto flex flex-wrap gap-1.5">
            {watchlist.slice(0, 6).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSymbol(s)}
                className="tnum rounded border border-border px-2 py-1 text-2xs text-text-muted transition-colors hover:border-border-strong hover:text-text-primary"
              >
                {s}
              </button>
            ))}
          </span>
        </form>
      </Panel>

      {/* B — Verdict */}
      {!verdict ? (
        <Panel className="mb-4">
          <p className="p-10 text-center text-xs text-text-muted">
            No evaluation yet. Enter a symbol above and run one.
          </p>
        </Panel>
      ) : (
        <Panel className="mb-4">
          <div
            className={`flex flex-wrap items-start gap-x-14 gap-y-5 border-b px-5 py-5 ${
              verdict.decision === 'APPROVED'
                ? 'border-approved/20 bg-approved/[0.04]'
                : 'border-veto/20 bg-veto/[0.05]'
            }`}
          >
            <Metric label="Target" value={<>{verdict.token}<span className="text-text-muted">/USDC</span></>} />
            <Metric
              label="Verdict"
              value={verdict.decision === 'APPROVED' ? 'APPROVED' : 'VETO_HALT'}
              tone={verdict.decision === 'APPROVED' ? 'text-approved' : 'text-veto'}
            />
            <Metric
              label="Sizing allocation"
              value={
                verdict.sizing ? (
                  <>
                    {verdict.sizing.pctOfCap.toFixed(3)}%
                    <span className="ml-1.5 text-2xs text-text-muted">of bankroll cap</span>
                  </>
                ) : (
                  <>
                    0.000%
                    <span className="ml-1.5 text-2xs text-text-muted">capital protected</span>
                  </>
                )
              }
            />
          </div>

          <p
            className={`px-5 py-3 text-xs leading-relaxed ${
              verdict.decision === 'APPROVED' ? 'text-approved/90' : 'text-veto/90'
            }`}
          >
            {verdict.reason}
          </p>

          <div className="grid grid-cols-2 gap-x-10 gap-y-4 border-t border-border px-5 py-4 sm:grid-cols-4">
            <Metric label="Gate time" value={formatMicros(verdict.evaluationMicros)} />
            <Metric label="Round trip" value={formatLatency(verdict.latencyMs)} />
            <Metric label="Upstream status" value={verdict.status ?? '—'} />
            <Metric label="Data mode" value={verdict.dataMode ?? '—'} />
          </div>
        </Panel>
      )}

      {/* C — Gate matrix */}
      {verdict ? (
        <Panel title="Invariant matrix" meta={<span className="text-2xs text-text-dim">click a row for the field that decided it</span>}>
          <ol>
            {verdict.invariants.map((inv) => (
              <GateRow
                key={inv.id}
                inv={inv}
                open={open === inv.id}
                onToggle={() => setOpen(open === inv.id ? null : inv.id)}
                rawPayload={record?.raw_payload_json ?? null}
              />
            ))}
          </ol>
          {verdict.sizing ? (
            <p className="border-t border-border px-5 py-3 text-2xs leading-relaxed text-text-dim">
              Heuristic volatility-adjusted sizing cap, not a Kelly proof — confidence is
              derived from measured volatility ({(verdict.sizing.inputs.atrPct * 100).toFixed(2)}%
              ATR) and evidence completeness, not from an estimated edge.
              {verdict.sizing.clampedBy === 'MAX_POSITION_PCT' ? ' Allocation clamped at the hard cap.' : ''}
              {verdict.sizing.clampedBy === 'HYPER_VOLATILITY' ? ' Refused: ATR at or above 50% of price.' : ''}
            </p>
          ) : null}
        </Panel>
      ) : null}

      {health?.evidence_probe && !health.evidence_probe.resolved ? (
        <p role="alert" className="mt-4 rounded border border-warn/40 bg-warn/[0.06] px-4 py-2.5 text-xs text-warn">
          <b>SCHEMA RESOLUTION WARNING</b> — {health.evidence_probe.detail}
        </p>
      ) : null}
    </>
  );
}

const STATE_TONE = {
  PASS: 'text-approved',
  FAIL: 'text-veto',
  NOT_EVALUATED: 'text-text-dim',
} as const;

const GLYPH = { PASS: '✓', FAIL: '✕', NOT_EVALUATED: '—' } as const;

/** Which slice of the raw envelope each gate actually read. */
function evidenceFor(id: string, raw: string | null): string {
  if (!raw) return 'no payload recorded for this evaluation';
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }
  const env = parsed.analyze_token;
  if (!env) return JSON.stringify({ fault: parsed.fault }, null, 2);

  switch (id) {
    case 'FRESHNESS':
      return JSON.stringify({ as_of: env.as_of, latency: parsed.latency, fault: parsed.fault }, null, 2);
    case 'ORACLE':
      return JSON.stringify({ status: env.status, warnings: env.warnings, availability: env.availability }, null, 2);
    case 'PROVENANCE':
      return JSON.stringify({ data_mode: env.data_mode, schema_version: env.schema_version }, null, 2);
    case 'EVIDENCE':
      return JSON.stringify({ signals: parsed.signals, data: env.data }, null, 2);
    default:
      return JSON.stringify(env, null, 2);
  }
}

function GateRow({
  inv,
  open,
  onToggle,
  rawPayload,
}: {
  inv: InvariantResult;
  open: boolean;
  onToggle: () => void;
  rawPayload: string | null;
}) {
  const skipped = inv.state === 'NOT_EVALUATED';
  return (
    <li className="border-b border-border last:border-0">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className={`flex w-full items-center gap-4 px-5 py-4 text-left transition-colors hover:bg-surface-2 ${
          skipped ? 'opacity-45' : ''
        }`}
      >
        <span className={`tnum w-4 shrink-0 text-center text-sm ${STATE_TONE[inv.state]}`}>
          {GLYPH[inv.state]}
        </span>
        <span className="w-44 shrink-0 text-2xs uppercase tracking-[0.1em] text-text-primary">
          {GATE_LABEL[inv.id] ?? inv.id}
        </span>
        <span className="tnum min-w-0 flex-1 truncate text-xs text-text-muted">
          {skipped ? 'SHORT-CIRCUITED' : inv.actual}
        </span>
        <span className="tnum hidden shrink-0 text-2xs text-text-dim lg:block">{inv.expected}</span>
        <span className="shrink-0 text-2xs text-text-dim">{open ? '−' : '+'}</span>
      </button>

      {open ? (
        <div className="animate-fade-up border-t border-border bg-surface-2 px-5 py-4">
          <p className="mb-3 text-xs leading-relaxed text-text-muted">{inv.detail}</p>
          <div className="mb-2 flex items-baseline gap-3">
            <span className="text-2xs uppercase tracking-[0.1em] text-text-dim">Predicate</span>
            <code className="tnum text-2xs text-text-muted">{inv.predicate}</code>
          </div>
          <pre className="tnum max-h-64 overflow-auto rounded border border-border bg-canvas p-3 text-[11px] leading-relaxed text-text-muted">
            {evidenceFor(inv.id, rawPayload)}
          </pre>
        </div>
      ) : null}
    </li>
  );
}
