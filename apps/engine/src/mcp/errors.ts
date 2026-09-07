import type { ToolName } from '../schema/tools.js';

export type EngineErrorCode =
  | 'TRANSPORT_DROPPED'
  | 'UPSTREAM_TIMEOUT'
  | 'UPSTREAM_RATE_LIMITED'
  | 'TRANSPORT_ERROR'
  | 'NOT_CONNECTED'
  | 'TOOL_ERROR'
  | 'MALFORMED_ENVELOPE';

export class EngineError extends Error {
  readonly code: EngineErrorCode;
  readonly tool?: ToolName;
  readonly latencyMs: number;

  constructor(code: EngineErrorCode, message: string, opts: { tool?: ToolName; latencyMs?: number } = {}) {
    super(`${code}: ${message}`);
    this.name = 'EngineError';
    this.code = code;
    this.tool = opts.tool;
    this.latencyMs = opts.latencyMs ?? 0;
  }

  toJSON() {
    return { code: this.code, tool: this.tool, latencyMs: this.latencyMs, message: this.message };
  }
}
