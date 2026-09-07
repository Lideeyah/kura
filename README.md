# KURA — Flight Recorder

A deterministic execution gate and tamper-evident decision ledger for the RYO-CHAN MCP
toolset.

KURA is an MCP **gateway**: it speaks MCP *client* upstream to RYO-CHAN and MCP
*server* downstream to your agent. Your agent registers KURA instead of the market
tools, so the gate sits between intent and execution and cannot be routed around. Every candidate
trade passes four synchronous invariants; the ones that survive get a fractional Kelly
position size, the ones that don't get an explicit, auditable veto. Either way the
decision is committed to a SHA-256 hash chain in SQLite, and anyone can recompute that
chain from the raw wire payloads with a script that shares no code with the engine.

**Status: the engine, the API, the ledger and the dashboard work end-to-end over real
transport, and the terminal now carries its full visual identity.**

---

## The thesis, in three claims

### 1. The gate is algorithmic, not probabilistic

When `check_safety` drops or latency crosses 1,200 ms, KURA does not ask a language
model what to do. It does not retry with a softer prompt, fall back to a cached answer,
or substitute a default. A synchronous TypeScript function reads the empirical values,
fails the first invariant that breaks, and returns.

```
   probabilistic agent                    KURA's arbiter
   ───────────────────                    ──────────────
   tool fails                             tool fails
   → prompt the model with the error      → the arbiter receives safety: null
   → model reasons about it               → ORACLE gate fails on a boolean check
   → model may retry, may guess,          → downstream gates are NOT_EVALUATED
     may hallucinate a safe-looking       → VETOED, with the empirical value recorded
     rationale
   → 800–3000 ms, non-reproducible        → 20–300 µs, byte-identical every run
```

`evaluate()` in [`apps/engine/src/arbiter/invariants.ts`](apps/engine/src/arbiter/invariants.ts)
is not `async`. It has no `await` in it, imports no client, and touches no network. It
*cannot* hang on a degraded upstream, because there is nothing in it to hang on. The
test suite asserts this structurally, not rhetorically: 1,000 hostile-condition vetoes
must average under 1 ms, and the returned value must not be a promise.

The four gates, evaluated in order and short-circuiting on the first failure:

| # | Invariant | Predicate |
|---|-----------|-----------|
| 1 | `LATENCY`   | `latencyMs <= 1200` |
| 2 | `ORACLE`    | `safety !== null && !safety.error` |
| 3 | `HONEYPOT`  | `safety.is_honeypot === false` |
| 4 | `LIQUIDITY` | `market.liquidity_usd >= 1_000_000` |

Every gate reports the value it actually saw, so a veto is fully reconstructable from
the ledger alone months later.

### 2. Decisions are cryptographically chained, not logged

Each committed decision is a block:

```
payloadHash = SHA256( canonicalJson(rawWirePayload) )
blockHash   = SHA256( prevBlockHash : payloadHash : timestamp : decision )
```

Genesis links from 64 zeros. Altering any historical row — a liquidity figure, a
timestamp, a decision — changes that block's hash and severs its link to its successor.
The break is localised: the verifier names the exact sequence number and which of
`PAYLOAD_HASH_MISMATCH` / `BLOCK_HASH_MISMATCH` / `PARENT_LINK_BROKEN` fired.

SQLite runs in WAL mode with `synchronous = FULL`. The head read and the insert share
one `IMMEDIATE` transaction, so two blocks can never claim the same parent.

### 3. Verification is executable by a third party

`skills/verify_provenance/tool.py` is standard-library Python. It opens the database
read-only and recomputes every hash from the stored raw payloads. It shares no code
with the TypeScript that wrote them, so agreement is evidence rather than tautology.

```bash
python3 skills/verify_provenance/tool.py --all
python3 skills/verify_provenance/tool.py --receipt <RECEIPT_ID>
python3 skills/verify_provenance/tool.py --all --json    # machine-readable
```

Exit code 0 means the chain is intact; 1 means a break was found and named.

> Getting this right required porting the ECMAScript `Number::toString` algorithm to
> Python. `JSON.stringify(0.0000221)` is `"0.0000221"` but Python's `repr` gives
> `'2.21e-05'` — hashing the Python form would have raised a false tamper alarm on any
> small number. The test suite pins this with fixtures that straddle every branch of
> the algorithm.

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

