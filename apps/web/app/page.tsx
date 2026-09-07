'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTelemetry } from './useTelemetry';
import type { EvidenceProbe, LedgerRecord, ToolName, VerificationResult } from './types';
import { Dot, Panel } from './components/Panel';
import { ToolRibbon } from './components/ToolRibbon';
import { DecisionGate } from './components/DecisionGate';
import { ChaosInjector } from './components/ChaosInjector';
import { FlightRecorder } from './components/FlightRecorder';
import { AuditDrawer } from './components/AuditDrawer';
import { formatSeq } from './signal';
import { QuickStart } from './components/QuickStart';

interface Health {
  connected: boolean;
  transport: string;
  connect_error: string | null;
  ledger_path: string;
  journal_mode: string;
  ledger_count: number;
  invariants: { maxLatencyMs: number; maxAsOfAgeMs: number };
  mcp_endpoint: string;
  evidence_probe: EvidenceProbe | null;
  quota: { limit: number | null; remaining: number | null; reset: number | null } | null;
}

export default function FlightTerminal() {
  const telemetry = useTelemetry();
  const [health, setHealth] = useState<Health | null>(null);
  const [watchlist, setWatchlist] = useState<Array<{ symbol: string; address?: string }>>([]);
  const [symbol, setSymbol] = useState('');
  const [target, setTarget] = useState<ToolName>('analyze_token');
  const [delayMs, setDelayMs] = useState(2500);
  const [busy, setBusy] = useState(false);

  const [inspected, setInspected] = useState<LedgerRecord | null>(null);
  const [verification, setVerification] = useState<VerificationResult | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [chainResult, setChainResult] = useState<{ valid: boolean; length: number } | null>(null);

  const refreshMeta = useCallback(async () => {
    try {
      const [h, t] = await Promise.all([
        fetch('/api/health').then((r) => r.json() as Promise<Health>),
        fetch('/api/tools').then((r) => r.json() as Promise<{ watchlist: Array<{ symbol: string }> }>),
      ]);
      setHealth(h);
      setWatchlist(t.watchlist ?? []);
      setSymbol((s) => s || t.watchlist?.[0]?.symbol || '');
    } catch {
      setHealth(null);
    }
  }, []);

  useEffect(() => {
    void refreshMeta();
    const id = setInterval(() => void refreshMeta(), 5000);
    return () => clearInterval(id);
  }, [refreshMeta]);

  const post = useCallback(async (url: string, body: unknown) => {
    setBusy(true);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return (await res.json()) as unknown;
    } finally {
      setBusy(false);
    }
  }, []);

  const handleChaos = useCallback(
    (action: 'DROP' | 'DELAY' | 'RESET', tool?: ToolName | '*') => {
      const t = tool ?? target;
      void post('/api/chaos/toggle', action === 'DELAY' ? { tool: t, action, delayMs } : { tool: t, action });
    },
    [post, target, delayMs],
  );

  const handleEvaluate = useCallback(
    (sym: string) => void post('/api/evaluate', { symbol: sym }),
    [post],
  );

  const handleVerify = useCallback(
    async (receiptId: string) => {
      setVerifying(true);
      try {
        setVerification((await post('/api/verify', { receipt_id: receiptId })) as VerificationResult);
      } finally {
        setVerifying(false);
      }
    },
    [post],
  );

  const inspect = useCallback(
    (record: LedgerRecord) => {
      setInspected(record);
      setVerification(null);
      void handleVerify(record.receipt_id);
    },
    [handleVerify],
  );

  const verifyChain = useCallback(async () => {
    const res = (await fetch('/api/verify/chain').then((r) => r.json())) as {
      valid: boolean;
      length: number;
    };
    setChainResult(res);
  }, []);

  const latest = telemetry.verdicts[0] ?? null;
  const headSeq = telemetry.records[0]?.seq ?? health?.ledger_count ?? 0;

  /** Best gate evaluation observed this session — a live figure, not a transcribed one. */
  const minGateMicros = useMemo(() => {
    if (telemetry.verdicts.length === 0) return null;
    return Math.min(...telemetry.verdicts.map((v) => v.evaluationMicros));
  }, [telemetry.verdicts]);

  // Two independent signals: the browser's SSE socket, and the engine's MCP session.
  // The peer can be down while the stream is perfectly healthy — that is precisely the
  // state a chaos DROP produces, so conflating them would hide the thing being tested.
  const streamLive = telemetry.streamState === 'OPEN';
  const peerLive = Boolean(health?.connected);

  return (
    <div className="min-h-screen bg-canvas">
      <div className="mx-auto max-w-[1440px] px-4 py-4 lg:px-6">
        {/* ── HEADER ─────────────────────────────────────────────────────── */}
        <header className="mb-3 flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
          <div className="flex items-baseline gap-3">
            <h1 className="text-sm font-medium tracking-tight text-text-primary">
              KURA <span className="text-text-muted">// FLIGHT TERMINAL</span>
            </h1>
            <span className="hidden text-2xs tracking-tight text-text-muted sm:inline">
              deterministic invariant arbiter · RYO-CHAN
            </span>
          </div>

          <div className="flex items-center gap-4">
            <span className="flex items-center gap-1.5 text-2xs uppercase tracking-[0.1em]">
              <Dot className={streamLive ? 'bg-emerald' : 'bg-rose'} pulse={streamLive} />
              <span className={streamLive ? 'text-emerald' : 'text-rose'}>
                SSE {streamLive ? 'LIVE' : telemetry.streamState}
              </span>
            </span>
            <span className="tnum text-2xs text-text-muted">HEIGHT {formatSeq(headSeq)}</span>
            <span className="hidden items-center gap-1.5 text-2xs uppercase tracking-[0.1em] md:flex">
              <Dot className={peerLive ? 'bg-emerald' : 'bg-rose'} />
              <span className={peerLive ? 'text-text-muted' : 'text-rose'}>
                MCP {peerLive ? 'CONNECTED' : 'DOWN'}
              </span>
            </span>
          </div>
        </header>

        {health?.evidence_probe && !health.evidence_probe.resolved ? (
          <p
            role="alert"
            className="mb-3 rounded border border-amber/40 bg-amber/[0.07] px-3 py-2 text-xs text-amber"
          >
            <b>SCHEMA RESOLUTION WARNING</b> — expected measurement paths not resolved;
            falling back to strict veto mode. {health.evidence_probe.detail}
          </p>
        ) : null}

        {telemetry.backoffs.length > 0 ? (
          <p className="mb-3 rounded border border-amber/30 bg-amber/[0.05] px-3 py-2 text-2xs text-amber">
            <b>UPSTREAM BACKOFF</b> — {telemetry.backoffs.length} in this session · latest{' '}
            {telemetry.backoffs[0]!.reason} after {telemetry.backoffs[0]!.delayMs}ms
            {telemetry.backoffs[0]!.fromRetryAfter ? ' (server Retry-After)' : ' (full jitter)'}
            {telemetry.backoffs[0]!.rateLimit?.remaining !== null &&
            telemetry.backoffs[0]!.rateLimit !== null
              ? ` · quota ${telemetry.backoffs[0]!.rateLimit!.remaining}/${telemetry.backoffs[0]!.rateLimit!.limit}`
              : ''}
          </p>
        ) : null}

        {health?.connect_error ? (
          <p
            role="alert"
            className="mb-3 rounded border border-rose/40 bg-rose/[0.07] px-3 py-2 text-xs text-rose"
          >
            {health.connect_error}
          </p>
        ) : null}

        {/* ── INTEGRATION DRAWER ─────────────────────────────────────────── */}
        <QuickStart mcpEndpoint={health?.mcp_endpoint ?? 'http://localhost:4000/mcp'} />

        {/* ── TIER 1: TOOL RIBBON ────────────────────────────────────────── */}
        <div className="mb-3">
          <ToolRibbon pulses={telemetry.pulses} chaos={telemetry.chaos} />
        </div>

        {/* ── TIER 2: GATE (60%) + INJECTOR (40%) ────────────────────────── */}
        <div className="mb-3 grid grid-cols-1 gap-3 lg:grid-cols-5">
          <Panel
            title="Invariant decision gate"
            className="lg:col-span-3"
            meta={
              latest ? (
                <span className="tnum text-2xs text-text-muted">
                  {new Date(latest.at).toLocaleTimeString()}
                </span>
              ) : null
            }
          >
            <DecisionGate verdict={latest} faults={telemetry.errors} />
          </Panel>

          <Panel
            title="Adversarial chaos injector"
            className="lg:col-span-2"
            meta={
              telemetry.chaos.length > 0 ? (
                <span className="rounded-sm border border-rose/40 bg-rose/10 px-1.5 py-px text-[9px] uppercase tracking-[0.1em] text-rose">
                  {telemetry.chaos.length} active
                </span>
              ) : (
                <span className="text-[9px] uppercase tracking-[0.1em] text-text-muted/60">nominal</span>
              )
            }
          >
            <ChaosInjector
              chaos={telemetry.chaos}
              busy={busy}
              target={target}
              delayMs={delayMs}
              symbol={symbol}
              watchlist={watchlist}
              minGateMicros={minGateMicros}
              lastVerifyMs={verification?.elapsed_ms ?? null}
              onTarget={setTarget}
              onDelay={setDelayMs}
              onSymbol={setSymbol}
              onChaos={handleChaos}
              onEvaluate={handleEvaluate}
            />
          </Panel>
        </div>

        {/* ── TIER 3: FLIGHT RECORDER ────────────────────────────────────── */}
        <Panel
          title="Flight recorder · real-time immutable WAL ledger"
          meta={
            <>
              {chainResult ? (
                <span
                  className={`tnum text-2xs ${chainResult.valid ? 'text-emerald' : 'text-rose'}`}
                >
                  {chainResult.valid
                    ? `✓ chain intact · ${chainResult.length} blocks`
                    : '✕ chain broken'}
                </span>
              ) : null}
              <span className="tnum hidden text-2xs text-text-muted lg:inline">
                {health?.journal_mode ?? '—'} · {health?.ledger_count ?? 0} blocks
              </span>
              <button
                type="button"
                onClick={() => void verifyChain()}
                className="rounded border border-border px-2 py-0.5 text-2xs text-text-muted transition-colors hover:border-border-bright hover:text-text-primary"
              >
                verify chain
              </button>
            </>
          }
        >
          <FlightRecorder
            records={telemetry.records}
            selectedId={inspected?.receipt_id ?? null}
            onInspect={inspect}
          />
        </Panel>

        <footer className="mt-3 flex flex-wrap items-center justify-between gap-x-6 gap-y-1 text-[10px] text-text-muted/70">
          <span className="tnum truncate">{health?.ledger_path ?? '—'}</span>
          <span className="tnum">
            latency ≤ {health?.invariants.maxLatencyMs ?? '—'}ms · observation ≤{' '}
            {((health?.invariants.maxAsOfAgeMs ?? 0) / 1000).toFixed(0)}s
            {health?.evidence_probe?.resolved
              ? ` · evidence: ${health.evidence_probe.atrPath}`
              : ''}
          </span>
        </footer>
      </div>

      <AuditDrawer
        record={inspected}
        verification={verification}
        verifying={verifying}
        onClose={() => setInspected(null)}
        onVerify={handleVerify}
      />
    </div>
  );
}
