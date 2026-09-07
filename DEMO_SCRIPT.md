# KURA — 2–3 Minute Demo Script

Shot list with the actual values the system produces. Every number below was measured,
not estimated. Recorded against the local conformance peer, so it needs no credential
and is fully reproducible by a judge.

## Before you hit record

```bash
cd KURA
lsof -ti:4000 | xargs -r kill        # clear a stale engine
rm -f kura_flight_recorder.db*       # start from genesis so HEIGHT is small and legible
npx kura start                       # terminal 1
npm run dev:web                      # terminal 2 → http://localhost:3000
```

Then **run one evaluation before recording** — click *Evaluate* once and discard it.
The first gate evaluation on a cold process costs ~300 µs of V8 JIT warm-up; every
one after is ~30 µs. If you record the very first call, the on-screen number will
undersell the breaker by an order of magnitude.

Browser at 1440px wide. Collapse nothing — the integration drawer is scene 1.

---

## Scene 1 — The gateway and the nominal path (~45 s)

**Show:** the terminal at the top of the dashboard.

> "KURA is an MCP gateway. It speaks MCP client upstream to RYO-CHAN, and MCP server
> downstream to your agent."

Point at the **Integration** drawer — the three panels: `npx kura start`, the endpoint
`http://localhost:4000/mcp`, and the `mcpServers` JSON block.

> "Your agent registers this URL and calls `evaluate_candidate` instead of the research
> tools directly. That means the gate sits between the agent and execution, and the
> agent cannot route around it."

Point at the ribbon.

> "Six live tools — that's RYO's actual surface. Latency per tool, in tabular figures so
> nothing jitters as the stream updates."

Type `SOL` and click **Evaluate**.

**Expect on screen:**
```
TARGET   SOL/USDC          VERDICT  APPROVED        SIZING  5.000%  $5,000
✓ FRESHNESS          rtt 1.2 ms, as_of 12000 ms old
✓ ORACLE INTEGRITY   ok
✓ DATA PROVENANCE    live
✓ EVIDENCE FLOOR     price $172.44, ATR 2.50%
GATE ~20–50µs   STATUS ok   DATA MODE live
```

> "Four gates, all green, and a bounded position size — fractional Kelly, capped at 5%
> of bankroll. The whole gate ran in tens of microseconds with no language model in the
> path."

Read the number off the screen rather than memorising one — it varies run to run
(measured 21–50 µs warm).

Point at the bottom row appearing in the **Flight Recorder**.

> "And it's committed to a SHA-256 hash chain in SQLite before I finish this sentence."

**Optional, if you have 5 seconds spare:** evaluate `AVAX` to show sizing actually
varies. Measured: `APPROVED · 2.594% · $2,594 · ATR 11.29% · clamped NONE` — a smaller
size than SOL because its volatility is higher and its intelligence coverage is partial.
That kills the "the number is hardcoded" suspicion in one click.

---

## Scene 2 — Adversarial injection and the circuit breaker (~45 s)

**Show:** the Adversarial Chaos Injector, right panel.

> "Now let's break it."

**Do the provenance failure first** — it leaves the connection intact, so there is no
reconnect wait mid-scene. Click **SIMULATED data**.

**Expect on screen:**
```
✓ FRESHNESS          ✓ ORACLE INTEGRITY  ok
✕ DATA PROVENANCE    simulated
— EVIDENCE FLOOR     SHORT-CIRCUITED
PROVENANCE rejected: data_mode="simulated" is not live
```

> "RYO tells you the provenance of every measurement. This result is complete, it's
> fresh, and it's fake. KURA refuses to size capital against anything that isn't a live
> read. No amount of model reasoning catches that — it's a field you either check or
> you don't."

Now the hard failure. Click **DROP analyze_token (503)**.

Point at the ribbon: the `analyze_token` chip flips to rose with a `DROP` badge and
status `DROPPED`.

Click **Evaluate**.

**Expect on screen:**
```
TARGET   SOL/USDC          VERDICT  VETO_HALT       SIZING  0.000%  no capital at risk
✓ FRESHNESS          rtt 15.3 ms  →  then FAIL: no envelope (TRANSPORT_DROPPED)
— ORACLE INTEGRITY   SHORT-CIRCUITED
— DATA PROVENANCE    SHORT-CIRCUITED
— EVIDENCE FLOOR     SHORT-CIRCUITED
GATE ~15–40µs   TRIGGER ORACLE_DROP
```

> "Fifteen microseconds. The connection was severed, so the arbiter got a null envelope
> and halted."

Again, read the live number — measured 15–40 µs.

Point at the three dimmed rows.

> "This is the part that matters. Those three gates were never evaluated. An LLM agent
> in this position reasons around the gap — it retries, or fills the hole with a
> plausible number. KURA has no fallback branch to take. Capital allocation is zero."

Click **RESET ALL FAULTS**.

> "And it recovers on its own."

⚠ **Wait for `MCP CONNECTED` to go green before clicking anything else.** A DROP severs
the live transport for real, and the supervisor reconnects on a backoff — roughly a
second. Click too fast and the next evaluation vetoes with `NOT_CONNECTED` instead of
the gate you meant to show. Watch the header indicator, not the clock.

---

## Scene 3 — Cryptographic audit, in the browser and the terminal (~40 s)

Click **inspect** on the veto row in the Flight Recorder.

The drawer slides in from the right — no page reload, no layout shift behind it.

> "Every decision is a block. Parent hash, payload hash, block hash — and the raw wire
> payload those hashes actually cover."

Click **Verify block cryptography**.

**Expect:** `✓ CHAIN VALID — recomputed in 0.29ms`

> "That's the engine recomputing its own work, which proves nothing on its own."

**Cut to terminal.** Copy the command straight out of the drawer.

```bash
python3 skills/verify_provenance/tool.py --all --quiet
```

**Expect:**
```
verify_provenance — /Users/.../kura_flight_recorder.db
blocks checked: N

CHAIN INTACT — N/N blocks verified in X ms (0.06 ms/block)
```

> "This is standard-library Python. It shares no code with the TypeScript that wrote
> those hashes — it recomputes every one from raw disk state. Agreement between two
> independent implementations is evidence, not a tautology."

**The closer — tamper detection.** This is the strongest 10 seconds in the video:

```bash
npm run demo
```

Scroll to step 7:
```
── 7. a forged row is detected ──
   forged seq 3 (SOL) on disk
   → CHAIN BROKEN at seq 3: PAYLOAD_HASH_MISMATCH, BLOCK_HASH_MISMATCH
```

> "Alter one historical record and the chain breaks at exactly that block, and names
> which hash failed. That's the difference between a log and a ledger."

---

## Closing line (~10 s)

> "Four deterministic gates, no model in the decision path, and a decision history
> anyone can verify from their own terminal in under a millisecond a block. Eighty-two
> tests, and a hundred and fifty real fault-injection trials at a hundred percent
> detection and recovery."

---

## Things to avoid saying

- Don't say "honeypot detection" or "liquidity floor." Those gates were built against a
  `check_safety` tool that RYO does not publish, and they were removed. Saying it would
  be an easy thing for a judge to check and disprove.
- Don't call the conformance peer a mock. It's a real MCP server over real stdio
  publishing the real envelope. Say "local conformance peer" and, if asked, that the
  engine has no offline mode and fails loudly when its configured peer is unreachable.
- Don't claim a live-endpoint run unless you've done one by recording time.
- Don't show `.env` on camera once your real key is in it.
