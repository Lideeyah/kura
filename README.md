# KURA (倉)

> **Deterministic Pre-Trade Execution Firewall & Cryptographic Black-Box Audit Engine for Autonomous Market Agents.**
> Built for the **RYO-CHAN Virtual Hackathon** — *Track 01: Autonomous Agents*.

**Demo:** [youtu.be/1MMqfDH9mUA](https://youtu.be/1MMqfDH9mUA) — a narrated 73-second walkthrough of the
evaluator, the chaos lab under a real HTTP 429, and the audit ledger verifying its own chain.
`kura-demo-walkthrough.mp4` in this repository is the same footage as an offline mirror, **without
the voiceover** — watch the YouTube cut first.

**Submission form:** [RYOCHAN-Hackthon-Project-Submission-Form.pdf](RYOCHAN-Hackthon-Project-Submission-Form.pdf)
— the completed three-page form, opened in the browser by GitHub's PDF viewer.
[KURA-RYOCHAN-Submission-Form.pdf](KURA-RYOCHAN-Submission-Form.pdf) is a byte-identical copy under
the generator's filename, and [SUBMISSION.md](SUBMISSION.md) is the same content as readable
Markdown — every field there is the source the PDF is rendered from.

---

### The Executive Problem

Autonomous agents fail silently before they fail loudly.

When downstream LLM-driven execution loops consume market intelligence tools directly, they operate
under an implicit, fatal premise: **that external signals are fresh, authentic, calibrated, and
live.**

In production systems, market feeds degrade intermittently:

* Upstream providers return HTTP 200 payloads wrapped in synthetic error bodies (`isError: true`).
* RPC endpoints saturate, triggering unhandled rate limiting and silent cascade stalls.
* Feed degraded states drop into `data_mode="simulated"` without warning.
* Autonomous agents hallucinate position sizing, treating high-volatility spikes identically to
  stable trends.

**Kura is the air-gap.** Sitting as a Model Context Protocol (MCP) gateway directly between external
intelligence feeds and downstream execution environments, Kura subjects every payload to
deterministic mathematical verification before capital can be touched.

Zero private keys. Zero transaction signing. Strictly compliant with **Rule 6.05**.

---

### Core Architecture & Invariant Gates

```
                  [ RYO-CHAN MCP / Market Tools ]
                                 │
                                 ▼
                ┌─────────────────────────────────┐
                │       KURA PROXY GATEWAY        │
                │   (Stateless HTTP / JSON-RPC)   │
                └────────────────┬────────────────┘
                                 │
             ┌───────────────────┴───────────────────┐
             ▼                                       ▼
┌───────────────────────────┐           ┌──────────────────────────┐
│     RESILIENCE ENGINE     │           │   DETERMINISTIC GATES    │
│ ───────────────────────── │           │ ──────────────────────── │
│ • Pacing & Burst Throttler│           │ 1. FRESHNESS (Latency)   │
│ • Exponential Backoff     │   ───►    │ 2. ORACLE (status: ok)   │
│ • Full Jitter Scheduling  │           │ 3. PROVENANCE (Live/Sim) │
│ • Retry-After Parser      │           │ 4. EVIDENCE (ATR Floor)  │
└───────────────────────────┘           └────────────┬─────────────┘
                                                     │
                                                     ▼
                                        ┌──────────────────────────┐
                                        │    MATHEMATICAL SIZING   │
                                        │ ──────────────────────── │
                                        │ Volatility-adjusted cap  │
                                        │ based on parsed ATR-14   │
                                        └────────────┬─────────────┘
                                                     │
                                                     ▼
                                        ┌──────────────────────────┐
                                        │    SHA-256 HASH CHAIN    │
                                        │ ──────────────────────── │
                                        │ Append-only SQLite WAL   │
                                        │ Block Receipts & Proofs  │
                                        └──────────────────────────┘
```

#### 1. Pre-flight validation and the invariant circuit breakers

* **`Envelope Validation`** — Pre-arbiter schema validation via `validateEnvelope`. Drops malformed
  dictionaries, missing metadata, or absent fields instantly with
  `SCHEMA_MISMATCH_OR_MISSING_FIELD`, before any gate runs.
* **`FRESHNESS`** — Rejects stale or queued messages. Round-trip telemetry and timestamp
  differentials are clamped against strict latency bounds (`INV_MAX_LATENCY_MS`). Self-imposed
  client pacing delays are decoupled, so internal rate-throttling never poisons upstream freshness
  measurements.
* **`ORACLE`** — Verifies operational feed integrity by validating upstream tool execution status
  (`status === 'ok'`). `partial` and `unavailable` are refusals, not degradations.
* **`PROVENANCE`** — Evaluates `data_mode`. If upstream feeds flip to `simulated` or a degraded
  fallback state, Kura trips an instantaneous circuit break. Non-live data is forbidden from
  influencing capital.
* **`EVIDENCE`** — Enforces verifiable technical indicators. Tokens missing authentic market pricing
  or volatility metrics (`atr_14_pct` or an absolute ATR) fail fast rather than being sized on a
  substituted zero.

#### 2. Deterministic risk and dynamic volatility sizing

Rather than allowing an LLM agent to hallucinate arbitrary trade sizing, Kura computes risk-adjusted
boundaries mathematically:

```
Allocation Cap = f(ATR₁₄)
```

* Tokens exhibiting low volatility (e.g. SOL at 2.50% ATR) receive full operational allocation
  (100.000% of cap).
* Tokens exhibiting elevated volatility (e.g. AVAX at 11.29% ATR) scale down dynamically
  (51.882% of cap).
* Hyper-volatile assets (≥ 50% ATR) are clamped to 0% execution allowance.

This is a heuristic volatility-adjusted cap, not a theoretical Kelly proof — see
[Position sizing](#position-sizing-detail) below for what the model does and does not claim.

#### 3. Cryptographic black-box audit trail

Every evaluation — whether `APPROVED` or `VETO_HALT` — is committed to an append-only, SQLite
WAL-mode hash chain.

Crucially, **the verdict itself is sealed within the hash**, so the decision cannot be altered
independently of the evidence that produced it:

```
Hₙ = SHA-256( Hₙ₋₁ : payloadHashₙ : timestampₙ : decisionₙ )
```

Genesis links from 64 zeros. Ships with an independent Python 3 verifier
(`skills/verify_provenance/tool.py`) that recomputes every digest from raw disk state outside the
Node.js runtime.

---

### Regulatory Alignment & Governance: The BLI Standard

As autonomous AI agents take on economic agency, they face emerging regulatory scrutiny around
algorithmic liability, market manipulation, and consumer protection.

In alignment with principles championed by hackathon partner the **Blockchain Legal Institute
(BLI)**, KURA moves autonomous agent systems from "black-box risk" toward verifiable institutional
governance:

* **Non-Custodial Compliance (Rule 6.05).** Strictly isolates intelligence from custody. KURA never
  handles, stores, or requests private keys. It issues gate receipts (`APPROVED` / `VETO_HALT`),
  leaving execution custody strictly segregated.
* **Forensic Non-Repudiation.** Post-trade disputes in automated trading usually stall because
  application logs can be altered or truncated. KURA seals every decision into an append-only,
  SHA-256 hash-chained SQLite WAL ledger that an external auditor can verify independently. The
  precise boundary of that guarantee — what it proves and what it does not — is stated in
  [Threat model and trust assumptions](#threat-model-and-trust-assumptions).
* **Consumer & Capital Protection.** Prevents algorithmic failure cascades by enforcing mathematical
  invariant gates, rejecting degraded `simulated` data modes, uncalibrated pricing anomalies, and
  stale feeds.

---

### Resilience: Hardened for Real-World Upstream Conditions

Every row below is a failure mode found by running against the live RYO-CHAN endpoint, not one
anticipated in design:

| Production failure mode | Unmitigated agent behavior | Kura invariant protection |
| :--- | :--- | :--- |
| **HTTP 200 with `isError: true`** | Agent parses partial payload; proceeds on bad data | Trapped at the protocol envelope; text pattern-matched before assigning `UPSTREAM_RATE_LIMITED`, otherwise `TOOL_ERROR` |
| **Silent burst saturation** | Upstream refuses queries despite unspent per-minute quota | Outbound rate-pacer enforces minimum call spacing, excluded from measured latency |
| **Stateless stream disconnects** | Standard MCP clients report fatal `NOT_CONNECTED` | Self-healing connection manager treats HTTP stream resets as ordinary stateless cycles |
| **Percentage-scale inversion** | Raw ATR percentages (e.g. `4.23`) misparsed as absolute values | Dual-path signal extractor converts percentage and absolute forms separately |

---

### Benchmark Verification

Audited against 128 automated tests across 9 test suites and live network telemetry:

```
── Invariant gate execution latency ──────────────────────────────────
   Min gate evaluation            11 µs
   Median gate evaluation         29 µs
   Typical warm execution         15 – 160 µs   (full engine pipeline)
   Cold-start gate evaluation    210 – 500 µs

── Cryptographic audit ledger ────────────────────────────────────────
   Storage                        SQLite WAL-mode append-only hash chain
   Block digest recomputation     0.06 – 0.70 ms per block (typical 0.25 ms)
   Tamper detection               Dual-language: TypeScript engine + Python CLI
```

Fault-injection recovery, 50 real trials per class, 100% detection and recovery:

| Fault | Median | p95 |
| :--- | ---: | ---: |
| Latency spike | 1.69 ms | 2.9 ms |
| Malformed payload | 0.47 ms | 0.93 ms |
| Peer crash (real process respawn) | 519.42 ms | 595.21 ms |

Reproduce with `npm run test:resilience`. Recovery is wall-clock from the fault clearing to a
healthy `APPROVED` block committing again.

---

### Operational Console

Four dedicated routes at `http://localhost:3200`:

* **`/app/evaluator`** — Live evaluation feed showing microsecond gate timings, dynamic sizing
  percentages as numeric readouts, and raw payload telemetry per gate.
* **`/app/chaos`** — Adversarial lab for on-the-fly injection of HTTP 429 rate limits, synthetic
  degradation modes, oracle degradation, and artificial latency stalls.
* **`/app/ledger`** — Tamper-evident block explorer with sub-millisecond chain verification and
  single-block audit drawers.
* **`/app/integration`** — Gateway reference for connecting external autonomous agents to the Kura
  firewall.

---

### Quickstart & Verification

Kura operates out of the box against an authentic zero-credential 6-tool JSON-RPC conformance peer.
Reviewers need no API keys to verify the entire system.

**Prerequisites** — Node.js v20.0.0+, npm v9.0.0+, Python v3.9+ (optional, for the independent
audit verifier).

```bash
git clone https://github.com/RYO-Digital/ryochan-hackathon_repository-249.git
cd ryochan-hackathon_repository-249

npm install
cp .env.example .env

# Engine on :4000, console on :3200
npm run dev
```

```bash
# 128 unit, integration and invariant regression tests across 9 suites
npm test
```

```bash
# Independent cryptographic audit of the SQLite chain, outside the Node.js runtime
python3 skills/verify_provenance/tool.py --all
```

---

### Repository Structure

```
├── apps/
│   ├── engine/
│   │   └── src/
│   │       ├── arbiter/          # Invariant gates + signals.ts (ATR/price extraction)
│   │       ├── ledger/           # Append-only SHA-256 SQLite hash-chain engine
│   │       ├── mcp/              # Client, interceptor, retry, pacer
│   │       ├── gateway/          # KURA's own MCP server surface
│   │       ├── schema/           # Envelope contract and runtime validation
│   │       └── conformance/      # Zero-credential 6-tool JSON-RPC peer
│   └── web/                      # Operations console (:3200)
├── skills/
│   └── verify_provenance/        # Standalone Python 3 cryptographic ledger verifier
├── SUBMISSION.md                 # Submission form content, source of the PDF below
├── RYOCHAN-Hackthon-Project-Submission-Form.pdf   # Completed submission form
├── KURA-RYOCHAN-Submission-Form.pdf               # Byte-identical copy, generator filename
└── kura-demo-walkthrough.mp4     # 73s walkthrough, offline mirror of the YouTube cut
```

---

### Hackathon Compliance (Rule 6.05)

* **No private key custody.** Kura never requests, stores, or handles private keys.
* **Read-only architecture.** Operates exclusively under `tools:read` scope to evaluate market
  intelligence before trade execution.
* **Zero direct order routing.** Issues verdict receipts (`APPROVED` / `VETO_HALT`); downstream
  agents retain sole responsibility for executing orders on verified parameters.

---

## Threat model and trust assumptions

KURA is **agent black-box auditing and deterministic circuit breaking**. It is not a
decentralised oracle and it does not attest to market truth. Stating the boundary
precisely is what makes the guarantee worth anything.

### What KURA proves

1. **What the agent observed** — the exact bytes RYO returned, hashed with SHA-256 over
   a canonical serialization.
2. **When it observed them** — the observation timestamp and the commit timestamp, both
   inside the hashed block.
3. **That the invariants were evaluated before any downstream handoff** — the verdict
   and every gate's empirical value live in the same hashed block as the payload that
   produced them. You cannot have the decision without the evidence it rests on.
4. **That the trail was not altered afterwards** — each block links to its predecessor,
   so editing any historical record breaks the chain at that exact block, provably and
   locally, and a standalone Python verifier confirms it independently.

### What KURA does not prove

1. **That RYO's data is correct.** KURA reads `status`, `data_mode` and `as_of` and
   refuses on anything but a complete live read. It cannot tell you whether a live read
   is *right*.
2. **That the recorded payload came from RYO.** There is no response signature from RYO,
   so the chain is written and attested by the engine itself. Anyone who controls the
   engine's configuration can point `RYO_MCP_URL` at a different MCP peer and mint a
   perfectly verifiable chain of fabricated observations. This is demonstrable in about
   twelve lines, and pretending otherwise would be the single easiest claim in this
   project to disprove.
3. **That the agent obeyed the verdict.** KURA has no execution path. Whether a
   downstream system honours a `VETO_HALT` is outside its control and outside its claims.

### Adversary model

| | |
|---|---|
| **Defends against** | Post-hoc tampering with the audit trail by anyone without the engine. Silent upstream degradation — stale, incomplete or simulated data passing unnoticed. An operator's own faulty recollection of what the agent saw. |
| **Does not defend against** | A malicious operator at configuration time. A compromised or impersonated RYO endpoint. A compromised host. |

### What would close the gap

Response signing by RYO, or anchoring block hashes to an external timestamping
authority. Both require cooperation KURA cannot provide unilaterally, so neither is
claimed here.

---

---

## Connect an agent

KURA exposes its own MCP endpoint at `POST /mcp` (Streamable HTTP). Register it in
Claude Desktop, Cursor, or any MCP client:

```json
{
  "mcpServers": {
    "kura": { "url": "http://localhost:4000/mcp" }
  }
}
```

| Tool | What it does |
|------|--------------|
| `evaluate_candidate` | Runs the four invariants, commits the verdict, returns APPROVED + bounded size or VETOED + the failing gate, with a receipt id and block hash. |
| `gate_policy` | The thresholds and sizing parameters in force, so the agent knows the rules before it asks. |
| `verify_receipt` | Recomputes the hashes for a past decision and re-checks its parent link. |
| `get_receipt` | The full record, including the canonical raw wire payload the hash covers. |
| `chain_status` | Chain height and integrity from genesis. |

A VETO is final. There is no override parameter, no confidence score to argue with, and
no fallback estimate — the tool returns `sizing: null` and the agent has nothing to act
on. [`test/gateway.test.ts`](apps/engine/test/gateway.test.ts) proves this with a real
MCP client over real HTTP, including that a dropped upstream oracle still vetoes.

---

## API

| Method | Path | Purpose |
|--------|------|---------|
| `GET`  | `/api/stream` | SSE: tool pulses, connection state, verdicts, committed blocks, chaos state, faults. Replays a recent ring buffer on connect. |
| `GET`  | `/api/ledger` | Chronological flight ledger (`?limit`, `?offset`). |
| `GET`  | `/api/ledger/:receiptId` | One record. |
| `POST` | `/api/verify` | `{ receipt_id }` → re-hash and check parent linkage. `200` valid, `409` broken. |
| `GET`  | `/api/verify/chain` | Walk the chain from genesis. |
| `POST` | `/api/chaos/toggle` | `{ tool, action: 'DROP' \| 'DELAY' \| 'RESET', delayMs? }`. `tool` may be `*`. |
| `GET`  | `/api/chaos` | Current injection state. |
| `POST` | `/api/evaluate` | `{ symbol, address? }` → run one decision cycle now. |
| `GET`  | `/api/health` | Connection, transport, ledger path, journal mode, thresholds. |
| `GET`  | `/api/tools` | The 7 tool names, the watchlist, active chaos. |

`DROP` severs the live transport for real and the supervisor reconnects with
exponential backoff. `DELAY` injects artificial sleep, producing a genuine upstream
timeout once the ceiling is crossed.

---

---

## Data contract

RYO publishes **six** tools — `market_overview`, `scan_market`, `analyze_token`,
`deep_analysis`, `compare_tokens`, `monitor_market_sentiment_shift` — and the
unauthenticated `GET /api/mcp/health` confirms `"tools": 6`. There is no `check_safety`
and no `supported_tokens`; the guide states the surface publishes no symbol-only safety
tool, and `analyze_token` explicitly makes no safety claim. Token analysis takes
**symbols, not wallet addresses**, and `compare_tokens` takes one comma-separated
string rather than an array.

Every successful call returns the same envelope, validated in
[`apps/engine/src/schema/tools.ts`](apps/engine/src/schema/tools.ts):

```
schema_version · tool · status · data_mode · as_of · request · data · summary · availability · warnings
```

Three rules:

- **No `.default()`, no `.catch()`, no coercion.** The guide is explicit — *"Never
  convert an unavailable or null measurement to zero."* A null ATR is a veto, not a 0.
- **The envelope is validated strictly; `data` passes through.** The envelope is the
  guaranteed public contract; each tool's inner `data` shape belongs to the live catalog.
- **Unknown extra keys pass through**, so an additive upstream change does not take the
  engine down.

A violation raises `SCHEMA_MISMATCH_OR_MISSING_FIELD` carrying the field path, the
expected type and the received type. The arbiter is then handed `envelope: null` plus
the structured fault and vetoes — it is *told* the evidence is unavailable rather than
left to infer it from a zero.

`GET /api/mcp/tools` is the authoritative catalog; the guide names it the final source
of truth if the written contract and the deployed server ever differ. `GET /api/catalog`
on the engine surfaces it next to the tool list KURA expects.

---

---

## Upstream failure handling

The guide names 429 as the failure builders should expect, with `Retry-After`,
`X-RateLimit-*` headers, and "exponential backoff with jitter for 429, 503, and
temporary network errors" — while forbidding retries of invalid arguments or unknown
tools. [`apps/engine/src/mcp/retry.ts`](apps/engine/src/mcp/retry.ts) wraps every HTTP
request the SDK makes:

- **429 and 503 are retried.** `Retry-After` is honoured in both its forms —
  delta-seconds and HTTP-date — and capped at `RYO_RETRY_MAX_DELAY_MS`.
- **Everything else comes straight back.** A 400 is a bug in the request; a 401 is a
  credential problem that waiting cannot fix. Neither is retried.
- **Full jitter, not equal jitter.** The wait is uniform in `[0, min(cap, base·2^n)]`.
  Equal jitter still leaves every client's retries clustered after a shared outage;
  full jitter spreads them across the whole window, which is the property that actually
  prevents a thundering herd on recovery.
- **Every backoff is reported** — attempt, delay, reason, status, whether the wait came
  from the server or from our own curve, and the quota headers — onto the telemetry bus
  and into the dashboard. A retry is never an untracked failure.

[`test/retry.test.ts`](apps/engine/test/retry.test.ts) drives all of this against a real
local HTTP server that really returns 429 with a real `Retry-After`, not a stubbed fetch.

---

## Schema drift

RYO's envelope is guaranteed; the inner `data` shape belongs to the live catalog. If a
measurement moves, the naive outcome is silent total failure — `EVIDENCE` fails on every
token, no error anywhere, and a green test suite.

So the engine probes at boot, costing one tool call, and reports the paths it resolved:

```
[kura] evidence paths OK — resolved price at data.market.price_usd, ATR(14) at data.technicals.atr_14
```

and when they move:

```
[kura] SCHEMA RESOLUTION WARNING: Expected measurement paths not resolved; falling back to strict veto mode
[kura] could not resolve price and ATR(14) in data — searched price_usd, price, current_price, ...
```

The warning also lands on `/api/health` and as a banner on the dashboard. Set
`EVIDENCE_PROBE=0` to skip it.

---

## Position sizing detail

**A heuristic volatility-adjusted sizing cap, not a theoretical Kelly proof.** Worth
stating plainly, because the shape of the formula invites more credit than it deserves:
real Kelly needs an estimated edge, and KURA has none. It has *"the evidence was
complete and the asset was not too volatile"*, which is a statement about data quality,
not expected return. The weights were chosen for sane behaviour, not fitted to a
backtest. The dashboard leads with allocation as a percentage of the hard risk cap
rather than a dollar figure, because the dollar figure implies a precision that is not
there.

What it *is*: deterministic, monotonic and auditable — no model call, no randomness, and
the same inputs always produce the same allocation. Confidence is a fixed weighting of
two observable quantities:

```
volatilityScore   = 1 − atrPct / KELLY_MAX_ATR_PCT     (ATR(14) / price)
completenessScore = healthy availability sections / declared sections
confidence = 0.60·volatilityScore + 0.40·completenessScore
pBreakEven = 1 / (1 + b)
p          = pBreakEven + (P_MAX − pBreakEven) · confidence
fullKelly  = (p·b − (1−p)) / b
fraction   = min(KELLY_FRACTION · fullKelly, KELLY_MAX_POSITION_PCT), floored at 0
```

Both inputs are measurements RYO actually returns. A more volatile asset earns a smaller
allocation; thinner evidence earns a smaller allocation. An undeclarable availability map
contributes **zero** confidence rather than full confidence — an unmeasured section never
argues for a bigger bet.

At or above `KELLY_HYPER_VOL_ATR_PCT` (default 50% ATR/price) the model **refuses
outright**. The volatility score already floors at zero at `KELLY_MAX_ATR_PCT`, so
without an explicit cutoff an asset with an ATR of 500% of its own price would size
identically to one at 15% — the model going blind exactly where the risk is most
extreme. An asset whose daily true range approaches its own price is not a position.

`p` is anchored at the break-even probability, so zero confidence yields exactly zero
size rather than some residual floor. The `MAX_POSITION_PCT` clamp is a hard risk limit
and reports itself in `clampedBy`, so a saturated size is never mistaken for a computed
one. All parameters are in `.env`.

---

---

## Tests

```bash
npm test                # 103 tests
npm run typecheck
```

| File | Covers |
|------|--------|
| `test/hash.test.ts` | Canonical JSON ordering, stability, refusal to hash non-finite numbers. |
| `test/schema.test.ts` | The six-tool surface, envelope validation, `as_of` age, availability scoring, signal extraction, no-defaults guarantee. |
| `test/arbiter.test.ts` | Every gate at its exact boundary, short-circuiting, the sub-millisecond budget, Kelly behaviour. |
| `test/ledger.test.ts` | WAL mode, genesis linkage, chaining, tamper localisation, verify latency. |
| `test/provenance.test.ts` | The Python verifier reproducing TypeScript hashes across every number-formatting branch. |
| `test/e2e.test.ts` | Real MCP peer over real stdio: drop a tool → veto → SQLite commit → SSE delivery → cryptographic verification → recovery. |

---

---

## The conformance peer

[`apps/engine/src/conformance/server.ts`](apps/engine/src/conformance/server.ts) is a
real MCP server — real SDK, real JSON-RPC, real stdio, real child process — exposing
the same six tools and the same public envelope as production, with profiles chosen to
drive every distinct outcome: `SOL` and `AVAX` approve at different sizes, `STALE` fails
freshness, `PARTL` returns `status: "partial"`, `SIMUL` returns `data_mode: "simulated"`,
`NOEVD` has a null ATR(14), and `BADEV` deliberately omits `data_mode`.

It exists so the engine can be exercised reproducibly before a live endpoint is wired
in, and so the resilience benchmark has a stable baseline. **The engine never reads it
as a fallback**: it is selected only by explicit `.env` configuration, and if the
configured peer is unreachable the engine fails loudly instead.

---

---

## Deploying

KURA is **one process, not a serverless function**. The engine holds a WAL SQLite hash
chain on disk, a long-lived stdio child process for the MCP peer, and in-memory chaos
state — none of which survive a serverless function boundary, and a ledger on an
ephemeral per-instance filesystem would silently restart from genesis. So it wants a
host that runs containers with a persistent volume.

```bash
flyctl auth login
flyctl launch --copy-config --now      # uses the committed fly.toml + Dockerfile
```

The volume mounted at `/data` is what keeps the chain intact across redeploys. The
deploy runs against the local conformance peer with no credential; to point it at
production:

```bash
flyctl secrets set RYO_MCP_KEY=... RYO_MCP_TRANSPORT=http
```

Vercel can host `apps/web` on its own, but the console would have no engine to talk to —
it would render with `Upstream down` and no evaluations. Deploy the container instead.
