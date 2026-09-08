# RYO-CHAN Hackathon — Project Submission

Content for `RYOCHAN-Hackthon-Project-Submission-Form.pdf`. This file is the source of
truth; the PDF is generated from it.

> Every field is filled and verified against the repository. The generated PDF is
> `KURA-RYOCHAN-Submission-Form.pdf`.

---

## Team

| Total Members | 1 |
|---|---|

| Member Name | Role | Email |
|---|---|---|
| Lydia Solomon | Solo Builder / System Architect & Product Designer | lydiasolomon137@gmail.com |

---

## Overview

**Project**

KURA — a deterministic pre-trade gate and tamper-evident decision ledger for agents
built on RYO-CHAN.

**Track**

Track 01: Autonomous Agents

**Problem**

An autonomous trading agent is only as trustworthy as its behaviour when the data goes
wrong. When an upstream research call is slow, incomplete, or simulated, an
LLM-driven agent does the worst possible thing: it reasons around the gap. It retries
with a softer prompt, fills the hole with a plausible number, and produces a confident
recommendation with no record of what it actually saw. Nothing about that is
reproducible, and nothing about it is auditable after the fact.

RYO-CHAN publishes exactly the signals needed to catch this — `status`, `data_mode`,
`as_of`, `availability` — and explicitly warns builders never to convert an unavailable
measurement to zero. Most agents ignore those fields entirely.

**Solution**

KURA is an MCP gateway. It speaks MCP *client* upstream to RYO-CHAN and MCP *server*
downstream to your agent, so the agent registers KURA instead of the research tools and
cannot route around the gate.

Every candidate passes four synchronous TypeScript invariants with **zero LLM calls**.
Approved candidates get a bounded illustrative risk allocation, expressed as a
percentage of a hard cap; anything else is halted with the exact failing gate and the
empirical value that tripped it. Either way
the decision is committed to a SHA-256 hash chain in WAL SQLite, and a standalone
Python CLI recomputes that chain from raw disk state to prove nothing was altered.

The gate is deliberately not clever. It is a circuit breaker that terminates a hostile
condition in tens of microseconds, because algorithmic rule evaluation is auditable and
probabilistic guessing is not.

**Key Features**

1. **Zero-fallback invariant arbiter.** Four gates, evaluated in order, short-circuiting
   on first failure. Fully synchronous — no promises, no I/O, no model call — so it
   cannot hang on a degraded upstream. Measured at 270–300 µs cold, ~30 µs warm.
   - `FRESHNESS` — `latencyMs <= 1200 && asOfAgeMs <= 300_000`
   - `ORACLE` — `status === 'ok'`; `partial` and `unavailable` are refusals
   - `PROVENANCE` — `data_mode === 'live'`; refuses to size on simulated measurement
   - `EVIDENCE` — price and ATR(14) both measurable; a null ATR is a veto, never a 0
2. **Cryptographic flight recorder.** `H_n = SHA256(H_{n-1} : H_payload : timestamp :
   decision)`, genesis linked from 64 zeros, committed to WAL SQLite inside a single
   IMMEDIATE transaction so no two blocks can claim the same parent. Scope stated
   explicitly under Threat Model — it proves the trail is untampered, not that the data
   is true.
3. **Independent provenance verifier.** `skills/verify_provenance/tool.py` — standard
   library only, shares no code with the engine, recomputes every hash from stored raw
   payloads at ~0.06 ms/block. Required porting the ECMAScript `Number::toString`
   algorithm to Python, because `JSON.stringify(0.0000221)` is `"0.0000221"` while
   Python's `repr` gives `'2.21e-05'` — hashing the Python form would raise a false
   tamper alarm on every small number.
4. **Adversarial chaos console.** Drop a tool's connection, inject latency, or force a
   malformed envelope from the browser and watch the breaker trip live.
5. **MCP gateway, both transports.** `POST /mcp` over Streamable HTTP for URL-configured
   clients, and `npx kura gateway` over stdio for command-configured ones.
