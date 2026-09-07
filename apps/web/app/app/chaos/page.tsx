'use client';

import { useCallback, useState } from 'react';
import { useConsole } from '../TelemetryProvider';
import { Button, Panel, PageTitle, Spinner } from '../ui';
import { RESILIENCE, FAULT_LABEL } from '../../benchmarks';
import { formatClock, formatMicros } from '../../signal';
import type { ArbiterVerdict } from '../../types';

/**
 * The four production failure modes, each wired to the fault that actually causes it
 * upstream — not to a fixture that happens to look like it.
 */
const INJECTORS = [
  {
    action: 'DELAY',
    delayMs: 3000,
    label: 'Inject High Latency',
    detail: '3000ms upstream stall',
    gate: 'FRESHNESS',
  },
  {
    action: 'DEGRADE_STATUS',
    label: 'Simulate Degraded Oracle',
    detail: 'forces status = "partial"',
    gate: 'ORACLE',
  },
  {
    action: 'DEGRADE_MODE',
    label: 'Mock Synthetic Feed',
    detail: 'forces data_mode = "simulated"',
    gate: 'PROVENANCE',
  },
  {
    action: 'RATE_LIMIT',
    label: 'Simulate Upstream Rate Limit',
    detail: 'HTTP 429 → Retry-After, then full jitter',
    gate: 'FRESHNESS',
  },
] as const;

