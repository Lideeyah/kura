# Kura — Demo Walkthrough

`kura-demo-walkthrough.mp4` — 1920x1080, **1m13s**, recorded by
`.recording/record-demo.mjs`. The recorder drives to *absolute* beats rather than
relative sleeps, so a slow evaluation steals from its own hold instead of pushing every
later scene out of sync with the narration.

Recorded against the local conformance peer: reproducible, zero-credential, and its
profiles carry the exact figures the script speaks (SOL 2.50% ATR, AVAX 11.29%).

---

## Spoken script, matched to the cut

### Scene 1 — Evaluator & dynamic sizing · 0:00–0:25

> "Autonomous agents fail silently when data feeds degrade. Kura is a deterministic
> pre-trade firewall.
>
> In the console, evaluating SOL passes all four gates in microseconds, allocating a
> full 100% cap at 2.5% ATR.
>
> Evaluating AVAX passes the same gates, but allocation automatically drops to 52% on
> higher volatility. Zero hallucinated sizing."

| Beat | On screen |
|---|---|
| 0:00 | Landing page |
| 0:06 | Click **Open Console** |
| 0:08 | Evaluate **SOL** → `APPROVED · 100.000% of cap · ATR 2.50%` |
| 0:16 | Evaluate **AVAX** → `APPROVED · 51.882% of cap · ATR 11.29%` |

### Scene 2 — Chaos Lab & upstream failures · 0:25–0:50

> "In Chaos Lab, we simulate real upstream failures.
>
> Triggering an upstream rate limit doesn't crash the loop. Kura parses the server's
> Retry-After header, enters backoff with jitter, and safely vetoes the trade when
> latency breaches our freshness threshold.
>
> Simulating synthetic data instantly trips our provenance gate — non-live data never
> touches capital."

| Beat | On screen |
|---|---|
| 0:25 | Chaos Lab |
| 0:28 | **Rate-limit the upstream** → backoff rows `429 · 1000ms · server Retry-After`, then `VETO_HALT · FRESHNESS breached: 2011ms > 1200ms (UPSTREAM_RATE_LIMITED)` |
| 0:40 | **Mark the feed non-live** → `VETO_HALT · PROVENANCE · data_mode="simulated" is not live` |
| 0:48 | Clear all injected faults |

### Scene 3 — Cryptographic audit ledger · 0:50–1:13

> "Every decision is committed to an append-only SQLite hash chain.
>
> Here are the five blocks from our evaluations: three approved, two vetoed. Clicking
> Verify recomputes every SHA-256 digest in sub-milliseconds — chain intact, zero
> tampering.
>
> Deterministic safety and full auditability, strictly compliant with Rule 6.05."

| Beat | On screen |
|---|---|
| 0:50 | Audit Ledger — `BLOCKS EVALUATED 5 · VETOES ENFORCED 2 · APPROVALS 3` |
| 0:58 | **Verify Hash Chain Integrity** → `CHAIN INTACT: 5/5 blocks verified (0 tampering detected)` |
| 1:05 | Open a block → parent / payload / block digests, `Block verified — recomputed in ~0.3ms` |

---

## Re-recording it

Every interaction is driven through a synthetic on-screen pointer with a click pulse
and a highlight on the target element — Playwright renders no cursor, so without it a
viewer sees screens changing with no visible cause and cannot reproduce the run.

```bash
pkill -f "apps/engine/src/index.ts"; lsof -ti:3200 | xargs -r kill
rm -f kura_flight_recorder.db*

RYO_MCP_TRANSPORT=stdio AUTO_EVALUATE=0 KURA_WATCHLIST=SOL,AVAX \
  INV_MAX_LATENCY_MS=1200 RYO_RATE_PER_MINUTE=0 npx kura start &

npm run build --workspace=apps/web
ENGINE_ORIGIN=http://localhost:4000 npx --workspace=apps/web next start -p 3200 &

npm install --no-save playwright && npx playwright install chromium
OUT_DIR=.recording/video node .recording/record-demo.mjs
# Trim the lead-in the recorder reports as LEAD_IN=… . Capture begins when the browser
# context is created, but the beat clock starts once the landing page has loaded; skip
# that gap or every beat sits late against the narration.
ffmpeg -ss <LEAD_IN> -i .recording/video/*.webm -t 73 -c:v libx264 -crf 20 \
  -pix_fmt yuv420p -movflags +faststart kura-demo-walkthrough.mp4
```

The recorder asserts against the live DOM and the engine's own stats before it passes,
so a silent regression fails the run rather than yielding a quietly wrong video. It also
aborts if the ledger is non-empty at startup — a stale engine appending to the same
SQLite file is what produced a wrong block count on an earlier take.

---

## Narration notes

- **Say "sub-millisecond circuit breaking, typically 20–80 microseconds."** Measured
  across 12 consecutive runs: min 11µs, median 29µs, max 137µs, with the first
  evaluation after a page load reading a couple of hundred. "Sub-100µs" is checkable and
  occasionally wrong; this phrasing is impressive and bulletproof.
- **Don't call the conformance peer a mock.** It is a real MCP server over real stdio
  publishing the real six-tool envelope.
- **Don't say the ledger proves the data is true.** It proves what the agent observed
  and that the record was not altered afterwards. The Threat Model section in README.md
  states the boundary.
