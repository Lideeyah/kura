'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useConsole } from '../TelemetryProvider';
import { Button, Metric, Panel, PageTitle, Spinner } from '../ui';
import { failedGateOf, formatClock, formatSeq, triggeredGate, truncateHash } from '../../signal';
import type { LedgerRecord, VerificationResult } from '../../types';

interface Stats {
  total: number;
  approved: number;
  vetoed: number;
  headBlockHash: string | null;
  headSeq: number;
  journalMode: string;
  ledgerPath: string;
}

const PAGE_SIZE = 25;

export default function LedgerPage() {
  const { telemetry, post } = useConsole();
  const [stats, setStats] = useState<Stats | null>(null);
  const [rows, setRows] = useState<LedgerRecord[]>([]);
  const [page, setPage] = useState(0);
  const [chain, setChain] = useState<{ valid: boolean; length: number; brokenAtSeq: number | null } | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [selected, setSelected] = useState<LedgerRecord | null>(null);
  const [receipt, setReceipt] = useState<VerificationResult | null>(null);

  const load = useCallback(async () => {
    const [s, l] = await Promise.all([
      fetch('/api/ledger/stats').then((r) => r.json() as Promise<Stats>),
      fetch(`/api/ledger?limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`).then(
        (r) => r.json() as Promise<{ count: number; records: LedgerRecord[] }>,
      ),
    ]);
    setStats(s);
    setRows(l.records);
  }, [page]);

  // Reload when the page changes, and when a new block lands on the stream.
  useEffect(() => {
    void load();
  }, [load, telemetry.records.length]);

  const verifyChain = useCallback(async () => {
    setVerifying(true);
    try {
      setChain(await fetch('/api/verify/chain').then((r) => r.json()));
    } finally {
      setVerifying(false);
    }
  }, []);

  const inspect = useCallback(
    async (r: LedgerRecord) => {
      setSelected(r);
      setReceipt(null);
      setReceipt((await post('/api/verify', { receipt_id: r.receipt_id })) as VerificationResult);
    },
    [post],
  );

  const pages = useMemo(() => Math.max(1, Math.ceil((stats?.total ?? 0) / PAGE_SIZE)), [stats]);

  return (
    <>
      <PageTitle
        title="Audit Ledger"
        blurb="Append-only, hash-chained decision history. Every block links to its predecessor, so altering any historical record breaks the chain at exactly that block."
      />

      {/* A — Chain health */}
      <Panel className="mb-4">
        <div className="flex flex-wrap items-start gap-x-14 gap-y-5 px-5 py-5">
          <Metric label="Blocks evaluated" value={stats?.total ?? '—'} />
          <Metric label="Vetoes enforced" value={stats?.vetoed ?? '—'} tone="text-veto" />
          <Metric label="Approvals" value={stats?.approved ?? '—'} tone="text-approved" />
          <Metric
            label="Chain head"
            value={
              stats?.headBlockHash ? (
                <span title={stats.headBlockHash}>{truncateHash(stats.headBlockHash, 16)}</span>
              ) : (
                '—'
              )
            }
          />
          <div className="ml-auto flex items-center gap-4">
            {chain ? (
              <span className={`tnum text-2xs ${chain.valid ? 'text-approved' : 'text-veto'}`}>
                {chain.valid
                  ? `CHAIN INTACT: ${chain.length}/${chain.length} blocks verified (0 tampering detected)`
                  : `CHAIN BROKEN at seq ${chain.brokenAtSeq}`}
              </span>
            ) : null}
            <Button onClick={() => void verifyChain()} disabled={verifying}>
              {verifying ? (
                <span className="flex items-center gap-2">
                  <Spinner /> Verifying
                </span>
              ) : (
                'Verify Hash Chain Integrity'
              )}
            </Button>
          </div>
        </div>
      </Panel>

      {/* B — Chronological ledger */}
      <Panel
        title="Append-only ledger"
        meta={
          <div className="flex items-center gap-2">
            <span className="tnum text-2xs text-text-dim">
              page {page + 1} / {pages}
            </span>
            <Button disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
              ←
            </Button>
            <Button disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>
              →
            </Button>
          </div>
        }
      >
        {rows.length === 0 ? (
          <p className="px-5 py-10 text-center text-xs text-text-muted">No blocks committed yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  {['Seq #', 'Timestamp', 'Symbol', 'Verdict', 'Trigger gate', 'SHA-256 digest'].map((h) => (
                    <th
                      key={h}
                      className="px-4 py-2.5 text-left text-2xs font-medium uppercase tracking-[0.1em] text-text-dim"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.receipt_id}
                    onClick={() => void inspect(r)}
                    className={`cursor-pointer border-b border-border/60 transition-colors last:border-0 ${
                      selected?.receipt_id === r.receipt_id ? 'bg-surface-2' : 'hover:bg-surface-2/60'
                    }`}
                  >
                    <td className="tnum px-4 py-2.5 text-xs text-text-muted">{formatSeq(r.seq)}</td>
                    <td className="tnum px-4 py-2.5 text-xs text-text-muted">{formatClock(r.timestamp)}</td>
                    <td className="tnum px-4 py-2.5 text-xs text-text-primary">{r.token}</td>
                    <td
                      className={`px-4 py-2.5 text-xs ${
                        r.decision === 'APPROVED' ? 'text-approved' : 'text-veto'
                      }`}
                    >
                      {r.decision === 'APPROVED' ? 'APPROVED' : 'VETO_HALT'}
                    </td>
                    <td className="tnum px-4 py-2.5 text-xs text-text-muted">
                      {triggeredGate(r.reason, failedGateOf(r.invariants_json))}
                    </td>
                    <td className="tnum px-4 py-2.5 text-xs text-text-muted" title={r.block_hash}>
                      {truncateHash(r.block_hash, 20)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {selected ? (
        <BlockDrawer
          record={selected}
          receipt={receipt}
          onClose={() => {
            setSelected(null);
            setReceipt(null);
          }}
        />
      ) : null}
    </>
  );
}

function BlockDrawer({
  record,
  receipt,
  onClose,
}: {
  record: LedgerRecord;
  receipt: VerificationResult | null;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  let payload = record.raw_payload_json;
  try {
    payload = JSON.stringify(JSON.parse(record.raw_payload_json), null, 2);
  } catch {
    /* keep verbatim if unparseable */
  }

  return (
    <div className="fixed inset-0 z-50">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-canvas/70 backdrop-blur-[2px]"
      />
      <aside
        role="dialog"
        aria-modal="true"
        className="absolute right-0 top-0 flex h-full w-full max-w-[40rem] animate-drawer-in flex-col border-l border-border-strong bg-surface"
      >
        <header className="flex shrink-0 items-center justify-between gap-4 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <div className="text-2xs uppercase tracking-[0.12em] text-text-muted">
              Block {formatSeq(record.seq)}
            </div>
            <div className="tnum mt-0.5 truncate text-xs text-text-primary">{record.receipt_id}</div>
          </div>
          <Button onClick={onClose}>ESC</Button>
        </header>

        <div className="min-h-0 flex-1 space-y-5 overflow-auto px-5 py-5">
          {receipt ? (
            <div
              className={`rounded border px-4 py-3 ${
                receipt.valid ? 'border-approved/30 bg-approved/[0.06]' : 'border-veto/40 bg-veto/[0.08]'
              }`}
            >
              <span className={`text-xs ${receipt.valid ? 'text-approved' : 'text-veto'}`}>
                {receipt.valid ? '✓ Block verified' : `✕ ${receipt.failures.join(', ')}`}
              </span>
              <span className="tnum ml-2 text-2xs text-text-muted">
                recomputed in {receipt.elapsed_ms.toFixed(3)}ms
              </span>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-2xs text-text-muted">
              <Spinner /> recomputing hashes
            </div>
          )}

          <Hash label="Parent digest (H n−1)" value={record.prev_block_hash} />
          <Hash label="Payload digest" value={record.payload_hash} />
          <Hash label="Block digest (H n)" value={record.block_hash} strong />

          <section>
            <h3 className="mb-2 text-2xs uppercase tracking-[0.12em] text-text-muted">
              Signed block payload
            </h3>
            <pre className="tnum max-h-80 overflow-auto rounded border border-border bg-canvas p-3 text-[11px] leading-relaxed text-text-muted">
              {payload}
            </pre>
          </section>

          <section>
            <h3 className="mb-2 text-2xs uppercase tracking-[0.12em] text-text-muted">
              Verify independently
            </h3>
            <pre className="tnum overflow-auto rounded border border-border bg-canvas p-3 text-[11px] text-approved/80">
              python3 skills/verify_provenance/tool.py --receipt {record.receipt_id}
            </pre>
          </section>
        </div>
      </aside>
    </div>
  );
}

function Hash({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div>
      <div className="text-2xs uppercase tracking-[0.1em] text-text-dim">{label}</div>
      <div
        className={`tnum mt-1 break-all rounded border border-border bg-surface-2 px-2.5 py-1.5 text-[11px] leading-relaxed ${
          strong ? 'text-text-primary' : 'text-text-muted'
        }`}
      >
        {value}
      </div>
    </div>
  );
}
