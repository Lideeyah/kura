# Kura — Demo Shot List (target 2:00, single take)

Every number below was measured against the running system, not estimated. Recorded
against the local conformance peer, so it needs no credential and a judge can reproduce
it exactly.

---

## Pre-flight — do this before you hit record

```bash
cd KURA
lsof -ti:4000 | xargs -r kill          # clear a stale engine
lsof -ti:3200 | xargs -r kill
rm -f kura_flight_recorder.db*         # start from genesis

# Autonomous loop OFF and a two-symbol watchlist, so the ledger contains ONLY the
# evaluations you perform on camera. This is what makes Scene 3 land.
AUTO_EVALUATE=0 KURA_WATCHLIST=SOL,AVAX npx kura start

# second terminal
npm run dev:web                        # http://localhost:3000
```

**Then run one throwaway evaluation and discard it.** The first gate call on a cold
process pays ~300 µs of V8 JIT warm-up; every one after is 20–80 µs. Record the cold one
and you undersell the breaker by 5×.

Browser window ~1440px wide. Console content caps at 1240px, so anything wider only adds
margin.

Keep a terminal one keystroke away. You won't need it, but if a judge asks "is that
real?", `python3 skills/verify_provenance/tool.py --all --quiet` is the answer.

---

## Scene 1 — Landing → the clean path  (0:00–0:40)

**Start on `/`.** Do not scroll. The headline is the framing.

> "Kura is a deterministic pre-trade execution firewall for autonomous agents. Pre-trade
> invariant verification and a cryptographic audit trail, before capital is committed."

**[0:08]** Click **Open Console** → `/app/evaluator`.

**[0:12]** `SOL` is already in the candidate field. Click **Evaluate Candidate**.

Expected on screen:

```
TARGET  SOL/USDC    VERDICT  APPROVED    SIZING ALLOCATION  100.000% of bankroll cap
GATE TIME 57µs   ROUND TRIP 1.49ms   UPSTREAM STATUS ok   DATA MODE live
```

> "Four gates, all green, in fifty-seven microseconds — with no language model anywhere
> in that path. The allocation is a hundred percent of a hard risk cap, not a dollar
> mandate."

⚠ **Read the gate time off the screen.** It varies 20–80 µs warm. Say "tens of
microseconds" if you'd rather not chase a number.

**[0:24]** Click the **EVIDENCE FLOOR** row to expand it, then **scroll down far enough
to show the whole JSON block and the sizing note under it** — at 1080p the payload runs
below the fold. Hold it, then scroll straight back to the top so the candidate bar and
Evaluate button are on screen for the next step.

> "Every gate shows the exact field it read. This one resolved price and ATR-14 out of
> the live payload — and if it couldn't find them, it vetoes rather than substituting a
> zero."

**[0:32]** Click the **AVAX** quick-pick, then **Evaluate Candidate**.

```
AVAX/USDC   APPROVED   51.882% of bankroll cap
```

> "Same four gates, half the allocation — because AVAX carries an eleven percent ATR
> against SOL's two and a half. The sizing moves with measured volatility. Nothing here
> is hardcoded."

*This is the shot that kills the "the number is fake" suspicion. Don't skip it.*

---

## Scene 2 — Adversarial chaos and a real 429  (0:40–1:25)

**[0:40]** Click **Chaos Lab** in the nav.

> "Four injectors, each mapped to a real upstream failure mode."

**[0:45]** Fire **Rate-limit the upstream → Inject**.

⚠ **This takes about two seconds of visible waiting — that is the point, not a stall.**
Narrate straight through it:

> "It's waiting out the server's Retry-After right now. This is the same retry wrapper
> that goes around every live HTTP request — real 429, real Retry-After header, and full
> jitter when the server doesn't send one."

Expected in **Backoff activity** (right column):

```
429 · 1000ms   attempt 1/3 · server Retry-After
429 · 1000ms   attempt 2/3 · server Retry-After
```

And in **Last verdict under fire**:

```
SOL   VETO_HALT   breaker 156µs   FRESHNESS
FRESHNESS breached: 2007.69 ms > 1200 ms (UPSTREAM_RATE_LIMITED)
```

**[1:02]**

