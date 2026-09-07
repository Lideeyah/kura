'use client';

import type { LedgerRecord } from '../types';
import { failedGateOf, formatClock, formatSeq, formatUsd, triggeredGate, truncateHash } from '../signal';

const HEAD =
  'sticky top-0 z-10 bg-surface-subtle px-3 py-2 text-left text-2xs font-medium uppercase tracking-[0.1em] text-text-muted';

export function FlightRecorder({
  records,
  selectedId,
  onInspect,
}: {
  records: LedgerRecord[];
  selectedId: string | null;
  onInspect: (record: LedgerRecord) => void;
}) {
  if (records.length === 0) {
    return (
      <div className="flex h-40 items-center justify-center text-xs text-text-muted">
        No committed blocks yet.
      </div>
    );
  }

  return (
    <div className="max-h-[420px] overflow-auto">
      <table className="w-full border-collapse">
        <caption className="sr-only">
          Committed decisions, newest first, streamed from /api/stream
        </caption>
        <thead>
          <tr className="border-b border-border">
            <th scope="col" className={HEAD}>Seq</th>
            <th scope="col" className={HEAD}>Timestamp</th>
            <th scope="col" className={HEAD}>Token</th>
            <th scope="col" className={HEAD}>Decision</th>
            <th scope="col" className={`${HEAD} hidden md:table-cell`}>Triggered gate</th>
            <th scope="col" className={`${HEAD} hidden lg:table-cell text-right`}>Latency</th>
            <th scope="col" className={`${HEAD} hidden lg:table-cell text-right`}>Position</th>
            <th scope="col" className={`${HEAD} hidden sm:table-cell`}>Block hash</th>
            <th scope="col" className={`${HEAD} text-right`}>Audit</th>
          </tr>
        </thead>
        <tbody>
          {records.map((r) => {
            const halted = r.decision === 'VETOED';
            const selected = r.receipt_id === selectedId;
            return (
              <tr
                key={r.receipt_id}
                className={`border-b border-border/60 transition-colors last:border-0 ${
                  selected ? 'bg-surface-subtle' : 'hover:bg-surface-subtle/60'
                }`}
              >
                <td className="tnum px-3 py-1.5 text-xs text-text-muted">{formatSeq(r.seq)}</td>
                <td className="tnum px-3 py-1.5 text-xs text-text-muted">{formatClock(r.timestamp)}</td>
                <td className="tnum px-3 py-1.5 text-xs text-text-primary">
                  {r.token}
                  <span className="text-text-muted">/USDC</span>
                </td>
                <td className={`px-3 py-1.5 text-xs tracking-tight ${halted ? 'text-rose' : 'text-emerald'}`}>
                  {halted ? 'VETO_HALT' : 'APPROVED'}
                </td>
                <td className="tnum hidden px-3 py-1.5 text-xs text-text-muted md:table-cell">
                  {triggeredGate(r.reason, failedGateOf(r.invariants_json))}
                </td>
                <td className="tnum hidden px-3 py-1.5 text-right text-xs text-text-muted lg:table-cell">
                  {r.latency_ms}ms
                </td>
                <td className="tnum hidden px-3 py-1.5 text-right text-xs lg:table-cell">
                  <span className={r.position_usd > 0 ? 'text-emerald' : 'text-text-muted'}>
                    {r.position_usd > 0 ? formatUsd(r.position_usd) : '—'}
                  </span>
                </td>
                <td
                  className="tnum hidden px-3 py-1.5 text-xs text-text-muted sm:table-cell"
                  title={r.block_hash}
                >
                  {truncateHash(r.block_hash, 10)}
                </td>
                <td className="px-3 py-1.5 text-right">
                  <button
                    type="button"
                    onClick={() => onInspect(r)}
                    aria-label={`Audit receipt ${r.receipt_id}`}
                    className="rounded border border-border px-2 py-0.5 text-2xs text-text-muted transition-colors hover:border-border-bright hover:text-text-primary"
                  >
                    inspect
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
