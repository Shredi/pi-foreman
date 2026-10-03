#!/usr/bin/env python3
"""Probe: subprocess latency of calling the Python guard core once per tool call.

Usage: guard_latency.py GUARD_REPO [--out results.json]   (or env GUARD_REPO)
Times separate spawns, each fed a hook-shaped JSON on stdin:
  bare python, scripts/destructive_guard.py (Bash), scripts/ledger_guard_write.py (Write).
Per case: 5 cold-ish runs (the first ones) + 50 warm runs. Stdlib only, Python 3.9+.
"""
import json
import os
import platform
import subprocess
import sys
import tempfile
import time

COLD, WARM = 5, 50


def pct(xs, p):
    s = sorted(xs)
    return s[min(len(s) - 1, int(round(p / 100 * (len(s) - 1))))]


def stats(xs):
    return {"p50": round(pct(xs, 50), 1), "p95": round(pct(xs, 95), 1), "max": round(max(xs), 1)}


def run_once(argv, payload, cwd):
    t = time.perf_counter()
    r = subprocess.run(argv, input=payload, capture_output=True, text=True, cwd=cwd)
    ms = (time.perf_counter() - t) * 1000
    return ms, r.returncode


def main():
    args = sys.argv[1:]
    out = "guard-latency-results.json"
    if "--out" in args:
        i = args.index("--out")
        out = args[i + 1]
        del args[i:i + 2]
    repo = args[0] if args else os.environ.get("GUARD_REPO")
    if not repo:
        sys.exit("usage: guard_latency.py GUARD_REPO [--out FILE]")
    scripts = os.path.join(os.path.abspath(repo), "scripts")
    cwd = tempfile.gettempdir()
    base = {"session_id": "latency-probe", "cwd": cwd}
    bash = json.dumps(dict(base, hook_event_name="PreToolUse", tool_name="Bash",
                           tool_input={"command": "ls"}))
    write = json.dumps(dict(base, hook_event_name="PreToolUse", tool_name="Write",
                            tool_input={"file_path": os.path.join(cwd, "latency-probe-new.txt"),
                                        "content": "x"}))
    py = sys.executable
    cases = [
        ("bare python", [py, "-c", "pass"], bash),
        ("destructive_guard", [py, os.path.join(scripts, "destructive_guard.py")], bash),
        ("ledger_guard_write", [py, os.path.join(scripts, "ledger_guard_write.py")], write),
    ]
    results = {"os": platform.platform(), "python": platform.python_version(), "cases": {}}
    for name, argv, payload in cases:
        times, codes = [], set()
        for _ in range(COLD + WARM):
            ms, rc = run_once(argv, payload, cwd)
            times.append(ms)
            codes.add(rc)
        results["cases"][name] = {"cold": stats(times[:COLD]), "warm": stats(times[COLD:]),
                                  "first_ms": round(times[0], 1), "exit_codes": sorted(codes)}
    lines = ["### Python guard latency: %s, Python %s" % (results["os"], results["python"]), "",
             "| case | cold p50 | cold max | warm p50 | warm p95 | warm max | exit |",
             "|---|---|---|---|---|---|---|"]
    for name, r in results["cases"].items():
        c, w = r["cold"], r["warm"]
        lines.append("| %s | %s | %s | %s | %s | %s | %s |" % (
            name, c["p50"], c["max"], w["p50"], w["p95"], w["max"], r["exit_codes"]))
    table = "\n".join(lines) + "\n"
    print(table)
    with open(out, "w", encoding="utf-8") as f:
        json.dump(results, f, indent=2)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as f:
            f.write(table + "\n")


if __name__ == "__main__":
    main()