6. **Live telemetry dashboard.** Server-Sent Events push tool latency, invariant state,
   and committed ledger rows into a Next.js terminal with a per-receipt audit drawer.
7. **Rate-limit aware transport.** 429 and 503 retried with `Retry-After` honoured in
   both delta-seconds and HTTP-date form, falling back to exponential backoff with
   **full** jitter; 400 and 401 never retried, per the guide. Every backoff is reported
   with attempt, delay, reason, status and quota headers — a retry is never an untracked
   failure. Tested against a real local HTTP server that really returns 429.
8. **Boot-time schema resolution probe.** Reports which measurement paths resolved, and
   raises `SCHEMA RESOLUTION WARNING: ... falling back to strict veto mode` when RYO's
   `data` shape moves — instead of silently vetoing every token with a green test suite.
9. **Empirical resilience benchmark.** 150 real trials across three fault classes, not
   marketing copy.

**Target Users**

Developers building autonomous or semi-autonomous trading agents on RYO-CHAN who need a
pre-execution safety layer, and anyone who must later prove what their agent saw and
decided — reviewers, auditors, or the builder's own post-mortem.

**Scope**

Research, evaluation, sizing recommendation, and cryptographic record-keeping.

*Threat model — what KURA proves and does not prove.* KURA is agent black-box auditing
and deterministic circuit breaking, not a decentralised oracle. It proves what the agent
observed, when it observed it, that the invariants were evaluated before any downstream
handoff, and that the trail was not altered afterwards. It does **not** prove that RYO's
data is correct, that the recorded payload came from RYO (there is no response signature,
so an operator who controls configuration could point the engine at a different MCP peer
and mint a valid chain of fabricated observations), or that a downstream system obeyed
the verdict. It defends against post-hoc tampering by anyone without the engine, silent
upstream degradation, and faulty recollection. It does not defend against a malicious
operator at configuration time, a compromised RYO endpoint, or a compromised host.
Closing that gap needs response signing by RYO or external timestamp anchoring — neither
is claimed here. Full section in README.md.

Read-only by construction. RYO's surface cannot create or access a wallet, read
balances or positions, or place, approve or execute a trade — and KURA adds no
execution path of its own. There is no order-placement code, no signing key, and no
wallet anywhere in the repository. Position sizes are research output, not instructions.

**Limitations**

- **No live-endpoint run yet.** Built and verified against the documented contract and
  the local conformance peer. The `RYO_MCP_KEY` had not arrived at submission time, so
  the exact field names inside each tool's `data` block are unconfirmed. The signal
  extractor searches documented measurement names (`atr_14`, `price_usd`, and common
  variants) and **vetoes on `EVIDENCE` if it cannot find them** rather than guessing.
  A boot-time probe reports which paths resolved and raises `SCHEMA RESOLUTION WARNING`
  when they move, so drift surfaces as a loud startup error rather than as silent
  universal refusal. `GET /api/catalog` surfaces the authenticated catalog for pinning
  exact paths.
- **Sizing is a heuristic cap, not a Kelly proof.** Real Kelly needs an estimated edge;
  KURA has none — it has "the evidence was complete and the asset was not too volatile",
  a statement about data quality, not expected return. The weights were chosen for sane
  behaviour, not fitted to a backtest. The dashboard therefore leads with allocation as a
  percentage of the hard risk cap rather than a dollar figure. It is deterministic,
  monotonic and auditable; it is not a claim about future returns. At or above 50%
  ATR/price it refuses to size at all rather than extrapolating past its own range.
- **Single-process ledger.** WAL SQLite on one node. Correct and crash-safe for one
  engine; a multi-writer deployment would need a different design.
- **Not financial advice**, and research output is not a guarantee of safety.

---

## Tech Stack