> "Two seconds of retries genuinely blew the freshness budget, so it halted — and the
> reason names the cause. It doesn't just say 'slow', it says rate-limited, so nobody
> goes hunting for a network fault that isn't there."

**[1:08]** Fire **Mark the feed non-live → Inject**.

```
SOL   VETO_HALT   breaker 76µs   PROVENANCE
PROVENANCE rejected: data_mode="simulated" is not live
```

⚠ **Your outline said "sub-50 µs" — the measured value is 76 µs**, and the warm range is
20–80 µs. Say "under a hundred microseconds", or just read the screen. Don't claim sub-50
over a display that reads 76.

> "Complete, fresh, and fake. RYO publishes the provenance of every measurement, and Kura
> refuses to size capital against anything that isn't a live read. Seventy-six
> microseconds — and the gate below it was never evaluated. There's no fallback branch to
> take."

**[1:20]** Click **Clear All Injected Faults**.

---

## Scene 3 — Cryptographic verification  (1:25–1:55)

**[1:25]** Click **Audit Ledger** in the nav.

```
BLOCKS EVALUATED 5   VETOES ENFORCED 2   APPROVALS 3   CHAIN HEAD 0213096120a9cc33…
```

> "Five blocks — exactly the five evaluations you just watched. Append-only, and each one
> chained to the block before it."

*The count is whatever is on your screen. With the pre-flight above it stays small and
matches what the viewer just saw — which is the entire reason to turn the autonomous loop
off.*

**[1:34]** Click **Verify Hash Chain Integrity**.

```
CHAIN INTACT: 5/5 blocks verified (0 tampering detected)
```

**[1:40]** Click any **VETO_HALT** row → the drawer slides in from the right.

> "Parent digest, payload digest, block digest — and the raw payload those hashes actually
> cover."

Point at `✓ Block verified — recomputed in 0.288ms`.

> "Recomputed live, in under a third of a millisecond. And that command at the bottom is a
> standalone Python tool that shares no code with the engine — a judge can run it in their
> own terminal against the same file."

---

## Closing  (1:55–2:00)

> "Read-only by construction. No signing keys, no wallet, no execution path — and no model
> guesses in the decision. Rule 6.05 compliant by design, not by policy."

---

## Optional 15s tail — only if the take runs short

```bash
npm run demo
```

Scroll to step 7:

```
── 7. a forged row is detected ──
   forged seq 3 (SOL) on disk
   → CHAIN BROKEN at seq 3: PAYLOAD_HASH_MISMATCH, BLOCK_HASH_MISMATCH
```

> "Alter one historical record and the chain breaks at exactly that block, naming which
> hash failed. That's the difference between a log and a ledger."

---

## Timing budget

| Scene | Window | Slack |
|---|---|---|
| 1 — Landing + clean path | 0:00–0:40 | comfortable |
| 2 — Chaos + 429 | 0:40–1:25 | **tight** — the 429 eats ~2s of it |
| 3 — Ledger + verification | 1:25–1:55 | comfortable |
| Close | 1:55–2:00 | — |

If you overrun, cut the **EVIDENCE FLOOR** row expansion first — it is the most expendable
and the least surprising to a judge. Cut the **AVAX** evaluation last; it is doing the most
persuasive work in the whole video.

---

## Things not to say

- **Don't say "honeypot detection" or "liquidity floor."** Those gates were built against
  a `check_safety` tool RYO does not publish, and were removed. Trivially disprovable.
- **Don't call the conformance peer a mock**, and don't say "simulate" about the chaos
  injectors. Both undercut the entire pitch. The peer is a real MCP server over real
  stdio publishing the real envelope; the injectors apply real faults to the live
  transport. The one place `simulated` appears on screen is the value of RYO's own
  `data_mode` field — say "RYO is telling us this reading isn't live, and Kura refuses
  it", never "we simulated the data".
- **Don't say the ledger proves the data is true.** It proves what the agent observed and
  that the record wasn't altered afterwards. There is no signature from RYO. That boundary
  is written up in the README's Threat Model section, and saying it out loud reads as
  maturity, not weakness.
- **Don't claim a live-endpoint run** unless you have done one by recording time.
- **Don't show `.env` on camera** once your real key is in it.
