/**
 * One-command proof. Runs the whole thesis end-to-end against a live MCP peer and
 * prints what happened, in order:
 *
 *   1. a clean token is APPROVED and sized
 *   2. simulated data is VETOED on PROVENANCE — the data changed the outcome
 *   3. analyze_token is dropped; the breaker vetoes in microseconds with no LLM
 *   4. an injected latency spike trips the 1200 ms ceiling
 *   5. the engine recovers on its own and approves again
 *   6. every decision is committed to a SHA-256 hash chain that verifies
 *   7. a forged row is detected, and the exact broken block is named
 *
 *   npm run demo
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Supervisor } from '../src/supervisor.js';
import { config, repoRoot } from '../src/config.js';

/**
 * Each step states the outcome it claims, and the run fails if reality disagrees.
 *
 * Without this the demo only checked the ledger: an injected latency spike that
 * silently stopped tripping FRESHNESS still printed a confident, green-looking run.
 * A demonstration that cannot fail is a slideshow.
 */
const claims: Array<{ step: number; claim: string; ok: boolean; saw: string }> = [];
const claim = (n: number, text: string, ok: boolean, saw: string) =>
  claims.push({ step: n, claim: text, ok, saw });

const step = (n: number, title: string) => console.log(`\n── ${n}. ${title} ${'─'.repeat(Math.max(0, 58 - title.length))}`);
const money = (n: number) => `$${n.toLocaleString('en-US')}`;

