import { config } from './config.js';
import { bus } from './bus/telemetry.js';
import { FlightRecorder } from './ledger/ledger.js';
import { RyoClient, transportSpecFromConfig, type RyoTransportSpec } from './mcp/client.js';
import { ChaosController, InterceptedRyo } from './mcp/interceptor.js';
import { evaluateToken, type EvaluationOutcome } from './pipeline.js';
import { TOOL_NAMES, type ToolName } from './schema/tools.js';

export interface WatchToken {
  symbol: string;
  address?: string;
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
      await this.refreshWatchlist();
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

  private async refreshWatchlist(): Promise<void> {
    try {
      const res = await this.ryo.call('supported_tokens', {});
      this.watchlist = res.payload.tokens.map((t) => ({ symbol: t.symbol, address: t.address }));
    } catch {
      // Leave the previous watchlist in place; the pulse loop will surface the fault.
    }
  }

  private pingArgs(tool: ToolName): Record<string, unknown> {
    const a = this.watchlist[0];
    const b = this.watchlist[1] ?? a;
    switch (tool) {
      case 'market_overview':
      case 'supported_tokens':
        return {};
      case 'scan_market':
        return { limit: 5 };
      case 'compare_tokens':
        return { symbols: [a?.symbol ?? 'SOL', b?.symbol ?? 'SOL'] };
      default:
        return a ? { symbol: a.symbol, address: a.address } : { symbol: 'SOL' };
    }
  }

  /** Heartbeat across all 7 tools. Failures publish pulses too — that is the point. */
  async pulseAll(): Promise<void> {
    if (!this.client.connected) return;
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