| Field | Value |
|---|---|
| **Frontend Stack** | Next.js 14.2.18 (App Router), React 18.3, TypeScript 5.7, Tailwind CSS 3.4, Geist Sans + JetBrains Mono, native `EventSource` for SSE |
| **Backend Stack** | Node.js 24 LTS, TypeScript 5.7, Fastify 5.2, `@modelcontextprotocol/sdk` 1.12 (client *and* server), Zod 3.23 runtime validation, better-sqlite3 12.2 in WAL mode, Vitest 2.1 |
| **AI Model(s)** | **None in the decision path — deliberately.** KURA calls no language model at any point during evaluation, sizing, or verification. The arbiter is synchronous TypeScript. This is the core architectural claim and the test suite asserts it structurally: the gate is a non-async function, and 1,000 hostile-condition vetoes must average under 1 ms. Claude Code was used as a development tool to write the implementation. |
| **Other Technologies** | Python 3 standard library (`hashlib`, `sqlite3`, `decimal`) for the independent provenance verifier; SHA-256 hash chaining; Server-Sent Events; npm workspaces |

---

## Repository / Demo

| Field | Value |
|---|---|
| **Github Repository** | https://github.com/RYO-Digital/ryochan-hackathon_repository-249 (mirror: https://github.com/Lideeyah/kura) |
| **Demo Video** | https://youtu.be/1MMqfDH9mUA — mirror: https://github.com/Lideeyah/kura/raw/main/kura-demo-walkthrough.mp4 |
| **Documentation** | `README.md` in the repository root — architecture, the four invariants, hash-chain construction, gateway tool reference, API surface, and the resilience benchmark |

---

## Testing Information

**How to run the Project**

```bash
git clone <repo-url> && cd KURA
npm install
cp .env.example .env
npx kura start          # engine + MCP gateway on :4000
npm run dev:web         # dashboard on :3000
```

Runs end to end with **no credentials**. `.env.example` defaults to the local
conformance peer — a real MCP server over real stdio publishing the same six tools and
the same public envelope as production. To run against live RYO-CHAN, put your key in
`RYO_MCP_KEY` and set `RYO_MCP_TRANSPORT=http`.

The fastest way to see the whole thesis is one command:

```bash
npm run demo
```

Approves a clean token with a sized position, refuses simulated data, drops the upstream
tool and shows the breaker trip in microseconds, trips the latency ceiling, recovers,
verifies the chain, then forges a row on disk and detects it.

**Prerequisites**

- Node.js 20+ (developed and verified on 24.13.0)
- Python 3.8+ for the provenance verifier (verified on 3.14.7) — standard library only,
  no pip install needed
- npm 9+ (workspaces)
- No database to provision: SQLite file is created on first run
- No API key required for the conformance path

**Installation Steps**

```bash
git clone <repo-url>
cd KURA
npm install          # installs both workspaces
cp .env.example .env # runs against the conformance peer as-is
```

**Environment Variables**

All documented in `.env.example`, which ships with an empty credential.

| Variable | Purpose | Default |
|---|---|---|
| `RYO_MCP_URL` | RYO-CHAN builder endpoint | `https://app-ryochan.com/api/mcp` |
| `RYO_MCP_KEY` | Builder credential, sent as `Authorization: Bearer` | *(empty — you supply)* |
| `RYO_RETRY_MAX_ATTEMPTS` | Attempts per request for 429/503/network errors | `4` |
| `RYO_RETRY_BASE_DELAY_MS` | Full-jitter backoff base | `500` |
| `KELLY_HYPER_VOL_ATR_PCT` | ATR/price at or above which sizing is refused | `0.5` |
| `EVIDENCE_PROBE` | Boot-time measurement-path probe (1 tool call) | `1` |
| `RYO_MCP_TRANSPORT` | `http` for live RYO-CHAN, `stdio` for the conformance peer | `stdio` |
| `ENGINE_PORT` | Engine HTTP + SSE + MCP gateway port | `4000` |
| `LEDGER_PATH` | SQLite flight recorder path | `./kura_flight_recorder.db` |
| `INV_MAX_LATENCY_MS` | Round-trip ceiling | `1200` |
| `INV_MAX_AS_OF_AGE_MS` | Maximum observation staleness | `300000` |
| `KELLY_BANKROLL_USD` | Notional bankroll for sizing | `100000` |
| `KELLY_FRACTION` | Fractional Kelly multiplier | `0.25` |
| `KELLY_MAX_POSITION_PCT` | Hard per-position risk cap | `0.05` |
| `KELLY_MAX_ATR_PCT` | ATR/price at which volatility score hits zero | `0.15` |
| `PULSE_SWEEP_TOOLS` | `1` fans the heartbeat across all six metered tools | `0` |
| `KURA_WATCHLIST` | Candidate symbols (no `supported_tokens` tool exists) | `SOL,BTC,ETH,AVAX,BNB` |

