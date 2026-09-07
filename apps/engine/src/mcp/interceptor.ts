import { config } from '../config.js';
import { bus, type CallStatus, type ChaosState } from '../bus/telemetry.js';
import {
  SchemaMismatchError,
  validateEnvelope,
  type RyoEnvelope,
  type ToolName,
} from '../schema/tools.js';
import { EngineError } from './errors.js';
import { createRetryingFetch } from './retry.js';
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
  constructor(
    private readonly client: RyoClient,
    readonly chaos: ChaosController,
  ) {}

  async call(tool: ToolName, args: Record<string, unknown> = {}): Promise<CallResult> {
    const started = performance.now();
    const entry = this.chaos.resolve(tool);
    const controller = new AbortController();

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

      const envelope = await this.client.rawCall(tool, args, {
        signal: controller.signal,
        timeoutMs: config.mcp.requestTimeoutMs,
      });
      const raw = unwrapEnvelope(tool, envelope);
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
