import { config } from './config.js';
import { bus } from './bus/telemetry.js';
import { FlightRecorder } from './ledger/ledger.js';
import { RyoClient, transportSpecFromConfig, type RyoTransportSpec } from './mcp/client.js';
import { ChaosController, InterceptedRyo } from './mcp/interceptor.js';
import { evaluateToken, type EvaluationOutcome } from './pipeline.js';
import { probeEvidence, type EvidenceProbe } from './arbiter/signals.js';
import { TOOL_NAMES, type ToolName } from './schema/tools.js';

export interface WatchToken {
  symbol: string;
}

/**
 * Owns the live connection, the heartbeat, and the autonomous evaluation loop.
 * Reconnects with exponential backoff after any transport failure — including the
 * ones chaos injection causes on purpose, which is what the resilience benchmark
 * measures.
 */
export class Supervisor {
  readonly chaos = new ChaosController();
  readonly ledger: FlightRecorder;
  readonly client: RyoClient;
  readonly ryo: InterceptedRyo;

  private watchlist: WatchToken[] = [];
  private pulseTimer: NodeJS.Timeout | null = null;
  private evalTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private backoffMs = config.mcp.reconnectBackoffMs;
  private stopped = false;
  private lastConnectError: string | null = null;
  private evidence: EvidenceProbe | null = null;

  constructor(spec: RyoTransportSpec = transportSpecFromConfig(), ledgerPath = config.ledger.path) {
    this.ledger = new FlightRecorder(ledgerPath);
    this.client = new RyoClient(spec, (connected, detail) => {
      bus.publish({
        type: 'connection',
        connected,
        transport: this.client.description,
        ...(detail ? { detail } : {}),
        at: new Date().toISOString(),
      });
      if (!connected && !this.stopped) this.scheduleReconnect();
    });
    this.ryo = new InterceptedRyo(this.client, this.chaos);
  }

  get connected(): boolean {
    return this.client.connected;
  }

  get connectError(): string | null {
    return this.lastConnectError;
  }

  /** Result of the boot-time measurement-path probe. */
  get evidenceProbe(): EvidenceProbe | null {
    return this.evidence;
  }

  get tokens(): WatchToken[] {
    return this.watchlist;
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.connectOnce();
    this.pulseTimer = setInterval(() => void this.pulseAll(), config.telemetry.pulseIntervalMs);
    if (config.telemetry.autoEvaluate) {
      this.evalTimer = setInterval(() => void this.evaluateNext(), config.telemetry.evaluationIntervalMs);
    }
  }

  private async connectOnce(): Promise<boolean> {
    try {
      await this.client.connect();
      this.lastConnectError = null;
      this.backoffMs = config.mcp.reconnectBackoffMs;
      this.refreshWatchlist();
      await this.probeEvidencePaths();
      return true;
    } catch (err) {
      this.lastConnectError = err instanceof Error ? err.message : String(err);
      bus.publish({
        type: 'error',
        code: 'TRANSPORT_ERROR',
        message: this.lastConnectError,
        at: new Date().toISOString(),
      });
      this.scheduleReconnect();
      return false;
    }
  }

  /** Public so the resilience benchmark can measure a cold recovery deterministically. */
  async reconnectNow(): Promise<boolean> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    return this.connectOnce();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, config.mcp.reconnectMaxBackoffMs);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connectOnce();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  /**
   * RYO publishes no `supported_tokens` tool, so the candidate list is the operator's
   * own watchlist from config rather than something discovered upstream. This also
   * keeps startup free of tool-call quota spend.
   */
  private refreshWatchlist(): void {
    this.watchlist = config.watchlist.map((symbol) => ({ symbol }));
  }

  /**
   * Boot-time schema resolution check.
   *
   * Costs exactly one tool call. Worth it: without it a change to RYO's `data` shape
   * turns into silent, total refusal — every token vetoed on EVIDENCE, no error
   * anywhere, and a green test suite. Set EVIDENCE_PROBE=0 to skip it.
   */
  private async probeEvidencePaths(): Promise<void> {
    if (!config.telemetry.evidenceProbe) return;
    const symbol = this.watchlist[0]?.symbol;
    if (!symbol) return;
    try {
      const res = await this.ryo.call('analyze_token', { symbol });
      this.evidence = probeEvidence(res.payload);
    } catch (err) {
      this.evidence = {
        resolved: false,
        pricePath: null,
        atrPath: null,
        atrForm: null,
        rsiPath: null,
        detail: `probe call failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const probe = this.evidence;
    if (probe.resolved) {
      process.stderr.write(`[kura] evidence paths OK — ${probe.detail}\n`);
    } else {
      const warning =
        'SCHEMA RESOLUTION WARNING: Expected measurement paths not resolved; ' +
        'falling back to strict veto mode';
      process.stderr.write(`[kura] ${warning}\n[kura] ${probe.detail}\n`);
      bus.publish({
        type: 'error',
        code: 'SCHEMA_RESOLUTION_WARNING',
        message: `${warning} — ${probe.detail}`,
        at: new Date().toISOString(),
      });
    }
  }

  private pingArgs(tool: ToolName): Record<string, unknown> {
    const a = this.watchlist[0]?.symbol ?? 'SOL';
    const b = this.watchlist[1]?.symbol ?? a;
    switch (tool) {
      case 'market_overview':
      case 'monitor_market_sentiment_shift':
        return {};
      case 'scan_market':
        return { top_n: 5 };
      // Two to four distinct symbols as ONE comma-separated string, per the guide.
      case 'compare_tokens':
        return { symbols: a === b ? a : `${a}, ${b}` };
      default:
        return { symbol: a };
    }
  }

  /**
   * Liveness heartbeat.
   *
   * The guide warns against tight polling loops over the metered tools and states that
   * /health needs no auth and spends no quota, so the heartbeat asks /health and the
   * per-tool latency figures come from real evaluations instead. Set
   * PULSE_SWEEP_TOOLS=1 to fan out across all six tools — useful against the local
   * conformance peer, expensive against production.
   */
  async pulseAll(): Promise<void> {
    if (!this.client.connected) return;

    if (!config.telemetry.pulseSweepTools) {
      const health = await this.client.fetchHealth();
      bus.publish({
        type: 'connection',
        connected: health.ok && this.client.connected,
        transport: this.client.description,
        detail: health.detail,
        at: new Date().toISOString(),
      });
      return;
    }

    for (const tool of TOOL_NAMES) {
      if (!this.client.connected) break;
      try {
        await this.ryo.call(tool, this.pingArgs(tool));
      } catch {
        // The interceptor already published the failing pulse.
      }
    }
  }

  private cursor = 0;

  async evaluateNext(): Promise<EvaluationOutcome | null> {
    if (this.watchlist.length === 0) return null;
    const token = this.watchlist[this.cursor % this.watchlist.length]!;
    this.cursor += 1;
    return this.evaluate(token);
  }

  async evaluate(token: WatchToken): Promise<EvaluationOutcome> {
    return evaluateToken(this.ryo, this.ledger, token);
  }

  /** The authenticated catalog, which the guide names the final source of truth. */
  async catalog(): Promise<{ names: string[]; error: string | null }> {
    return this.client.fetchCatalog();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pulseTimer) clearInterval(this.pulseTimer);
    if (this.evalTimer) clearInterval(this.evalTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.pulseTimer = this.evalTimer = null;
    this.reconnectTimer = null;
    await this.client.close();
    this.ledger.close();
  }
}
