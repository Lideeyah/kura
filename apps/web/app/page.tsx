import Link from 'next/link';

/**
 * Landing page. One job: say what KURA is before asking anyone to click anything.
 * Static, high whitespace, no live data — the console is one click away.
 */
export default function Landing() {
  return (
    <div className="min-h-screen bg-canvas">
      <header className="mx-auto flex max-w-shell items-center justify-between px-6 py-5">
        <span className="text-sm font-medium tracking-tight text-text-primary">Kura</span>
        <nav className="flex items-center gap-6">
          <a
            href="https://github.com/"
            className="text-2xs tracking-tight text-text-muted transition-colors hover:text-text-primary"
          >
            Docs
          </a>
          <a
            href="https://github.com/"
            className="text-2xs tracking-tight text-text-muted transition-colors hover:text-text-primary"
          >
            GitHub
          </a>
          <Link
            href="/app/evaluator"
            className="rounded border border-border-strong bg-surface-2 px-3 py-1.5 text-2xs tracking-tight text-text-primary transition-colors hover:bg-border"
          >
            Launch Console
          </Link>
        </nav>
      </header>

      <main className="mx-auto max-w-shell px-6">
        <section className="border-b border-border py-28 sm:py-36">
          <h1 className="max-w-3xl text-4xl font-medium leading-[1.1] tracking-tight text-text-primary sm:text-5xl">
            Deterministic execution firewall for autonomous agents.
          </h1>
          <p className="mt-6 max-w-xl text-sm leading-relaxed text-text-muted">
            Pre-trade invariant verification and cryptographic audit trails before capital
            is committed.
          </p>
          <Link
            href="/app/evaluator"
            className="mt-10 inline-flex items-center rounded bg-text-primary px-5 py-2.5 text-xs font-medium tracking-tight text-canvas transition-opacity hover:opacity-90"
          >
            Open Console
          </Link>
        </section>

        <section className="grid gap-px border-b border-border bg-border sm:grid-cols-3">
          {[
            {
              n: '01',
              title: 'Invariant Circuit Breaking',
              body: 'Drops execution when latency, provenance, or feeds degrade. Four synchronous gates, short-circuiting on first failure, with no model in the decision path.',
            },
            {
              n: '02',
              title: 'Grounded Sizing',
              body: 'Eliminates unconstrained model guesses using dynamic volatility boundaries. Deterministic, monotonic, and refused outright beyond the range it can model.',
            },
            {
              n: '03',
              title: 'Cryptographic Accountability',
              body: 'Tamper-evident SHA-256 hash chains for zero-trust auditing. Independently verifiable from raw disk state by a tool that shares no code with the engine.',
            },
          ].map((p) => (
            <div key={p.n} className="bg-canvas px-6 py-10 sm:px-7">
              <div className="tnum text-2xs text-text-dim">{p.n} /</div>
              <h2 className="mt-3 text-sm font-medium tracking-tight text-text-primary">
                {p.title}
              </h2>
              <p className="mt-3 text-xs leading-relaxed text-text-muted">{p.body}</p>
            </div>
          ))}
        </section>

        <div className="py-10">
          <p className="max-w-2xl text-2xs leading-relaxed text-text-dim">
            KURA is agent black-box auditing and deterministic circuit breaking — not a
            decentralised oracle. It proves what an agent observed, when, that the
            invariants ran before handoff, and that the record was not altered afterwards.
            It does not attest that upstream data is correct.
          </p>
        </div>
      </main>
    </div>
  );
}
