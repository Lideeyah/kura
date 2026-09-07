import type { ReactNode } from 'react';

/**
 * Every sector uses the same shell: 1px border, one elevation step above canvas, and
 * a small-caps header rail. Consistency here is what makes the grid read as one
 * instrument rather than a collection of cards.
 */
export function Panel({
  title,
  meta,
  children,
  className = '',
  bodyClassName = '',
}: {
  title: string;
  meta?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section
      className={`flex min-w-0 flex-col rounded-md border border-border bg-surface ${className}`}
    >
      <header className="flex h-9 shrink-0 items-center justify-between gap-3 border-b border-border px-3">
        <h2 className="truncate text-2xs font-medium uppercase tracking-[0.14em] text-text-muted">
          {title}
        </h2>
        {meta ? <div className="flex shrink-0 items-center gap-2">{meta}</div> : null}
      </header>
      <div className={`min-w-0 flex-1 ${bodyClassName}`}>{children}</div>
    </section>
  );
}

export function Dot({ className = '', pulse = false }: { className?: string; pulse?: boolean }) {
  return (
    <span className="relative inline-flex h-1.5 w-1.5 shrink-0">
      {pulse && (
        <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${className}`} />
      )}
      <span className={`relative inline-flex h-1.5 w-1.5 rounded-full ${className}`} />
    </span>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1">
      <span className="text-2xs uppercase tracking-[0.1em] text-text-muted">{label}</span>
      <span className="tnum text-xs text-text-primary">{children}</span>
    </div>
  );
}
