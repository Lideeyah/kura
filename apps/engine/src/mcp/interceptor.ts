import { config } from '../config.js';
import { bus, type CallStatus, type ChaosState } from '../bus/telemetry.js';
import {
  SchemaMismatchError,
  validateEnvelope,
  type RyoEnvelope,
  type ToolName,
} from '../schema/tools.js';
import { EngineError } from './errors.js';
import { createRetryingFetch, fullJitterDelay, DEFAULT_RETRY_POLICY } from './retry.js';
import { RatePacer } from './pacer.js';
import type { RyoClient } from './client.js';

export interface CallResult {
  /** The validated public builder envelope. */
  payload: RyoEnvelope;
  /** Exactly what came off the wire, before validation. This is what gets hashed. */
  raw: unknown;
  latencyMs: number;
  status: 'OK';
}

export type ChaosAction =
  | 'DROP'
  | 'DELAY'
  | 'DEGRADE_STATUS'
  | 'DEGRADE_MODE'
  | 'RATE_LIMIT'
  | 'RESET';

type ChaosEntry = { action: Exclude<ChaosAction, 'RESET'>; delayMs?: number };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Chaos injection state. Controlled at runtime via POST /api/chaos/toggle. */
export class ChaosController {
  private readonly state = new Map<ToolName | '*', ChaosEntry>();

  set(tool: ToolName | '*', action: ChaosAction, delayMs?: number): void {
    if (action === 'RESET') {
      if (tool === '*') this.state.clear();
      else this.state.delete(tool);
    } else {
      this.state.set(tool, { action, delayMs });
    }
    bus.publish({ type: 'chaos', chaos: this.snapshot(), at: new Date().toISOString() });
  }

  resolve(tool: ToolName): ChaosEntry | undefined {
    return this.state.get(tool) ?? this.state.get('*');
  }

  snapshot(): ChaosState[] {
    return [...this.state.entries()].map(([tool, entry]) => ({
      tool,
      action: entry.action,
      ...(entry.delayMs === undefined ? {} : { delayMs: entry.delayMs }),
    }));
  }

  get active(): boolean {
    return this.state.size > 0;
  }

  clear(): void {
    this.state.clear();
  }
}

/**
 * Unwrap an MCP CallToolResult envelope into the tool's payload object.
 * Prefers `structuredContent`; falls back to parsing concatenated text blocks.
 */
export function unwrapEnvelope(tool: ToolName, envelope: unknown): unknown {
  if (envelope === null || typeof envelope !== 'object') {
    throw new EngineError('MALFORMED_ENVELOPE', `${tool} returned a non-object result`, { tool });
  }
  const env = envelope as {
    isError?: boolean;
    structuredContent?: unknown;
    content?: Array<{ type?: string; text?: string }>;
  };

  if (env.isError === true) {
    const text = (env.content ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('\n');

    // RYO signals rate limiting as a *tool* error inside an HTTP 200 — the guide is
    // explicit that "a tool execution error follows MCP behavior and can be returned
    // with HTTP 200 and isError: true". The HTTP-level 429 handler never sees this, so
    // it has to be recognised here or the call fails instantly with no backoff at all.
    if (/rate.?limit|too many requests|\b429\b|quota exceeded/i.test(text)) {
      throw new EngineError('UPSTREAM_RATE_LIMITED', `${tool} was rate limited: ${text}`, { tool });
    }

    throw new EngineError('TOOL_ERROR', `${tool} reported isError=true: ${text || '<no detail>'}`, { tool });
  }

  if (env.structuredContent !== undefined && env.structuredContent !== null) {
    return env.structuredContent;
  }

  const text = (env.content ?? [])
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text as string)
    .join('');

  if (!text.trim()) {
    throw new EngineError('MALFORMED_ENVELOPE', `${tool} returned neither structuredContent nor text`, { tool });
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new EngineError('MALFORMED_ENVELOPE', `${tool} text content is not valid JSON`, { tool });
  }
}

/**
 * The network fault interceptor.
 *
 * Normal path : pass through, measure, validate, return { payload, latencyMs, status: 'OK' }.
 * DROP        : sever the live transport for real and raise TRANSPORT_DROPPED.
 * DELAY       : inject N ms of artificial sleep, producing a genuine upstream timeout
 *               once the ceiling is crossed.
 *
 * Every outcome publishes a tool_pulse, so the UI sees failures as clearly as successes.
 */
export class InterceptedRyo {
  private readonly pacer: RatePacer;

  constructor(
    private readonly client: RyoClient,
    readonly chaos: ChaosController,
  ) {
    this.pacer = new RatePacer(
      config.mcp.ratePerMinute,
      undefined,
      undefined,
      config.mcp.minCallIntervalMs || undefined,
    );
  }

  get quotaRemaining(): number | null {
    return this.pacer.enabled ? this.pacer.remaining() : null;
  }

