'use client';

import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'kura.quickstart.collapsed';

/**
 * Integration drawer for first contact. Collapsed state is a per-viewer convenience
 * only, so a browser that refuses storage (private window, blocked site data) just
 * gets the default open panel rather than an error.
 */
function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function QuickStart({ mcpEndpoint }: { mcpEndpoint: string }) {
  const [collapsed, setCollapsed] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => setCollapsed(readCollapsed()), []);

  const toggle = useCallback(() => {
    setCollapsed((c) => {
      const next = !c;
      try {
        window.localStorage.setItem(STORAGE_KEY, next ? '1' : '0');
      } catch {
        /* storage unavailable — the toggle still works for this session */
      }
      return next;
    });
  }, []);

  const copy = useCallback(async (label: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      setTimeout(() => setCopied((c) => (c === label ? null : c)), 1400);
    } catch {
      /* clipboard blocked — the command is selectable on screen regardless */
    }
  }, []);

  const agentConfig = `{
  "mcpServers": {
    "kura": { "url": "${mcpEndpoint}" }
  }
}`;

  return (
    <section className="mb-3 rounded-md border border-border bg-surface">
      <header className="flex h-9 items-center justify-between gap-3 px-3">
        <h2 className="flex items-center gap-2 text-2xs font-medium uppercase tracking-[0.14em] text-text-muted">
          Integration
          <span className="rounded-sm border border-emerald/30 bg-emerald/10 px-1 py-px text-[9px] normal-case tracking-normal text-emerald">
            gateway ready
          </span>
        </h2>
        <button
          type="button"
          onClick={toggle}
          aria-expanded={!collapsed}
          className="rounded border border-border px-2 py-0.5 text-2xs text-text-muted transition-colors hover:border-border-bright hover:text-text-primary"
        >
          {collapsed ? 'show setup' : 'hide'}
        </button>
      </header>

      {!collapsed && (
        <div className="grid gap-3 border-t border-border px-3 py-3 lg:grid-cols-3">
          <Snippet
            label="1 · Start the daemon"
            value="npx kura start"
            copied={copied === 'daemon'}
            onCopy={() => copy('daemon', 'npx kura start')}
          />
          <Snippet
            label="2 · MCP gateway endpoint"
            value={mcpEndpoint}
            copied={copied === 'endpoint'}
            onCopy={() => copy('endpoint', mcpEndpoint)}
          />
          <Snippet
            label="3 · Register in your agent"
            value={agentConfig}
            copied={copied === 'config'}
            onCopy={() => copy('config', agentConfig)}
            multiline
          />
          <p className="text-[10px] leading-relaxed text-text-muted/70 lg:col-span-3">
            Point Claude Desktop, Cursor, or any MCP client at the endpoint above, then call{' '}
            <code className="text-text-muted">evaluate_candidate</code> instead of the market tools
            directly. The four invariants sit between the agent and execution, so a VETO cannot be
            routed around. Upstream credentials go in{' '}
            <code className="text-text-muted">.env</code> as{' '}
            <code className="text-text-muted">RYO_MCP_URL</code> and{' '}
            <code className="text-text-muted">RYO_MCP_KEY</code>. Never commit a populated
            credential.
          </p>
        </div>
      )}
    </section>
  );
}

function Snippet({
  label,
  value,
  copied,
  onCopy,
  multiline = false,
}: {
  label: string;
  value: string;
  copied: boolean;
  onCopy: () => void;
  multiline?: boolean;
}) {
  return (
    <div className="min-w-0">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-2xs uppercase tracking-[0.1em] text-text-muted">{label}</span>
        <button
          type="button"
          onClick={onCopy}
          className={`rounded border px-1.5 py-px text-[9px] uppercase tracking-[0.08em] transition-colors ${
            copied
              ? 'border-emerald/40 bg-emerald/10 text-emerald'
              : 'border-border text-text-muted hover:border-border-bright hover:text-text-primary'
          }`}
        >
          {copied ? 'copied' : 'copy'}
        </button>
      </div>
      <pre
        className={`tnum overflow-x-auto rounded border border-border bg-surface-subtle px-2 py-1.5 text-[11px] leading-relaxed text-emerald/80 ${
          multiline ? '' : 'whitespace-pre'
        }`}
      >
        {value}
      </pre>
    </div>
  );
}
