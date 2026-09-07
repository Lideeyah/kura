/**
 * Empirical resilience benchmark.
 *
 * Runs N real trials per fault class against a real MCP peer over real stdio, and
 * reports median / p95 recovery times. Nothing is simulated at the measurement layer:
 * a "recovery" is the wall-clock interval from the moment the fault is cleared to the
 * moment the engine commits a healthy APPROVED block to SQLite again.
 *
 *   npm run test:resilience            # 50 trials per class (default)
 *   TRIALS=10 npm run test:resilience  # quicker pass
 *
 * Fault classes:
 *   latency_spike     injected delay pushes the upstream past the 1200 ms ceiling
 *   malformed_payload the peer returns an envelope missing data_mode
 *   peer_crash        the MCP child process is killed and must be respawned
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Supervisor } from '../src/supervisor.js';
import { repoRoot } from '../src/config.js';

const TRIALS = Number(process.env.TRIALS ?? 50) || 50;
const HEALTHY = 'SOL';
const REPORT_PATH = join(repoRoot, 'bench-resilience.json');

interface Trial {
  recoveryMs: number;
  detectedVeto: boolean;
  detectedReason: string;
}

interface ClassReport {
  fault: string;
  trials: number;
  detectionRate: number;
  recoveryRate: number;
  medianMs: number;
  p95Ms: number;
  minMs: number;
  maxMs: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}

function summarise(fault: string, trials: Trial[]): ClassReport {
  const recovered = trials.filter((t) => Number.isFinite(t.recoveryMs)).map((t) => t.recoveryMs).sort((a, b) => a - b);
  return {
    fault,
    trials: trials.length,
    detectionRate: trials.filter((t) => t.detectedVeto).length / trials.length,
    recoveryRate: recovered.length / trials.length,
    medianMs: round(percentile(recovered, 50)),
    p95Ms: round(percentile(recovered, 95)),
    minMs: round(recovered[0] ?? Number.NaN),
    maxMs: round(recovered[recovered.length - 1] ?? Number.NaN),
  };
}

const round = (n: number) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : Number.NaN);

async function recoverToApproved(sup: Supervisor, deadlineMs = 20_000): Promise<number> {
  const t0 = performance.now();
  while (performance.now() - t0 < deadlineMs) {
    if (!sup.connected) {
      await sup.reconnectNow();
      continue;
    }
    const { verdict } = await sup.evaluate({ symbol: HEALTHY });
    if (verdict.decision === 'APPROVED') return performance.now() - t0;
  }
  return Number.NaN;
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'kura-bench-'));
  const sup = new Supervisor(
    {
      transport: 'stdio',
      command: 'npx',
      args: ['tsx', join(repoRoot, 'apps/engine/src/conformance/server.ts')],
    },
    join(dir, 'bench.db'),
  );

  process.stdout.write(`resilience benchmark — ${TRIALS} trials per fault class\n`);
  process.stdout.write('connecting to MCP peer over stdio... ');
  if (!(await sup.reconnectNow())) {
    process.stderr.write('\nfailed to reach the MCP peer; check .env\n');
    process.exit(1);
  }
  process.stdout.write('ok\n\n');

  const reports: ClassReport[] = [];

  // ── latency_spike ───────────────────────────────────────────────────────────
  const latency: Trial[] = [];
  for (let i = 0; i < TRIALS; i += 1) {
    sup.chaos.set('analyze_token', 'DELAY', 1400);
    const { verdict } = await sup.evaluate({ symbol: HEALTHY });
    sup.chaos.set('*', 'RESET');
    latency.push({
      recoveryMs: await recoverToApproved(sup),
      detectedVeto: verdict.decision === 'VETOED' && verdict.failedInvariant === 'FRESHNESS',
      detectedReason: verdict.reason,
    });
    progress('latency_spike', i + 1);
  }
  reports.push(summarise('latency_spike', latency));

  // ── malformed_payload ───────────────────────────────────────────────────────
  const malformed: Trial[] = [];
  for (let i = 0; i < TRIALS; i += 1) {
    const { verdict } = await sup.evaluate({ symbol: 'BADEV' });
    malformed.push({
      recoveryMs: await recoverToApproved(sup),
      detectedVeto:
        verdict.decision === 'VETOED' && verdict.reason.includes('SCHEMA_MISMATCH_OR_MISSING_FIELD'),
      detectedReason: verdict.reason,
    });
    progress('malformed_payload', i + 1);
  }
  reports.push(summarise('malformed_payload', malformed));

  // ── peer_crash ──────────────────────────────────────────────────────────────
  const crash: Trial[] = [];
  for (let i = 0; i < TRIALS; i += 1) {
    sup.chaos.set('analyze_token', 'DROP');
    const { verdict } = await sup.evaluate({ symbol: HEALTHY });
    sup.chaos.set('*', 'RESET');
    crash.push({
      recoveryMs: await recoverToApproved(sup),
      detectedVeto: verdict.decision === 'VETOED' && verdict.failedInvariant === 'FRESHNESS',
      detectedReason: verdict.reason,
    });
    progress('peer_crash', i + 1);
  }
  reports.push(summarise('peer_crash', crash));

  process.stdout.write('\n\n');
  const chain = sup.ledger.verifyChain();
  render(reports, chain);

  writeFileSync(
    REPORT_PATH,
    JSON.stringify(
      { generatedAt: new Date().toISOString(), trialsPerClass: TRIALS, reports, chain },
      null,
      2,
    ),
  );
  process.stdout.write(`report written to ${REPORT_PATH}\n`);

  await sup.stop();
  rmSync(dir, { recursive: true, force: true });

  const clean =
    reports.every((r) => r.detectionRate === 1 && r.recoveryRate === 1) && chain.valid;
  process.exit(clean ? 0 : 1);
}

function progress(label: string, n: number) {
  process.stdout.write(`\r  ${label.padEnd(18)} ${n}/${TRIALS}`);
}

function render(reports: ClassReport[], chain: { valid: boolean; length: number }) {
  const head = ['fault', 'trials', 'detected', 'recovered', 'median', 'p95', 'min', 'max'];
  const rows = reports.map((r) => [
    r.fault,
    String(r.trials),
    `${(r.detectionRate * 100).toFixed(0)}%`,
    `${(r.recoveryRate * 100).toFixed(0)}%`,
    `${r.medianMs} ms`,
    `${r.p95Ms} ms`,
    `${r.minMs} ms`,
    `${r.maxMs} ms`,
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join('  ');
  process.stdout.write(`${line(head)}\n`);
  process.stdout.write(`${widths.map((w) => '-'.repeat(w)).join('  ')}\n`);
  for (const r of rows) process.stdout.write(`${line(r)}\n`);
  process.stdout.write(
    `\nledger chain after ${chain.length} blocks: ${chain.valid ? 'INTACT' : 'BROKEN'}\n`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