  async call(tool: ToolName, args: Record<string, unknown> = {}): Promise<CallResult> {
    const entry = this.chaos.resolve(tool);
    const controller = new AbortController();

    /**
     * The FRESHNESS gate asks how stale the upstream's answer is. Our own outbound
     * throttle is not staleness — it is queueing we chose — so the clock starts after
     * pacing, not before. Counting a 3s spacing wait as round-trip latency inflated a
     * healthy 900ms call to 4287ms and vetoed live data on FRESHNESS.
     *
     * Chaos DELAY is deliberately still inside the measurement: it exists to stand in
     * for a slow upstream, so it must read as one.
     */
    let started = performance.now();

    try {
      if (entry?.action === 'DROP') {
        controller.abort();
        await this.client.kill(`chaos DROP on ${tool}`);
        throw new EngineError('TRANSPORT_DROPPED', `connection severed by chaos injection on ${tool}`, {
          tool,
          latencyMs: performance.now() - started,
        });
      }

      if (entry?.action === 'RATE_LIMIT') {
        // Drives the *production* retry wrapper — same createRetryingFetch, same policy,
        // same Retry-After parsing, same full-jitter curve, same telemetry. Only the
        // socket is substituted: the injected transport returns a genuine 429 Response
        // with genuine headers, so no port coupling and no assumption about where this
        // process happens to be listening. The identical function is driven over a real
        // HTTP socket in test/retry.test.ts.
        const limiter = createRetryingFetch({
          policy: { maxAttempts: 3, baseDelayMs: 250 },
          fetchImpl: async () =>
            new Response(JSON.stringify({ error: 'rate_limited' }), {
              status: 429,
              headers: {
                'Retry-After': '1',
                'X-RateLimit-Limit': '1000',
                'X-RateLimit-Remaining': '0',
              },
            }),
        });
        const res = await limiter('https://upstream.invalid/mcp');
        throw new EngineError(
          'UPSTREAM_RATE_LIMITED',
          `${tool} exhausted its retry budget against HTTP ${res.status} from the upstream`,
          { tool, latencyMs: performance.now() - started },
        );
      }

      if (entry?.action === 'DELAY') {
        const delayMs = Math.max(0, entry.delayMs ?? 0);
        // Never sleep past the hard ceiling — surface the timeout instead of hanging.
        const budget = Math.min(delayMs, config.mcp.requestTimeoutMs);
        await sleep(budget);
        if (delayMs >= config.mcp.requestTimeoutMs) {
          throw new EngineError(
            'UPSTREAM_TIMEOUT',
            `${tool} exceeded ${config.mcp.requestTimeoutMs}ms under injected delay of ${delayMs}ms`,
            { tool, latencyMs: performance.now() - started },
          );
        }
      }

      // Pace before timing: this wait is ours, not the upstream's.
      const pacedMs = await this.pacer.acquire();
      if (pacedMs > 0) started = performance.now();

      // A tool-level rate limit arrives inside an HTTP 200, so the fetch-level retry
      // never sees it. Back off here, on the same full-jitter curve, rather than
      // failing instantly at 0ms with no attempt to recover.
      let raw: unknown;
      for (let attempt = 0; ; attempt += 1) {
        try {
          const envelope = await this.client.rawCall(tool, args, {
            signal: controller.signal,
            timeoutMs: config.mcp.requestTimeoutMs,
          });
          raw = unwrapEnvelope(tool, envelope);
          break;
        } catch (err) {
          const limited = err instanceof EngineError && err.code === 'UPSTREAM_RATE_LIMITED';
          if (!limited || attempt >= config.mcp.retryMaxAttempts - 1) throw err;
          const delayMs = fullJitterDelay(attempt, {
            ...DEFAULT_RETRY_POLICY,
            maxAttempts: config.mcp.retryMaxAttempts,
            baseDelayMs: config.mcp.retryBaseDelayMs,
            maxDelayMs: config.mcp.retryMaxDelayMs,
          });
          bus.publish({
            type: 'rate_limit',
            backoff: {
              attempt: attempt + 1,
              ofAttempts: config.mcp.retryMaxAttempts,
              delayMs,
              reason: 'RATE_LIMITED',
              status: 200,
              fromRetryAfter: false,
              rateLimit: null,
              at: new Date().toISOString(),
            },
          });
          await sleep(delayMs);
        }
      }
      let payload = validateEnvelope(tool, raw);

      // Envelope degradation is applied after validation, so the arbiter sees exactly
      // the shape a genuinely degraded upstream would produce. Unlike the profile
      // fixtures this also works against live RYO.
      if (entry?.action === 'DEGRADE_STATUS') payload = { ...payload, status: 'partial' };
      if (entry?.action === 'DEGRADE_MODE') payload = { ...payload, data_mode: 'simulated' };

      const latencyMs = performance.now() - started;

      this.pulse(tool, latencyMs, 'OK');
      return { payload, raw, latencyMs, status: 'OK' };
    } catch (err) {
      const latencyMs = performance.now() - started;
      const status = statusOf(err);
      this.pulse(tool, latencyMs, status, messageOf(err));
      if (err instanceof SchemaMismatchError || err instanceof EngineError) throw err;
      throw new EngineError('TRANSPORT_ERROR', messageOf(err), { tool, latencyMs });
    }
  }

  private pulse(tool: ToolName, latencyMs: number, status: CallStatus, detail?: string): void {
    bus.publish({
      type: 'tool_pulse',
      pulse: {
        tool,
        latencyMs: Math.round(latencyMs * 100) / 100,
        status,
        at: new Date().toISOString(),
        ...(detail ? { detail } : {}),
      },
    });
  }
}

function statusOf(err: unknown): CallStatus {
  if (err instanceof SchemaMismatchError) return 'SCHEMA_MISMATCH_OR_MISSING_FIELD';
  if (err instanceof EngineError) {
    if (err.code === 'TRANSPORT_DROPPED') return 'DROPPED';
    if (err.code === 'UPSTREAM_TIMEOUT') return 'TIMEOUT';
    if (err.code === 'UPSTREAM_RATE_LIMITED') return 'RATE_LIMITED';
  }
  return 'TRANSPORT_ERROR';
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
