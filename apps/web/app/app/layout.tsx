import type { ReactNode } from 'react';
import { TelemetryProvider } from './TelemetryProvider';
import { Nav } from './Nav';

export default function ConsoleLayout({ children }: { children: ReactNode }) {
  return (
    <TelemetryProvider>
      <div className="min-h-screen bg-canvas">
        <Nav />
        <main className="mx-auto max-w-shell px-6 py-8">{children}</main>
      </div>
    </TelemetryProvider>
  );
}