## Run it

```bash
npm install
cp .env.example .env
npx kura start          # engine: REST + SSE + MCP gateway on :4000
```

`npx kura verify` walks the whole ledger chain. `npx kura --help` lists both.

### Against the live RYO-CHAN endpoint

Set these in `.env`:

```
RYO_MCP_TRANSPORT=http
RYO_MCP_URL=https://your-ryo-chan-endpoint/mcp
RYO_MCP_TOKEN=your-token
```

The HTTP transport tries Streamable HTTP first and falls back to SSE. `RYO_MCP_TOKEN`
is sent as `Authorization: Bearer …`. There is **no offline mode**: if the peer is
unreachable the engine says so and retries with backoff — it never fabricates a payload.

For a local stdio peer instead:

```
RYO_MCP_TRANSPORT=stdio
RYO_MCP_COMMAND=npx
RYO_MCP_ARGS=tsx apps/engine/src/conformance/server.ts
```

### One command that proves the whole thesis

```bash
npm run demo
```

Approves a clean token with a sized position, vetoes a thin pool, drops `check_safety`
and watches the breaker trip in microseconds, trips the latency ceiling, recovers,
verifies the chain, then forges a row on disk and detects it. Every line is executed.

### The dashboard

```bash
npm run dev
```

Engine on `:4000`, dashboard on `:3000` (Next proxies `/api/*` through, so SSE is
same-origin).

The terminal is a three-tier grid on a 1440px canvas:

- **Tool ribbon** — 7 micro-cards with live latency. Emerald under 400 ms, amber to the
  1,200 ms ceiling, rose on any drop, timeout or schema break. A chaos-targeted tool
  flips to rose on its next pulse, which is the fastest visible proof the injector
  reached the transport rather than the UI.
- **Invariant decision gate (60%)** — verdict, sizing, and the four gates in evaluation
  order. Gates the breaker skipped render dimmed as `SHORT-CIRCUITED`, so it is visible
  that missing data never ran fallback logic. Below them, a fault tape of the structured
  errors the interceptor raised.
- **Adversarial chaos injector (40%)** — drop, delay and malformed-payload triggers, plus
  benchmark diagnostics. Those figures are read live from the stream and imported from
  `bench-resilience.json`; none are transcribed into the component.
- **Flight recorder** — the streaming ledger. `inspect` opens a fixed right drawer at
  `z-50` showing the SHA-256 parent linkage, the canonical raw payload the hash covers,
  a live recompute, and the exact `verify_provenance` command for that receipt. Because
  the drawer is fixed rather than in flow, opening it causes zero layout shift.

