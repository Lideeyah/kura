'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useConsole } from './TelemetryProvider';

const ROUTES = [
  { href: '/app/evaluator', label: 'Evaluator' },
  { href: '/app/chaos', label: 'Chaos Lab' },
  { href: '/app/ledger', label: 'Audit Ledger' },
  { href: '/app/integration', label: 'Integration' },
] as const;

export function Nav() {
  const pathname = usePathname();
  const { telemetry, health } = useConsole();
  const streamLive = telemetry.streamState === 'OPEN';
  const peerLive = Boolean(health?.connected);

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-canvas/95 backdrop-blur">
      <div className="mx-auto flex max-w-shell flex-wrap items-center gap-x-8 gap-y-2 px-6 py-3">
        <Link href="/" className="text-sm font-medium tracking-tight text-text-primary">
          Kura
        </Link>

        <nav className="flex items-center gap-6">
          {ROUTES.map((r) => {
            const active = pathname === r.href;
            return (
              <Link
                key={r.href}
                href={r.href}
                aria-current={active ? 'page' : undefined}
                className={`text-2xs tracking-tight transition-colors ${
                  active ? 'text-text-primary' : 'text-text-muted hover:text-text-primary'
                }`}
              >
                {r.label}
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto flex items-center gap-5">
          <Status label="Stream" ok={streamLive} okText="live" badText={telemetry.streamState.toLowerCase()} />
          <Status label="Upstream" ok={peerLive} okText="connected" badText="down" />
        </div>
      </div>
    </header>
  );
}

function Status({
  label,
  ok,
  okText,
  badText,
}: {
  label: string;
  ok: boolean;
  okText: string;
  badText: string;
}) {
  return (
    <span className="flex items-center gap-1.5 text-2xs">
      <span
        className={`h-1.5 w-1.5 rounded-full ${ok ? 'bg-approved' : 'bg-veto'}`}
        aria-hidden
      />
      <span className="text-text-dim">{label}</span>
      <span className={ok ? 'text-text-muted' : 'text-veto'}>{ok ? okText : badText}</span>
    </span>
  );
}
