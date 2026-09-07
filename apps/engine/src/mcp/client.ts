import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { config, repoRoot } from '../config.js';
import { EngineError } from './errors.js';

export interface RyoTransportSpec {
  transport: 'http' | 'stdio';
  url?: string;
  command?: string;
  args?: string[];
  token?: string;
  env?: Record<string, string>;
}

/** Resolve the transport spec from env. Throws if the selected transport is unconfigured. */
export function transportSpecFromConfig(): RyoTransportSpec {
  if (config.mcp.transport === 'stdio') {
    if (!config.mcp.command) {
      throw new EngineError(
        'TRANSPORT_ERROR',
        'RYO_MCP_TRANSPORT=stdio but RYO_MCP_COMMAND is empty. Set it in .env — the engine will not fabricate a peer.',
      );
    }
    return { transport: 'stdio', command: config.mcp.command, args: config.mcp.args };
  }
  if (!config.mcp.url) {
    throw new EngineError(
      'TRANSPORT_ERROR',
      'RYO_MCP_TRANSPORT=http but RYO_MCP_URL is empty. Set it in .env — the engine will not fabricate a peer.',
    );
  }
  return { transport: 'http', url: config.mcp.url, token: config.mcp.token };
}

function buildTransport(spec: RyoTransportSpec, mode: 'streamable' | 'sse'): Transport {
  if (spec.transport === 'stdio') {
    return new StdioClientTransport({
      command: spec.command!,
      args: spec.args ?? [],
      env: { ...(process.env as Record<string, string>), ...(spec.env ?? {}) },
      cwd: repoRoot,
      stderr: 'pipe',
    });
  }
  const headers: Record<string, string> = {};
  if (spec.token) headers.Authorization = `Bearer ${spec.token}`;
  const url = new URL(spec.url!);
  return mode === 'streamable'
    ? new StreamableHTTPClientTransport(url, { requestInit: { headers } })
    : new SSEClientTransport(url, { requestInit: { headers } });
}

/**
 * A live MCP client over real transport. There is no offline mode and no synthetic
 * payload path: if the peer is unreachable, calls fail loudly with TRANSPORT_ERROR.
 */
export class RyoClient {
  private client: Client | null = null;
  private transport: Transport | null = null;
  private connecting: Promise<void> | null = null;
  private _connected = false;
  private _mode: 'streamable' | 'sse' | 'stdio' = 'streamable';

  constructor(
    private readonly spec: RyoTransportSpec,
    private readonly onStateChange?: (connected: boolean, detail?: string) => void,
  ) {}

  get connected(): boolean {
    return this._connected;
  }

  get description(): string {
    return this.spec.transport === 'stdio'
      ? `stdio:${this.spec.command} ${(this.spec.args ?? []).join(' ')}`.trim()
      : `${this._mode}:${this.spec.url}`;
  }

  async connect(): Promise<void> {
    if (this._connected) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.doConnect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async doConnect(): Promise<void> {
    const modes: Array<'streamable' | 'sse'> =
      this.spec.transport === 'stdio' ? ['streamable'] : ['streamable', 'sse'];

    let lastError: unknown;
    for (const mode of modes) {
      const client = new Client(
        { name: 'kura-flight-engine', version: '0.1.0' },
        { capabilities: {} },
      );
      const transport = buildTransport(this.spec, mode);
      transport.onclose = () => {
        if (this._connected) {
          this._connected = false;
          this.onStateChange?.(false, 'transport closed');
        }
      };
      transport.onerror = (err: Error) => {
        this.onStateChange?.(this._connected, `transport error: ${err.message}`);
      };
      try {
        await client.connect(transport);
        this.client = client;
        this.transport = transport;
        this._mode = this.spec.transport === 'stdio' ? 'stdio' : mode;
        this._connected = true;
        this.onStateChange?.(true, this.description);
        return;
      } catch (err) {
        lastError = err;
        await client.close().catch(() => {});
      }
    }
    this._connected = false;
    const message = lastError instanceof Error ? lastError.message : String(lastError);
    this.onStateChange?.(false, message);
    throw new EngineError('TRANSPORT_ERROR', `could not reach MCP peer (${this.description}): ${message}`);
  }

  async listTools(): Promise<string[]> {
    if (!this.client) throw new EngineError('NOT_CONNECTED', 'listTools before connect');
    const res = await this.client.listTools();
    return res.tools.map((t) => t.name);
  }

  /** Raw MCP call. Envelope unwrapping and validation happen upstream in the interceptor. */
  async rawCall(
    name: string,
    args: Record<string, unknown>,
    opts: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<unknown> {
    if (!this.client || !this._connected) {
      throw new EngineError('NOT_CONNECTED', `no live MCP session for ${name}`);
    }
    return this.client.callTool({ name, arguments: args }, undefined, {
      signal: opts.signal,
      timeout: opts.timeoutMs ?? config.mcp.requestTimeoutMs,
    });
  }

  /** Hard close. Used by chaos DROP to sever the live connection for real. */
  async kill(reason: string): Promise<void> {
    this._connected = false;
    const t = this.transport;
    const c = this.client;
    this.transport = null;
    this.client = null;
    await c?.close().catch(() => {});
    await t?.close().catch(() => {});
    this.onStateChange?.(false, reason);
  }

  async close(): Promise<void> {
    await this.kill('shutdown');
  }
}