function show(v: {
  token: string; decision: string; reason: string; evaluationMicros: number;
  sizing: { positionUsd: number } | null;
  invariants: Array<{ id: string; state: string; actual: string }>;
}) {
  console.log(`   ${v.token}: ${v.decision} in ${v.evaluationMicros} µs`);
  console.log(`   ${v.reason}`);
  for (const i of v.invariants) console.log(`     ${i.id.padEnd(10)} ${i.state.padEnd(14)} ${i.actual}`);
  if (v.sizing) console.log(`     position    ${money(v.sizing.positionUsd)}`);
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'kura-demo-'));
  const dbPath = join(dir, 'demo.db');
  const sup = new Supervisor(
    { transport: 'stdio', command: 'npx', args: ['tsx', join(repoRoot, 'apps/engine/src/conformance/server.ts')] },
    dbPath,
  );

  console.log('KURA — end-to-end demonstration');
  console.log(`ledger: ${dbPath}`);
  if (!(await sup.reconnectNow())) {
    console.error('could not reach the MCP peer — check .env');
    process.exit(1);
  }
  console.log(`peer:   ${sup.client.description} (journal_mode=${sup.ledger.journalMode})`);

  step(1, 'a clean, deep token is approved and sized');
  const approved = (await sup.evaluate({ symbol: 'SOL' })).verdict;
  show(approved);
  claim(1, 'APPROVED with a non-zero size',
    approved.decision === 'APPROVED' && (approved.sizing?.positionUsd ?? 0) > 0,
    `${approved.decision}, position ${money(approved.sizing?.positionUsd ?? 0)}`);

  step(2, 'simulated data is refused — the data changed the outcome');
  const sim = (await sup.evaluate({ symbol: 'SIMUL' })).verdict;
  show(sim);
  claim(2, 'VETOED on PROVENANCE',
    sim.decision === 'VETOED' && sim.failedInvariant === 'PROVENANCE',
    `${sim.decision} on ${sim.failedInvariant}`);

  step(3, 'analyze_token is dropped: zero-fallback circuit breaker');
  sup.chaos.set('analyze_token', 'DROP');
  const dropped = await sup.evaluate({ symbol: 'SOL' });
  show(dropped.verdict);
  console.log(`     receipt     ${dropped.record.receipt_id}`);
  console.log(`     block hash  ${dropped.record.block_hash}`);
  claim(3, 'VETOED with no envelope, in microseconds',
    dropped.verdict.decision === 'VETOED' && dropped.verdict.evaluationMicros < 1000,
    `${dropped.verdict.decision} in ${dropped.verdict.evaluationMicros} us`);
  sup.chaos.set('*', 'RESET');
  await sup.reconnectNow();

  const ceiling = config.invariants.maxLatencyMs;
  step(4, `a latency spike trips the ${ceiling} ms ceiling`);
  sup.chaos.set('analyze_token', 'DELAY', ceiling + 200);
  const slow = (await sup.evaluate({ symbol: 'SOL' })).verdict;
  show(slow);
  // The one the old demo could not fail: injected latency must reach the gate. When
  // pacing reset the clock before the delay was applied, this approved at ~5 ms.
  claim(4, 'VETOED on FRESHNESS, with the injected delay actually measured',
    slow.decision === 'VETOED' && slow.failedInvariant === 'FRESHNESS' && slow.latencyMs > ceiling,
    `${slow.decision} on ${slow.failedInvariant} at ${slow.latencyMs} ms`);
  sup.chaos.set('*', 'RESET');

  step(5, 'the engine recovers on its own');
  const t0 = performance.now();
  const recovered = await sup.evaluate({ symbol: 'SOL' });
  console.log(`   ${recovered.verdict.decision} again after ${(performance.now() - t0).toFixed(1)} ms`);
  claim(5, 'APPROVED again once the fault clears',
    recovered.verdict.decision === 'APPROVED', recovered.verdict.decision);

  step(6, 'the whole chain verifies');
  const chain = sup.ledger.verifyChain();
  console.log(`   ${chain.valid ? 'CHAIN INTACT' : 'CHAIN BROKEN'} — ${chain.length} blocks`);
  const head = sup.ledger.head()!;
  const verified = sup.ledger.verify(head.receipt_id);
  console.log(`   receipt ${head.receipt_id} → ${verified.valid ? 'VALID' : 'INVALID'} in ${verified.elapsed_ms.toFixed(3)} ms`);
  console.log(`   genesis links from ${sup.ledger.list(1)[0]!.prev_block_hash}`);

  step(7, 'a forged row is detected');
  const victim = sup.ledger.list(10)[2]!;
  const forged = JSON.parse(victim.raw_payload_json);
  if (forged.analyze_token) forged.analyze_token.data_mode = 'live';
  else forged.forged = true;
  const db = new Database(dbPath);
  db.prepare('UPDATE ledger SET raw_payload_json = ? WHERE receipt_id = ?')
    .run(JSON.stringify(forged), victim.receipt_id);
  db.close();
  const broken = sup.ledger.verifyChain();
  console.log(`   forged seq ${victim.seq} (${victim.token}) on disk`);
  console.log(`   → ${broken.valid ? 'NOT DETECTED (bug!)' : `CHAIN BROKEN at seq ${broken.brokenAtSeq}: ${broken.failures.join(', ')}`}`);
  console.log(`\n   independent check:  python3 skills/verify_provenance/tool.py --db ${dbPath} --all`);

  claim(6, 'chain intact before tampering, broken after', chain.valid && !broken.valid,
    `intact=${chain.valid}, detected=${!broken.valid}`);

  await sup.stop();

  const failed = claims.filter((c) => !c.ok);
  console.log('\n── claims ' + '─'.repeat(54));
  for (const c of claims) {
    console.log(`   ${c.ok ? 'PASS' : 'FAIL'}  step ${c.step}: ${c.claim}`);
    if (!c.ok) console.log(`         saw: ${c.saw}`);
  }
  if (failed.length > 0) process.exitCode = 1;
  console.log(
    `\n${failed.length === 0
      ? 'demo complete — every claim above was executed and checked, not asserted.'
      : `demo FAILED — ${failed.length} claim(s) did not hold`}`,
  );
  if (!process.env.KEEP_DEMO_DB) rmSync(dir, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
