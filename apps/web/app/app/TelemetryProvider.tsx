'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTelemetry, type TelemetryState } from '../useTelemetry';
import type { EvidenceProbe, ToolName } from '../types';

export interface Health {
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

interface Ctx {
  telemetry: TelemetryState;
  health: Health | null;
  watchlist: string[];
  busy: boolean;
  post: (url: string, body: unknown) => Promise<unknown>;
  setChaos: (action: string, tool?: ToolName | '*', delayMs?: number) => Promise<void>;
  evaluate: (symbol: string) => Promise<unknown>;
}

const TelemetryContext = createContext<Ctx | null>(null);

/**
 * One EventSource for the whole console. Mounting it in the shell rather than per page
 * means moving between Evaluator, Chaos and Ledger does not tear down and re-open the
 * stream — the ring buffer replay would otherwise re-arrive on every navigation.
 */
export function TelemetryProvider({ children }: { children: ReactNode }) {
  const telemetry = useTelemetry();
  const [health, setHealth] = useState<Health | null>(null);
  const [watchlist, setWatchlist] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const [h, t] = await Promise.all([
          fetch('/api/health').then((r) => r.json() as Promise<Health>),
          fetch('/api/tools').then((r) => r.json() as Promise<{ watchlist: Array<{ symbol: string }> }>),
        ]);
        if (!alive) return;
        setHealth(h);
        setWatchlist((t.watchlist ?? []).map((x) => x.symbol));
      } catch {
        if (alive) setHealth(null);
      }
    };
    void load();
    const id = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

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

  const setChaos = useCallback(
    async (action: string, tool: ToolName | '*' = 'analyze_token', delayMs?: number) => {
      await post('/api/chaos/toggle', delayMs === undefined ? { tool, action } : { tool, action, delayMs });
    },
    [post],
  );

  const evaluate = useCallback((symbol: string) => post('/api/evaluate', { symbol }), [post]);

  const value = useMemo(
    () => ({ telemetry, health, watchlist, busy, post, setChaos, evaluate }),
    [telemetry, health, watchlist, busy, post, setChaos, evaluate],
  );

  return <TelemetryContext.Provider value={value}>{children}</TelemetryContext.Provider>;
}

export function useConsole(): Ctx {
  const ctx = useContext(TelemetryContext);
  if (!ctx) throw new Error('useConsole must be used inside TelemetryProvider');
  return ctx;
}
