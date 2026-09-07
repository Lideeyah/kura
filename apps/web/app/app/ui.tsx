import type { ReactNode } from 'react';

/** Shared chrome. One module, one question — every page uses the same shell. */
export function Panel({
  title,
  meta,
  children,
  className = '',
}: {
  title?: string;
  meta?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded border border-border bg-surface ${className}`}>
      {title ? (
        <header className="flex h-10 items-center justify-between gap-4 border-b border-border px-4">
          <h2 className="text-2xs uppercase tracking-[0.12em] text-text-muted">{title}</h2>
          {meta ? <div className="flex items-center gap-3">{meta}</div> : null}
        </header>
      ) : null}
      {children}
    </section>
  );
}

export function PageTitle({ title, blurb }: { title: string; blurb: string }) {
  return (
    <div className="mb-6">
      <h1 className="text-base font-medium tracking-tight text-text-primary">{title}</h1>
      <p className="mt-1 max-w-2xl text-xs leading-relaxed text-text-muted">{blurb}</p>
    </div>
  );
}

export function Button({
  children,
  onClick,
  disabled,
  tone = 'default',
  className = '',
  type = 'button',
  testId,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  tone?: 'default' | 'primary' | 'veto';
  className?: string;
  type?: 'button' | 'submit';
  /** Stable hook for automation — injector labels change to "Re-fire" once active. */
  testId?: string;
}) {
  const tones = {
    default: 'border-border bg-surface-2 text-text-primary hover:border-border-strong',
    primary: 'border-transparent bg-text-primary text-canvas hover:opacity-90',
    veto: 'border-veto/30 bg-veto/[0.07] text-veto hover:border-veto/60',
  } as const;
  return (
    <button
      type={type}
      data-testid={testId}
      onClick={onClick}
      disabled={disabled}
      className={`rounded border px-3 py-1.5 text-2xs tracking-tight transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${tones[tone]} ${className}`}
    >
      {children}
    </button>
  );
}

export function Metric({ label, value, tone }: { label: string; value: ReactNode; tone?: string }) {
  return (
    <div>
      <div className="text-2xs uppercase tracking-[0.1em] text-text-dim">{label}</div>
      <div className={`tnum mt-1 text-sm ${tone ?? 'text-text-primary'}`}>{value}</div>
    </div>
  );
}

export function Spinner() {
  return (
    <span
      aria-hidden
      className="inline-block h-3 w-3 animate-spin rounded-full border border-text-dim border-t-text-primary"
    />
  );
}
