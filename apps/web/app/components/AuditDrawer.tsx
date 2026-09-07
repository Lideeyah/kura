'use client';

import { useEffect, useRef } from 'react';
import type { LedgerRecord, VerificationResult } from '../types';
import { formatClock, formatSeq, formatUsd, receiptLabel } from '../signal';

const GENESIS = '0'.repeat(64);

/**
 * Fixed-position right drawer at z-50. It overlays the grid rather than participating
 * in it, so opening an audit causes zero layout shift in the sectors behind it.
 */
export function AuditDrawer({
  record,
  verification,
  verifying,
  onClose,
  onVerify,
}: {
  record: LedgerRecord | null;
  verification: VerificationResult | null;
  verifying: boolean;
  onClose: () => void;
  onVerify: (receiptId: string) => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!record) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [record, onClose]);

  if (!record) return null;

  const halted = record.decision === 'VETOED';
  const isGenesis = record.prev_block_hash === GENESIS;
  const linkOk = verification ? verification.valid : null;

  let canonical = record.raw_payload_json;
  try {
    canonical = JSON.stringify(JSON.parse(record.raw_payload_json), null, 2);
  } catch {
    /* keep the stored text verbatim if it will not parse */
  }

  return (
    <div className="fixed inset-0 z-50">
      <button
        type="button"
        aria-label="Close audit drawer"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-canvas/70 backdrop-blur-[2px]"
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={`Audit receipt ${record.receipt_id}`}
        className="absolute right-0 top-0 flex h-full w-full max-w-[38rem] animate-drawer-in flex-col border-l border-border-bright bg-surface shadow-2xl"
      >
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <div className="text-2xs uppercase tracking-[0.14em] text-text-muted">
              {receiptLabel(record.receipt_id)} · block {formatSeq(record.seq)}
            </div>
            <div className="tnum mt-0.5 truncate text-xs text-text-primary">{record.receipt_id}</div>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="shrink-0 rounded border border-border px-2 py-1 text-2xs text-text-muted transition-colors hover:border-border-bright hover:text-text-primary"
          >
            ESC
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-4 overflow-auto px-4 py-4">
          {/* Summary */}
          <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5">
            <Row label="Decision">
              <span className={halted ? 'text-rose' : 'text-emerald'}>
                {halted ? 'VETO_HALT' : 'APPROVED'}
              </span>
            </Row>
            <Row label="Token">{record.token}/USDC</Row>
            <Row label="Committed">{formatClock(record.timestamp)}</Row>
            <Row label="Upstream">{record.latency_ms}ms</Row>
            <Row label="Position">
              {record.position_usd > 0 ? formatUsd(record.position_usd) : '—'}
            </Row>
            <Row label="Sequence">{formatSeq(record.seq)}</Row>
          </dl>

          <p className="rounded border border-border bg-surface-subtle px-3 py-2 text-xs leading-relaxed text-text-muted">
            {record.reason}
          </p>

          {/* Hash chain linkage */}
          <section>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-2xs uppercase tracking-[0.14em] text-text-muted">
                SHA-256 linkage
              </h3>
              <button
                type="button"
                disabled={verifying}
                onClick={() => onVerify(record.receipt_id)}
                className="rounded border border-border px-2 py-0.5 text-2xs text-text-muted transition-colors hover:border-border-bright hover:text-text-primary disabled:opacity-40"
              >
                {verifying ? 'verifying…' : 'Verify block cryptography'}
              </button>
            </div>

            <div className="space-y-2">
              <Hash label="Parent (H n−1)" value={isGenesis ? GENESIS : record.prev_block_hash} note={isGenesis ? 'genesis' : undefined} />
              <Hash label="Payload SHA-256" value={record.payload_hash} />
              <Hash label="Block (H n)" value={record.block_hash} accent />
            </div>

            {verification ? (
              <div
                className={`mt-3 rounded border px-3 py-2 ${
                  linkOk ? 'border-emerald/30 bg-emerald/[0.06]' : 'border-rose/40 bg-rose/[0.08]'
                }`}
              >
                <div className={`text-xs tracking-tight ${linkOk ? 'text-emerald' : 'text-rose'}`}>
                  {linkOk ? '✓ CHAIN VALID' : `✕ ${verification.failures.join(', ')}`}
                  <span className="tnum ml-2 text-text-muted">
                    recomputed in {verification.elapsed_ms.toFixed(3)}ms
                  </span>
                </div>
                {!linkOk && (
                  <div className="tnum mt-2 space-y-1 text-[10px] text-text-muted">
                    <div>stored payload {verification.stored_payload_hash}</div>
                    <div className="text-rose/80">recomputed {verification.recomputed_payload_hash}</div>
                  </div>
                )}
              </div>
            ) : null}
          </section>

          {/* Canonical raw payload — the exact bytes that were hashed */}
          <section>
            <h3 className="mb-2 text-2xs uppercase tracking-[0.14em] text-text-muted">
              Raw wire payload
              <span className="ml-2 normal-case tracking-normal text-text-muted/60">
                the bytes the payload hash covers
              </span>
            </h3>
            <pre className="tnum max-h-72 overflow-auto rounded border border-border bg-surface-subtle p-3 text-[11px] leading-relaxed text-text-muted">
              {canonical}
            </pre>
          </section>

          {/* Verify independently */}
          <section>
            <h3 className="mb-2 text-2xs uppercase tracking-[0.14em] text-text-muted">
              Verify independently
            </h3>
            <pre className="tnum overflow-auto rounded border border-border bg-surface-subtle p-3 text-[11px] text-emerald/80">
              python3 skills/verify_provenance/tool.py --receipt {record.receipt_id}
            </pre>
          </section>
        </div>
      </aside>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border/50 pb-1.5">
      <dt className="text-2xs uppercase tracking-[0.1em] text-text-muted">{label}</dt>
      <dd className="tnum text-xs text-text-primary">{children}</dd>
    </div>
  );
}

function Hash({
  label,
  value,
  note,
  accent = false,
}: {
  label: string;
  value: string;
  note?: string;
  accent?: boolean;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="text-2xs uppercase tracking-[0.1em] text-text-muted">{label}</span>
        {note ? <span className="text-[9px] uppercase tracking-[0.1em] text-text-muted/60">{note}</span> : null}
      </div>
      <div
        className={`tnum mt-0.5 break-all rounded border border-border bg-surface-subtle px-2 py-1 text-[11px] leading-relaxed ${
          accent ? 'text-text-primary' : 'text-text-muted'
        }`}
      >
        {value}
      </div>
    </div>
  );
}