Design tokens live in [`apps/web/tailwind.config.ts`](apps/web/tailwind.config.ts).
Three accents carry meaning and nothing else — emerald healthy, amber degraded, rose
halted — and a short-circuited gate is deliberately colourless, because it made no claim
either way. Geist Sans (self-hosted via Vercel's `geist` package) sets the interface;
JetBrains Mono with `tabular-nums` sets every latency, timestamp, sequence and hash, so
columns do not jitter as the stream updates.

---

## Empirical resilience

150 real trials against a live MCP peer over stdio — not a claim, a measurement:

```
fault              trials  detected  recovered  median     p95        min        max
-----------------  ------  --------  ---------  ---------  ---------  ---------  ---------
latency_spike      50      100%      100%       1.61 ms    2.4 ms     0.68 ms    3.13 ms
malformed_payload  50      100%      100%       0.65 ms    1.68 ms    0.38 ms    5.62 ms
peer_crash         50      100%      100%       519.76 ms  543.03 ms  503.07 ms  702.19 ms

ledger chain after 300 blocks: INTACT
```

Recovery is measured as wall-clock time from the fault clearing to the engine
committing a healthy `APPROVED` block again. The `peer_crash` figure includes
respawning the MCP child process. Reproduce with:

```bash
npm run test:resilience          # 50 trials per class, writes bench-resilience.json
TRIALS=10 npm run test:resilience
```

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

## Data contract

The 7 tools are described by zod schemas in
[`apps/engine/src/schema/tools.ts`](apps/engine/src/schema/tools.ts) with three rules:

- **No `.default()`, no `.catch()`, no coercion.** A missing `liquidity_usd` is a hard
  failure, never a silently substituted zero.
- **`error` must be present** as a string or an explicit `null`. An absent key is a
  violation, because "absent" and "no error" are not the same claim.
- **Unknown extra keys pass through**, so an additive upstream change does not take the
  engine down.

A violation raises `SCHEMA_MISMATCH_OR_MISSING_FIELD` carrying the field path, the
expected type and the received type. The arbiter then sees `safety: null` plus the
structured fault and vetoes on `ORACLE` — it is *told* the oracle is unavailable rather
than left to infer it from a zero.

---

## Position sizing

Approved trades are sized by fractional Kelly, deterministically — no model call, no
randomness. Confidence is a fixed weighting of three observable quantities:

```
confidence = 0.40·safetyScore + 0.35·liquidityScore + 0.25·volumeScore
pBreakEven = 1 / (1 + b)
p          = pBreakEven + (P_MAX − pBreakEven) · confidence
fullKelly  = (p·b − (1−p)) / b
fraction   = min(KELLY_FRACTION · fullKelly, KELLY_MAX_POSITION_PCT), floored at 0
```

`p` is anchored at the break-even probability, so zero confidence yields exactly zero
size rather than some residual floor. The `MAX_POSITION_PCT` clamp is a hard risk limit
and reports itself in `clampedBy`, so a saturated size is never mistaken for a computed
one. All parameters are in `.env`.

---

## Tests

```bash
npm test                # 63 tests
npm run typecheck
```

| File | Covers |
|------|--------|
| `test/hash.test.ts` | Canonical JSON ordering, stability, refusal to hash non-finite numbers. |
| `test/schema.test.ts` | Missing/mistyped invariant fields, envelope unwrapping, no-defaults guarantee. |
| `test/arbiter.test.ts` | Every gate at its exact boundary, short-circuiting, the sub-millisecond budget, Kelly behaviour. |
| `test/ledger.test.ts` | WAL mode, genesis linkage, chaining, tamper localisation, verify latency. |
| `test/provenance.test.ts` | The Python verifier reproducing TypeScript hashes across every number-formatting branch. |
| `test/e2e.test.ts` | Real MCP peer over real stdio: drop a tool → veto → SQLite commit → SSE delivery → cryptographic verification → recovery. |

---

## The conformance peer

[`apps/engine/src/conformance/server.ts`](apps/engine/src/conformance/server.ts) is a
real MCP server — real SDK, real JSON-RPC, real stdio, real child process — exposing
the 7 tools with profiles chosen to drive every distinct outcome: `SOL` and `JUP`
approve at different sizes, `BONK` fails liquidity, `HNYP` is a honeypot, `ORCL`
returns an oracle error, and `BADS` deliberately violates the contract.

It exists so the engine can be exercised reproducibly before a live endpoint is wired
in, and so the resilience benchmark has a stable baseline. **The engine never reads it
as a fallback**: it is selected only by explicit `.env` configuration, and if the
configured peer is unreachable the engine fails loudly instead.

---

## Layout

```
apps/engine/
  src/schema/tools.ts          the 7-tool data contract and runtime validator
  src/mcp/client.ts            live MCP client, HTTP + stdio transports
  src/mcp/interceptor.ts       chaos injection, timing, envelope unwrapping
  src/arbiter/invariants.ts    the synchronous zero-fallback gate
  src/arbiter/kelly.ts         fractional Kelly sizing
  src/ledger/hash.ts           canonical JSON + SHA-256 chaining
  src/ledger/ledger.ts         WAL SQLite flight recorder
  src/bus/telemetry.ts         in-process fan-out for SSE
  src/pipeline.ts              one decision cycle
  src/supervisor.ts            connection, heartbeat, reconnect, evaluation loop
  src/server.ts                Fastify routes
  bench/demo.ts                npm run demo
  bench/resilience.ts          npm run test:resilience
apps/web/app/                  unstyled Next.js 14 dashboard
skills/verify_provenance/      standalone Python verifier
```

---

## Notes on the frontend

The dashboard is a pure consumer of the engine's public API. It holds no business
logic: latency bands, gate labels and signal colours all resolve through
[`apps/web/app/signal.ts`](apps/web/app/signal.ts), and the failing gate shown in the
ledger is read from the arbiter's own `invariants_json` rather than inferred from the
decision. Restyling it cannot change a verdict.