`.env` is gitignored. No credential is committed.

**Build Command**

```bash
npm run build        # production Next.js build
npm run typecheck    # tsc --noEmit across both workspaces
```

Stop the dev server before building — `next dev` and `next build` share `apps/web/.next`.

**Run Command**

```bash
npx kura start       # engine: REST + SSE + MCP gateway on :4000
npm run dev:web      # dashboard on :3000
npx kura gateway     # MCP gateway over stdio, for command-configured MCP clients
npx kura verify      # walk and verify the entire ledger hash chain
```

**Test Command**

```bash
npm test                                              # 103 tests, 8 files
npm run test:resilience                               # 50 real trials per fault class
python3 skills/verify_provenance/tool.py --all        # independent chain verification
python3 skills/verify_provenance/tool.py --all --quiet # summary and failures only
```

Coverage:

| File | Covers |
|---|---|
| `test/hash.test.ts` | Canonical JSON ordering, stability, refusal to hash non-finite numbers |
| `test/schema.test.ts` | The six-tool surface, envelope validation, `as_of` age, availability scoring, signal extraction, no-defaults guarantee |
| `test/arbiter.test.ts` | Every gate at its exact boundary, short-circuiting, the sub-millisecond budget, Kelly behaviour |
| `test/ledger.test.ts` | WAL mode, genesis linkage, chaining, tamper localisation, verify latency |
| `test/provenance.test.ts` | The Python verifier reproducing TypeScript hashes across every number-formatting branch |
| `test/e2e.test.ts` | Real MCP peer over real stdio: drop a tool → veto → SQLite commit → SSE delivery → cryptographic verification → recovery |
| `test/gateway.test.ts` | A real MCP client over real HTTP proving an external agent cannot route around the gate |
| `test/retry.test.ts` | 429 with a real `Retry-After`, 503 → full jitter, give-up behaviour, and the codes that must not be retried — against a real local HTTP server |

Resilience benchmark, 50 real trials per fault class, 100% detection and recovery:

| Fault | Median | p95 |
|---|---|---|
| Latency spike | 1.69 ms | 2.9 ms |
| Malformed payload | 0.47 ms | 0.93 ms |
| Peer crash (real process respawn) | 519.42 ms | 595.21 ms |

**Test Account(s)**

None required. KURA has no user accounts, no login, and no wallet — it is a local
daemon plus a dashboard. The only credential is the RYO-CHAN builder key, and the
default configuration runs the entire system without one.

Conformance profiles, each driving a distinct arbiter outcome, usable as test inputs:

| Symbol | Result |
|---|---|
| `SOL` | APPROVED — clean, low ATR, larger size |
| `AVAX` | APPROVED — higher ATR and partial intelligence, smaller size |
| `STALE` | VETOED on `FRESHNESS` — observation an hour old |
| `PARTL` | VETOED on `ORACLE` — `status: "partial"` |
| `SIMUL` | VETOED on `PROVENANCE` — `data_mode: "simulated"` |
| `NOEVD` | VETOED on `EVIDENCE` — ATR(14) is null |
| `BADEV` | `SCHEMA_MISMATCH_OR_MISSING_FIELD` — envelope missing `data_mode` |