export default function ChaosPage() {
  const { telemetry, busy, setChaos, evaluate } = useConsole();
  const [running, setRunning] = useState<string | null>(null);
  // The verdict this page's own injection produced, not the newest on the shared stream.
  const [verdict, setVerdict] = useState<ArbiterVerdict | null>(null);

  const inject = useCallback(
    async (action: string, delayMs?: number) => {
      setRunning(action);
      try {
        await setChaos(action, 'analyze_token', delayMs);
        const res = (await evaluate('SOL')) as { verdict: ArbiterVerdict };
        setVerdict(res.verdict);
      } finally {
        setRunning(null);
      }
    },
    [setChaos, evaluate],
  );

  return (
    <>
      <PageTitle
        title="Chaos Lab"
        blurb="Break the upstream on purpose and watch the breaker respond. Each injector reproduces a real production failure mode; the rate limiter drives the same retry code that wraps every live HTTP request."
      />

      <div className="grid gap-4 lg:grid-cols-5">
        {/* A — Injectors */}
        <div className="space-y-4 lg:col-span-3">
          <Panel
            title="Adversarial fault injector"
            meta={
              telemetry.chaos.length > 0 ? (
                <span className="rounded-sm border border-veto/40 bg-veto/10 px-1.5 py-px text-2xs text-veto">
                  {telemetry.chaos.length} active
                </span>
              ) : (
                <span className="text-2xs text-text-dim">nominal</span>
              )
            }
          >
            <div className="divide-y divide-border">
              {INJECTORS.map((inj) => {
                const active = telemetry.chaos.some((c) => c.action === inj.action);
                return (
                  <div key={inj.action} className="flex items-center gap-4 px-4 py-3.5">
                    <div className="min-w-0 flex-1">
                      <div className="text-xs tracking-tight text-text-primary">{inj.label}</div>
                      <div className="tnum mt-0.5 text-2xs text-text-muted">{inj.detail}</div>
                    </div>
                    <span className="tnum hidden shrink-0 text-2xs text-text-dim sm:block">
                      → {inj.gate}
                    </span>
                    <Button
                      tone="veto"
                      disabled={busy}
                      onClick={() => void inject(inj.action, (inj as { delayMs?: number }).delayMs)}
                      className="shrink-0"
                    >
                      {running === inj.action ? (
                        <span className="flex items-center gap-2">
                          <Spinner /> firing
                        </span>
                      ) : active ? (
                        'Re-fire'
                      ) : (
                        'Inject'
                      )}
                    </Button>
                  </div>
                );
              })}
            </div>
            <div className="border-t border-border px-4 py-3">
              <Button
                disabled={busy || telemetry.chaos.length === 0}
                onClick={() => void setChaos('RESET', '*')}
                className="w-full"
              >
                Clear All Injected Faults
              </Button>
            </div>
          </Panel>

          {verdict ? (
            <Panel title="Last verdict under fire">
              <div className="flex flex-wrap items-baseline gap-x-8 gap-y-2 px-4 py-4">
                <span className="tnum text-sm text-text-primary">{verdict.token}</span>
                <span
                  className={`text-sm ${verdict.decision === 'APPROVED' ? 'text-approved' : 'text-veto'}`}
                >
                  {verdict.decision === 'APPROVED' ? 'APPROVED' : 'VETO_HALT'}
                </span>
                <span className="tnum text-2xs text-text-muted">
                  breaker {formatMicros(verdict.evaluationMicros)}
                </span>
                <span className="tnum text-2xs text-text-muted">
                  {verdict.failedInvariant ?? 'all gates passed'}
                </span>
              </div>
              <p className="border-t border-border px-4 py-3 text-xs leading-relaxed text-text-muted">
                {verdict.reason}
              </p>
            </Panel>
          ) : null}
        </div>

        {/* B — Recovery telemetry */}
        <div className="space-y-4 lg:col-span-2">
          <Panel title="Verified resilience" meta={<span className="text-2xs text-text-dim">{RESILIENCE.trialsPerClass} trials each</span>}>
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  <th className="px-4 py-2 text-left text-2xs font-medium uppercase tracking-[0.1em] text-text-dim">Fault</th>
                  <th className="px-2 py-2 text-right text-2xs font-medium uppercase tracking-[0.1em] text-text-dim">p50</th>
                  <th className="px-2 py-2 text-right text-2xs font-medium uppercase tracking-[0.1em] text-text-dim">p95</th>
                  <th className="px-4 py-2 text-right text-2xs font-medium uppercase tracking-[0.1em] text-text-dim">Detect</th>
                </tr>
              </thead>
              <tbody>
                {RESILIENCE.reports.map((r) => (
                  <tr key={r.fault} className="border-b border-border/60 last:border-0">
                    <td className="px-4 py-2.5 text-xs text-text-muted">{FAULT_LABEL[r.fault] ?? r.fault}</td>
                    <td className="tnum px-2 py-2.5 text-right text-xs text-text-primary">{r.medianMs}ms</td>
                    <td className="tnum px-2 py-2.5 text-right text-xs text-text-muted">{r.p95Ms}ms</td>
                    <td className="tnum px-4 py-2.5 text-right text-xs text-approved">
                      {(r.detectionRate * 100).toFixed(0)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="border-t border-border px-4 py-3 text-2xs leading-relaxed text-text-dim">
              Recovery is wall-clock from the fault clearing to a healthy APPROVED block
              committing again. Peer crash includes respawning the child process. Chain
              intact across {RESILIENCE.chain.length} blocks. Reproduce with{' '}
              <code className="text-text-muted">npm run test:resilience</code>.
            </p>
          </Panel>

          <Panel title="Backoff activity" meta={<span className="text-2xs text-text-dim">{telemetry.backoffs.length} this session</span>}>
            {telemetry.backoffs.length === 0 ? (
              <p className="px-4 py-5 text-2xs text-text-dim">
                No upstream backoff yet. Fire the rate limiter to exercise the retry path.
              </p>
            ) : (
              <ul className="max-h-52 overflow-auto">
                {telemetry.backoffs.map((b, i) => (
                  <li
                    key={`${b.at}-${i}`}
                    className="flex items-baseline gap-3 border-b border-border/60 px-4 py-2 last:border-0"
                  >
                    <span className="tnum shrink-0 text-2xs text-text-dim">{formatClock(b.at)}</span>
                    <span className="tnum shrink-0 text-2xs text-warn">
                      {b.status ?? 'net'} · {b.delayMs}ms
                    </span>
                    <span className="truncate text-2xs text-text-muted">
                      attempt {b.attempt}/{b.ofAttempts} ·{' '}
                      {b.fromRetryAfter ? 'server Retry-After' : 'full jitter'}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>
    </>
  );
}
