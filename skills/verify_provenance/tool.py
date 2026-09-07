#!/usr/bin/env python3
"""
verify_provenance — independent cryptographic verification of the KURA flight ledger.

Recomputes every hash from the raw wire payloads stored in kura_flight_recorder.db,
using nothing but the Python standard library. It shares no code with the TypeScript
engine that wrote the ledger; if the two disagree about a single byte, verification
fails. That is the point.

    python3 skills/verify_provenance/tool.py --receipt <RECEIPT_ID>
    python3 skills/verify_provenance/tool.py --all
    python3 skills/verify_provenance/tool.py --all --json

Exit codes:  0 = every checked block verified,  1 = a break was found,  2 = bad usage.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sqlite3
import sys
import time
from decimal import Decimal
from typing import Any

GENESIS_HASH = "0" * 64
DEFAULT_DB = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "kura_flight_recorder.db",
)


# ─── ECMAScript-compatible serialization ──────────────────────────────────────
#
# Python's repr() and JavaScript's Number::toString disagree on where to switch to
# exponential notation: repr(0.0000221) is '2.21e-05' while JSON.stringify(0.0000221)
# is '0.0000221'. Hashing the Python form would produce a false tamper alarm on any
# small number, so the ECMAScript algorithm (ECMA-262 §6.1.6.1.20) is implemented
# directly below.


def js_number(value: float | int) -> str:
    if isinstance(value, bool):
        raise TypeError("bool is not a number")
    if isinstance(value, int) and -(10**21) < value < 10**21:
        return str(value)
    f = float(value)
    if f != f or f in (float("inf"), float("-inf")):
        raise ValueError("cannot serialize non-finite number")
    if f == 0:
        return "0"

    negative = f < 0
    d = Decimal(repr(abs(f)))  # repr() gives the shortest round-trip digits
    digits = list(d.as_tuple().digits)
    exponent = d.as_tuple().exponent
    while len(digits) > 1 and digits[-1] == 0:
        digits.pop()
        exponent += 1

    k = len(digits)
    n = k + exponent  # value == 0.<digits> * 10**n
    s = "".join(str(x) for x in digits)

    if k <= n <= 21:
        out = s + "0" * (n - k)
    elif 0 < n <= 21:
        out = s[:n] + "." + s[n:]
    elif -6 < n <= 0:
        out = "0." + "0" * (-n) + s
    else:
        e = n - 1
        mantissa = s[0] if k == 1 else s[0] + "." + s[1:]
        out = f"{mantissa}e{'+' if e >= 0 else '-'}{abs(e)}"

    return "-" + out if negative else out


def _js_string(value: str) -> str:
    # json.dumps with ensure_ascii=False uses the same escape set as JSON.stringify:
    # \" \\ \b \f \n \r \t and \uXXXX for the remaining control characters.
    return json.dumps(value, ensure_ascii=False)


def canonical_json(value: Any) -> str:
    """Byte-identical to canonicalJson() in apps/engine/src/ledger/hash.ts."""
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, str):
        return _js_string(value)
    if isinstance(value, (int, float)):
        return js_number(value)
    if isinstance(value, list):
        return "[" + ",".join(canonical_json(v) for v in value) + "]"
    if isinstance(value, dict):
        parts = [f"{_js_string(k)}:{canonical_json(value[k])}" for k in sorted(value.keys())]
        return "{" + ",".join(parts) + "}"
    raise TypeError(f"unhashable type in payload: {type(value).__name__}")


def sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def payload_hash(raw_payload: Any) -> str:
    return sha256(canonical_json(raw_payload))


def block_hash(prev: str, payload: str, timestamp: str, decision: str) -> str:
    return sha256(f"{prev}:{payload}:{timestamp}:{decision}")


# ─── Verification ─────────────────────────────────────────────────────────────


def verify_row(row: sqlite3.Row, parent: sqlite3.Row | None) -> dict[str, Any]:
    failures: list[str] = []

    try:
        recomputed_payload = payload_hash(json.loads(row["raw_payload_json"]))
    except Exception as exc:  # noqa: BLE001
        failures.append("RAW_PAYLOAD_UNPARSEABLE")
        recomputed_payload = None
        detail = str(exc)
    else:
        detail = ""
        if recomputed_payload != row["payload_hash"]:
            failures.append("PAYLOAD_HASH_MISMATCH")

    recomputed_block = block_hash(
        row["prev_block_hash"],
        recomputed_payload or row["payload_hash"],
        row["timestamp"],
        row["decision"],
    )
    if recomputed_block != row["block_hash"]:
        failures.append("BLOCK_HASH_MISMATCH")

    is_genesis = row["prev_block_hash"] == GENESIS_HASH
    if is_genesis:
        if row["seq"] != 1 and parent is not None:
            failures.append("PARENT_LINK_BROKEN")
    elif parent is None:
        failures.append("PARENT_MISSING")
    elif parent["block_hash"] != row["prev_block_hash"]:
        failures.append("PARENT_LINK_BROKEN")

    return {
        "seq": row["seq"],
        "receipt_id": row["receipt_id"],
        "token": row["token"],
        "decision": row["decision"],
        "timestamp": row["timestamp"],
        "is_genesis": is_genesis,
        "valid": not failures,
        "failures": failures,
        "stored_payload_hash": row["payload_hash"],
        "recomputed_payload_hash": recomputed_payload,
        "stored_block_hash": row["block_hash"],
        "recomputed_block_hash": recomputed_block,
        "prev_block_hash": row["prev_block_hash"],
        "parent_block_hash": parent["block_hash"] if parent else None,
        "detail": detail,
    }


def open_db(path: str) -> sqlite3.Connection:
    if not os.path.exists(path):
        print(f"error: ledger not found at {path}", file=sys.stderr)
        sys.exit(2)
    # Read-only, so verification can never disturb the ledger it is auditing.
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def fmt(result: dict[str, Any]) -> str:
    mark = "PASS" if result["valid"] else "FAIL"
    line = (
        f"  [{mark}] seq {result['seq']:<4} {result['decision']:<8} "
        f"{result['token']:<6} {result['receipt_id']}"
    )
    if not result["valid"]:
        line += f"\n         failures: {', '.join(result['failures'])}"
        if result["recomputed_payload_hash"] != result["stored_payload_hash"]:
            line += (
                f"\n         stored payload hash     {result['stored_payload_hash']}"
                f"\n         recomputed payload hash {result['recomputed_payload_hash']}"
            )
        if result["recomputed_block_hash"] != result["stored_block_hash"]:
            line += (
                f"\n         stored block hash       {result['stored_block_hash']}"
                f"\n         recomputed block hash   {result['recomputed_block_hash']}"
            )
    return line


def main() -> int:
    parser = argparse.ArgumentParser(
        prog="verify_provenance",
        description="Recompute KURA ledger hashes from raw wire payloads.",
    )
    parser.add_argument("--receipt", help="verify a single receipt id (and its parent link)")
    parser.add_argument("--all", action="store_true", help="walk and verify the entire chain")
    parser.add_argument("--db", default=os.environ.get("LEDGER_PATH", DEFAULT_DB))
    parser.add_argument("--json", action="store_true", dest="as_json", help="machine-readable output")
    args = parser.parse_args()

    if not args.receipt and not args.all:
        parser.error("pass --receipt <ID> or --all")

    conn = open_db(os.path.abspath(args.db))
    started = time.perf_counter()

    if args.receipt:
        row = conn.execute("SELECT * FROM ledger WHERE receipt_id = ?", (args.receipt,)).fetchone()
        if row is None:
            elapsed = (time.perf_counter() - started) * 1000
            payload = {"valid": False, "failures": ["RECEIPT_NOT_FOUND"], "receipt_id": args.receipt}
            if args.as_json:
                print(json.dumps({**payload, "elapsed_ms": round(elapsed, 4)}, indent=2))
            else:
                print(f"RECEIPT_NOT_FOUND: {args.receipt}")
            return 1
        parent = conn.execute("SELECT * FROM ledger WHERE seq = ?", (row["seq"] - 1,)).fetchone()
        results = [verify_row(row, parent)]
    else:
        rows = conn.execute("SELECT * FROM ledger ORDER BY seq ASC").fetchall()
        results = []
        parent = None
        for row in rows:
            results.append(verify_row(row, parent))
            parent = row

    elapsed_ms = (time.perf_counter() - started) * 1000
    ok = all(r["valid"] for r in results)

    if args.as_json:
        print(
            json.dumps(
                {
                    "db": os.path.abspath(args.db),
                    "checked": len(results),
                    "valid": ok,
                    "elapsed_ms": round(elapsed_ms, 4),
                    "per_block_ms": round(elapsed_ms / max(len(results), 1), 4),
                    "results": results,
                },
                indent=2,
            )
        )
        return 0 if ok else 1

    print(f"verify_provenance — {os.path.abspath(args.db)}")
    print(f"blocks checked: {len(results)}")
    for r in results:
        print(fmt(r))
    per = elapsed_ms / max(len(results), 1)
    print(
        f"\n{'CHAIN INTACT' if ok else 'CHAIN BROKEN'} — "
        f"{sum(1 for r in results if r['valid'])}/{len(results)} blocks verified "
        f"in {elapsed_ms:.3f} ms ({per:.4f} ms/block)"
    )
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
