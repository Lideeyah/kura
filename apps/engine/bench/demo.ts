/**
 * One-command proof. Runs the whole thesis end-to-end against a live MCP peer and
 * prints what happened, in order:
 *
 *   1. a clean token is APPROVED and sized
 *   2. a thin pool is VETOED on LIQUIDITY — the data changed the outcome
 *   3. check_safety is dropped; the breaker vetoes in microseconds with no LLM
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
import { repoRoot } from '../src/config.js';

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
  show((await sup.evaluate({ symbol: 'SOL' })).verdict);

  step(2, 'a thin pool is vetoed — the data changed the outcome');
  show((await sup.evaluate({ symbol: 'BONK' })).verdict);

  step(3, 'check_safety is dropped: zero-fallback circuit breaker');
  sup.chaos.set('check_safety', 'DROP');
  const dropped = await sup.evaluate({ symbol: 'SOL' });
  show(dropped.verdict);
  console.log(`     receipt     ${dropped.record.receipt_id}`);
  console.log(`     block hash  ${dropped.record.block_hash}`);
  sup.chaos.set('*', 'RESET');
  await sup.reconnectNow();

  step(4, 'a latency spike trips the 1200 ms ceiling');
  sup.chaos.set('analyze_token', 'DELAY', 1400);
  show((await sup.evaluate({ symbol: 'SOL' })).verdict);
  sup.chaos.set('*', 'RESET');

  step(5, 'the engine recovers on its own');
  const t0 = performance.now();
  const recovered = await sup.evaluate({ symbol: 'SOL' });
  console.log(`   ${recovered.verdict.decision} again after ${(performance.now() - t0).toFixed(1)} ms`);

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
  if (forged.analyze_token) forged.analyze_token.liquidity_usd = 99_000_000;
  else forged.forged = true;
  const db = new Database(dbPath);
  db.prepare('UPDATE ledger SET raw_payload_json = ? WHERE receipt_id = ?')
    .run(JSON.stringify(forged), victim.receipt_id);
  db.close();
  const broken = sup.ledger.verifyChain();
  console.log(`   forged seq ${victim.seq} (${victim.token}) on disk`);
  console.log(`   → ${broken.valid ? 'NOT DETECTED (bug!)' : `CHAIN BROKEN at seq ${broken.brokenAtSeq}: ${broken.failures.join(', ')}`}`);
  console.log(`\n   independent check:  python3 skills/verify_provenance/tool.py --db ${dbPath} --all`);

  await sup.stop();
  const clean = chain.valid && !broken.valid;
  if (!clean) process.exitCode = 1;
  console.log(`\n${clean ? 'demo complete — every claim above was executed, not asserted.' : 'demo FAILED'}`);
  if (!process.env.KEEP_DEMO_DB) rmSync(dir, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
