'use client';

import { useCallback, useState } from 'react';
import { useConsole } from '../TelemetryProvider';
import { Button, Panel, PageTitle } from '../ui';

export default function IntegrationPage() {
  const { health } = useConsole();
  const endpoint = health?.mcp_endpoint ?? 'http://localhost:4000/mcp';
  const [copied, setCopied] = useState<string | null>(null);

  const copy = useCallback(async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1400);
    } catch {
      /* clipboard blocked — the snippet is selectable on screen regardless */
    }
  }, []);

  const agentConfig = `{
  "mcpServers": {
    "kura": {
      "url": "${endpoint}"
    }
  }
}`;

  const stdioConfig = `{
  "mcpServers": {
    "kura": {
      "command": "npx",
      "args": ["kura", "gateway"]
    }
  }
}`;

  return (
    <>
      <PageTitle
        title="Gateway Setup"
        blurb="Register KURA as your agent's MCP server. Your agent then calls evaluate_candidate instead of the research tools directly, so the invariants sit between intent and execution and cannot be routed around."
      />

      <div className="space-y-4">
        <Panel
          title="1 · Run the daemon"
          meta={
            <Button onClick={() => void copy('daemon', 'npx kura start')}>
              {copied === 'daemon' ? 'Copied' : 'Copy'}
            </Button>
          }
        >
          <pre className="tnum overflow-x-auto px-4 py-4 text-xs text-approved/80">npx kura start</pre>
          <p className="border-t border-border px-4 py-3 text-2xs leading-relaxed text-text-muted">
            Serves the REST API, the SSE telemetry stream, and the MCP gateway on{' '}
            <code className="text-text-primary">{endpoint.replace('/mcp', '')}</code>. Runs against the
            local conformance peer with no credential; set <code className="text-text-primary">RYO_MCP_KEY</code>{' '}
            and <code className="text-text-primary">RYO_MCP_TRANSPORT=http</code> in{' '}
            <code className="text-text-primary">.env</code> for live RYO-CHAN. Never commit a populated credential.
          </p>
        </Panel>

        <Panel
          title="2 · Register in your agent — HTTP"
          meta={
            <Button onClick={() => void copy('http', agentConfig)}>
              {copied === 'http' ? 'Copied' : 'Copy JSON Config'}
            </Button>
          }
        >
          <pre className="tnum overflow-x-auto px-4 py-4 text-xs leading-relaxed text-text-muted">
            {agentConfig}
          </pre>
          <p className="border-t border-border px-4 py-3 text-2xs text-text-muted">
            For clients that take a URL — Claude Desktop, Cursor, or any Streamable HTTP MCP client.
          </p>
        </Panel>

        <Panel
          title="3 · Register in your agent — stdio"
          meta={
            <Button onClick={() => void copy('stdio', stdioConfig)}>
              {copied === 'stdio' ? 'Copied' : 'Copy JSON Config'}
            </Button>
          }
        >
          <pre className="tnum overflow-x-auto px-4 py-4 text-xs leading-relaxed text-text-muted">
            {stdioConfig}
          </pre>
          <p className="border-t border-border px-4 py-3 text-2xs text-text-muted">
            For clients configured with a command rather than a URL. stdout carries JSON-RPC only;
            diagnostics go to stderr.
          </p>
        </Panel>

        <Panel title="Gateway tools">
          <dl className="divide-y divide-border">
            {[
              ['evaluate_candidate', 'Runs the four invariants, commits the verdict, returns APPROVED with a bounded allocation or VETOED with the failing gate — plus a receipt id and block hash.'],
              ['gate_policy', 'The thresholds and sizing parameters in force, so the agent knows the rules before it asks.'],
              ['verify_receipt', 'Recomputes the hashes for a past decision and re-checks its parent link.'],
              ['get_receipt', 'The full record, including the canonical raw payload the hash covers.'],
              ['chain_status', 'Chain height and integrity from genesis.'],
            ].map(([name, body]) => (
              <div key={name} className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:gap-6">
                <dt className="tnum w-48 shrink-0 text-xs text-text-primary">{name}</dt>
                <dd className="text-2xs leading-relaxed text-text-muted">{body}</dd>
              </div>
            ))}
          </dl>
          <p className="border-t border-border px-4 py-3 text-2xs leading-relaxed text-text-dim">
            A VETO is final. There is no override parameter, no confidence score to argue with, and
            no fallback estimate — the tool returns <code>sizing: null</code> and the agent has
            nothing to act on.
          </p>
        </Panel>
      </div>
    </>
  );
}
