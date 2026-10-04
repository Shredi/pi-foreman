#!/usr/bin/env python3
"""`foreman bench`: run the pi-foreman benchmark matrix through Harbor and tabulate it
(stdlib, 3.9+). The Harbor side lives in bench/harbor_agent.py; this script never imports it.

    python scripts/foreman_bench.py run   --preset bench/presets/smoke.json [--tasks DIR] [--jobs-dir DIR]
                                          [--token-cap N] [--dry-run] [--setup-only]
    python scripts/foreman_bench.py table --preset bench/presets/smoke.json [--jobs-dir DIR] [--json]

Preset (JSON):
    {"bench": {"tasks_dir": "<dir, relative to the preset file>", "repeats": 3, "jobs_dir": "<optional>",
               "tasks": ["<task>", ...], "token_cap": 1000000,
               "first": {"row": "<row id>", "task": "<task>", "tasks_dir": "<optional dir>"}},
     "rows": [{"id": "R2", "agent": "foreman"|"plain", "provider": "...", "model": "provider/model",
               "roles": {"<role>": {"model": "...", "thinking": "..."}}, "thinking": "...",
               "driver": "rpc"|"print", "cap_seconds": 1800}]}
    Preset paths may use ~ and $VARS (e.g. a checkout path for the `first` task dir).

Matrix: rows x tasks (bench.tasks in that order, else every subdir of the task dir with a
task.toml, sorted) x repeats, plus an optional `first` cell that runs before all others.
Order: repeat outermost, then task, then row (r1: task1 R1 R2 RS, task2 R1 R2 RS, ...; r2: ...),
so a stop at any point leaves every row with the same tasks and nearly the same number of
repeats. Each cell is one `harbor run` job named `<row>__<task>__r<n>__<stamp>` in the jobs dir
(default outside the repo: ~/.pi-foreman/bench-jobs). `run` skips cells that already have a
counted result, so a second `run` resumes; infrastructure-error cells are re-run by a later
invocation, never within the same one. A provider usage-limit answer stops the run at once
(exit 3); rerun later to resume. Token cap (--token-cap or bench.token_cap): before each cell
the tokens of every finished attempt of the preset's matrix are summed (resumed runs
included); at or above the cap the run stops cleanly (exit 4). Two consecutive
infrastructure-error cells in one invocation stop the run too (exit 5). The per-cell wall cap
is the row's cap_seconds.

Harbor telemetry is always switched off for every Harbor process (HARBOR_TELEMETRY=off); the
script never passes --upload or --launch. The result table holds counters only.
"""
from __future__ import annotations

import argparse
import json
import os
import statistics
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
AGENT_CLASSES = {"foreman": "bench.harbor_agent:ForemanPi", "plain": "bench.harbor_agent:PlainPi"}
USAGE_LIMIT_EXC = "ApiUsageLimitError"
INFRA_EXC = {USAGE_LIMIT_EXC, "ApiRateLimitError", "ApiOverloadedError", "ApiInternalServerError",
             "ApiConnectionClosedError", "ApiResponseStalledError", "NetworkConnectionError",
             "AgentAuthenticationError", "ModelNotFoundError", "EnvironmentStartTimeoutError"}
EXIT_USAGE_LIMIT = 3
EXIT_TOKEN_CAP = 4
EXIT_INFRA_STREAK = 5
INFRA_STREAK_MAX = 2  # consecutive infrastructure-error cells (e.g. auth failing in every container)
TIERS = ("fable", "opus", "sonnet", "haiku")


def default_jobs_dir():
    return Path.home() / ".pi-foreman" / "bench-jobs"


def load_preset(path):
    path = Path(path).resolve()
    data = json.loads(path.read_text("utf-8"))
    data["_path"] = str(path)
    return data


def _preset_path(preset, raw):
    p = Path(os.path.expandvars(raw)).expanduser()  # $VARS allowed, e.g. a checkout path
    return (p if p.is_absolute() else Path(preset["_path"]).parent / p).resolve()


def tasks_dir(preset, override=None):
    if override:
        return Path(override).resolve()
    raw = (preset.get("bench") or {}).get("tasks_dir")
    if not raw:
        raise SystemExit("no task dir: pass --tasks DIR or set bench.tasks_dir in the preset")
    return _preset_path(preset, raw)


def jobs_dir(preset, override=None):
    raw = override or (preset.get("bench") or {}).get("jobs_dir")
    return Path(raw).expanduser().resolve() if raw else default_jobs_dir()


def list_tasks(tdir):
    return sorted(d.name for d in Path(tdir).iterdir() if (d / "task.toml").is_file())


def cell_id(row_id, task, rep):
    return "%s__%s__r%d" % (row_id, task, rep)


def ordered_tasks(preset, tdir):
    names = (preset.get("bench") or {}).get("tasks")
    if not names:
        return list_tasks(tdir)
    missing = [t for t in names if not (Path(tdir) / t / "task.toml").is_file()]
    if missing:
        raise SystemExit("bench.tasks not found in %s: %s" % (tdir, ", ".join(missing)))
    return list(names)


def first_cell(preset, tdir):
    """(row, task, 1, task path) of the preset's `first` cell, or None."""
    f = (preset.get("bench") or {}).get("first")
    if not f:
        return None
    rows = {r["id"]: r for r in preset.get("rows") or []}
    if f.get("row") not in rows:
        raise SystemExit("bench.first.row %r is not a row of the preset" % f.get("row"))
    fdir = _preset_path(preset, f["tasks_dir"]) if f.get("tasks_dir") else Path(tdir)
    if not (fdir / f["task"] / "task.toml").is_file():
        raise SystemExit("bench.first.task %r not found in %s" % (f.get("task"), fdir))
    return (rows[f["row"]], f["task"], 1, fdir / f["task"])


def cells(preset, tdir, rows=None, task_names=None, repeats=None):
    """[(row, task, repeat, task path)] in run order: the `first` cell, then repeat outermost,
    task, row innermost."""
    reps = int(repeats or (preset.get("bench") or {}).get("repeats") or 1)
    row_list = [r for r in preset.get("rows") or [] if not rows or r["id"] in rows]
    tasks = [t for t in ordered_tasks(preset, tdir) if not task_names or t in task_names]
    out = []
    first = first_cell(preset, tdir)
    if first and (not rows or first[0]["id"] in rows) and (not task_names or first[1] in task_names):
        out.append(first)
    for k in range(1, reps + 1):
        for task in tasks:
            for row in row_list:
                out.append((row, task, k, Path(tdir) / task))
    return out


def row_model(row):
    provider = row.get("provider", "foreman-fake")
    return row.get("model") or "%s/foreman" % provider


def harbor_command(row, task_path, preset_path, jdir, job_name, harbor="harbor"):
    kind = row.get("agent", "foreman")
    if kind not in AGENT_CLASSES:
        raise ValueError("row %s: agent must be one of %s" % (row.get("id"), sorted(AGENT_CLASSES)))
    return [harbor, "run", "-p", str(task_path), "-a", AGENT_CLASSES[kind], "-m", row_model(row),
            "--ak", "preset=%s" % preset_path, "--ak", "row=%s" % row["id"],
            "-o", str(jdir), "--job-name", job_name, "-n", "1", "--max-retries", "0", "-q"]


def harbor_env(base=None):
    env = dict(os.environ if base is None else base)
    env["HARBOR_TELEMETRY"] = "off"  # always; not overridable
    env["PYTHONPATH"] = os.pathsep.join([str(REPO)] + ([env["PYTHONPATH"]] if env.get("PYTHONPATH") else []))
    return env


def _seconds(timing):
    try:
        a = datetime.fromisoformat(timing["started_at"].replace("Z", "+00:00"))
        b = datetime.fromisoformat(timing["finished_at"].replace("Z", "+00:00"))
        return (b - a).total_seconds()
    except (TypeError, KeyError, ValueError, AttributeError):
        return None


def read_trial(job_dir):
    """The trial result.json of a one-trial job dir as a cell record, or None if absent."""
    for f in sorted(Path(job_dir).glob("*/result.json")):
        try:
            r = json.loads(f.read_text("utf-8"))
        except (OSError, ValueError):
            continue
        if "trial_name" not in r:
            continue
        exc = (r.get("exception_info") or {}).get("exception_type")
        bench = ((r.get("agent_result") or {}).get("metadata") or {}).get("bench") or {}
        rewards = (r.get("verifier_result") or {}).get("rewards") or {}
        reward = rewards.get("reward")
        infra = None
        if exc == USAGE_LIMIT_EXC or bench.get("infra_error") == "usage_limit":
            infra = "usage_limit"
        elif exc in INFRA_EXC or bench.get("infra_error"):
            infra = exc or bench.get("infra_error")
        elif reward is None:
            infra = exc or "no_verifier_result"
        counters = bench.get("counters") or {}
        by_tier = {}
        for model, t in (counters.get("tokens_by_model") or {}).items():
            by_tier[tier(model)] = by_tier.get(tier(model), 0) + sum(int(v or 0) for v in t.values())
        return {
            "job": Path(job_dir).name, "reward": reward, "success": reward is not None and float(reward) >= 1.0,
            "infra": infra, "exception": exc,
            "tokens": (counters.get("tokens") or {}).get("total"),
            "tokens_by_tier": by_tier, "tokens_by_role": counters.get("tokens_by_role"),
            "wall_seconds": _seconds(r.get("agent_execution")),
            "tool_calls": counters.get("tool_calls"), "approvals": counters.get("approvals"),
            "guard_blocks": counters.get("guard_blocks"),
            "meta": dict({k: bench.get(k) for k in ("pi_foreman_commit", "pi_foreman_dirty", "versions", "model_main",
                                                   "models_by_role", "thinking", "driver", "status", "setup_check")},
                         thinking_seen=counters.get("thinking_by_role")),
        }
    return None


def tier(model):
    """Model tier from a model id: fable/opus/sonnet/haiku, else the bare model id."""
    low = str(model).lower()
    for t in TIERS:
        if t in low:
            return t
    return low.rsplit("/", 1)[-1]


def cell_results(jdir, cid):
    """All attempts of one cell, oldest first."""
    jdir = Path(jdir)
    if not jdir.is_dir():
        return []
    out = []
    for d in sorted(jdir.iterdir()):
        if d.is_dir() and d.name.startswith(cid + "__"):
            rec = read_trial(d)
            if rec:
                out.append(rec)
    return out


def counted(results):
    """The newest attempt without an infrastructure error, else None."""
    good = [r for r in results if not r["infra"]]
    return good[-1] if good else None


def tokens_used(jdir, matrix):
    """Tokens of every finished attempt (counted or not) of the matrix's cells."""
    return sum(r["tokens"] or 0 for row, task, k, _ in matrix for r in cell_results(jdir, cell_id(row["id"], task, k)))


def token_cap(preset, override=None):
    raw = override if override is not None else (preset.get("bench") or {}).get("token_cap")
    return int(raw) if raw else None


def setup_only(args, todo, preset, jdir, runner, now):
    """Install check for the first selected cell: the agent installs, runs the zero-model
    setup checks and returns before any prompt. The job is named setup__..., never a cell."""
    if not todo:
        print("bench: no cell selected", flush=True)
        return 2
    row, task, k, path = todo[0]
    job = "setup__%s__%s" % (cell_id(row["id"], task, k), time.strftime("%Y%m%d-%H%M%S", time.gmtime(now())))
    cmd = harbor_command(row, path, preset["_path"], jdir, job, harbor=args.harbor) + ["--ak", "setup_only=1"]
    print("bench: %s" % " ".join(cmd), flush=True)
    if args.dry_run:
        return 0
    jdir.mkdir(parents=True, exist_ok=True)
    runner(cmd, env=harbor_env(), cwd=str(REPO))
    rec = read_trial(jdir / job) or {}
    check = (rec.get("meta") or {}).get("setup_check")
    print("bench: setup check (%s): %s" % (jdir / job, json.dumps({"setup_check": check, "versions": (rec.get("meta") or {}).get("versions")},
                                                                 indent=1, sort_keys=True)), flush=True)
    return 0 if check else 1


def run(args, runner=subprocess.run, now=time.time):
    preset = load_preset(args.preset)
    tdir = tasks_dir(preset, args.tasks)
    jdir = jobs_dir(preset, args.jobs_dir)
    todo = cells(preset, tdir, rows=args.rows, task_names=args.task, repeats=args.repeats)
    if getattr(args, "setup_only", False):
        return setup_only(args, todo, preset, jdir, runner, now)
    matrix = cells(preset, tdir)
    cap = token_cap(preset, getattr(args, "token_cap", None))
    env = harbor_env()
    ran = skipped = streak = 0
    if args.dry_run:
        print("bench: dry run, %d cell(s) in order; token cap %s; jobs dir %s" % (len(todo), cap or "none", jdir), flush=True)
    for i, (row, task, k, path) in enumerate(todo, 1):
        cid = cell_id(row["id"], task, k)
        if counted(cell_results(jdir, cid)):
            skipped += 1
            if args.dry_run:
                print("bench: [%d/%d] %s already finished" % (i, len(todo), cid), flush=True)
            continue
        if cap and not args.dry_run:
            used = tokens_used(jdir, matrix)
            if used >= cap:
                print("bench: token cap reached (%d of %d tokens used by finished cells); stopping before %s. "
                      "%d cell(s) run in this invocation." % (used, cap, cid, ran), flush=True)
                return EXIT_TOKEN_CAP
        job = "%s__%s" % (cid, time.strftime("%Y%m%d-%H%M%S", time.gmtime(now())))
        cmd = harbor_command(row, path, preset["_path"], jdir, job, harbor=args.harbor)
        print("bench: [%d/%d] %s" % (i, len(todo), " ".join(cmd)), flush=True)
        if args.dry_run:
            continue
        jdir.mkdir(parents=True, exist_ok=True)
        runner(cmd, env=env, cwd=str(REPO))
        ran += 1
        rec = read_trial(jdir / job)
        if rec is not None and rec["infra"] == "usage_limit":
            print("bench: provider usage limit reached in %s; stopping. The cell is not counted; rerun later to resume." % cid,
                  flush=True)
            return EXIT_USAGE_LIMIT
        if rec is None:
            print("bench: %s left no trial result (infrastructure error; rerun to retry)" % cid, flush=True)
        else:
            print("bench: %s reward=%s%s" % (cid, rec["reward"], " infra=%s" % rec["infra"] if rec["infra"] else ""), flush=True)
        streak = streak + 1 if rec is None or rec["infra"] else 0
        if streak >= INFRA_STREAK_MAX:
            print("bench: %d consecutive infrastructure-error cells (last %s: %s); stopping. Check the trial logs "
                  "(auth, Docker, install), then rerun to resume." % (streak, cid, rec["infra"] if rec else "no trial result"),
                  flush=True)
            return EXIT_INFRA_STREAK
    print("bench: %d cell(s) run, %d already finished" % (ran, skipped), flush=True)
    return 0


def _stat(values):
    vals = [v for v in values if v is not None]
    if not vals:
        return None
    return {"median": statistics.median(vals), "min": min(vals), "max": max(vals)}


def table(preset, tdir, jdir):
    """Rows of the result table: one per (row, task), counters only."""
    out = []
    groups = {}
    for row, task, k, _ in cells(preset, tdir):
        groups.setdefault((row["id"], task), []).append(cell_id(row["id"], task, k))
    for (rid, task), cids in groups.items():
        recs = [counted(cell_results(jdir, c)) for c in cids]
        done = [r for r in recs if r]
        infra_only = sum(1 for c in cids if not counted(cell_results(jdir, c)) and cell_results(jdir, c))
        out.append({
            "row": rid, "task": task, "repeats": len(cids), "counted": len(done), "infra_errors": infra_only,
            "success": sum(1 for r in done if r["success"]),
            "tokens": _stat([r["tokens"] for r in done]), "wall_seconds": _stat([r["wall_seconds"] for r in done]),
            "tool_calls": _stat([r["tool_calls"] for r in done]), "approvals": _stat([r["approvals"] for r in done]),
            "guard_blocks": _stat([r["guard_blocks"] for r in done]),
            "meta": done[-1]["meta"] if done else None,
        })
    return out


def _tier_stats(done):
    tiers = sorted({t for r in done for t in r.get("tokens_by_tier") or {}})
    return {t: _stat([(r.get("tokens_by_tier") or {}).get(t, 0) for r in done]) for t in tiers}


def row_summary(preset, tdir, jdir):
    """One entry per row over every matrix cell (the `first` cell excluded): success, tokens
    per model tier (median and range over cells), wall time, tool calls, approvals, guard blocks."""
    first = first_cell(preset, tdir)
    skip = cell_id(first[0]["id"], first[1], 1) if first else None
    groups = {}
    for row, task, k, _ in cells(preset, tdir):
        cid = cell_id(row["id"], task, k)
        if cid != skip:
            groups.setdefault(row["id"], []).append(cid)
    out = []
    for rid, cids in groups.items():
        done = [r for r in (counted(cell_results(jdir, c)) for c in cids) if r]
        out.append({
            "row": rid, "cells": len(cids), "counted": len(done), "success": sum(1 for r in done if r["success"]),
            "tokens": _stat([r["tokens"] for r in done]), "tokens_by_tier": _tier_stats(done),
            "wall_seconds": _stat([r["wall_seconds"] for r in done]), "tool_calls": _stat([r["tool_calls"] for r in done]),
            "approvals": _stat([r["approvals"] for r in done]), "guard_blocks": _stat([r["guard_blocks"] for r in done]),
        })
    return out


def first_summary(preset, tdir, jdir):
    """The `first` (re-check) cell: reward plus tokens per role and per tier, or None."""
    first = first_cell(preset, tdir)
    if not first:
        return None
    cid = cell_id(first[0]["id"], first[1], 1)
    rec = counted(cell_results(jdir, cid))
    return {"cell": cid, "finished": bool(rec), "reward": rec and rec["reward"], "tokens": rec and rec["tokens"],
            "tokens_by_role": rec and rec.get("tokens_by_role"), "tokens_by_tier": rec and rec.get("tokens_by_tier")}


def _fmt(s, nd=0):
    if not s:
        return "-"
    f = "%%.%df" % nd
    if s["min"] == s["max"]:
        return f % s["median"]
    return (f + " [" + f + "-" + f + "]") % (s["median"], s["min"], s["max"])


def _columns(head, lines):
    lines = [head] + lines
    widths = [max(len(str(l[i])) for l in lines) for i in range(len(head))]
    return ["  ".join(str(c).ljust(w) for c, w in zip(l, widths)) for l in lines]


def format_summary(summary, first=None):
    tiers = sorted({t for r in summary for t in r["tokens_by_tier"]})
    head = ["row", "success"] + ["tokens %s" % t for t in tiers] + ["tokens all", "wall s", "tool calls", "approvals", "guard blocks"]
    lines = [[r["row"], "%d/%d (%d cells)" % (r["success"], r["counted"], r["cells"])] +
             [_fmt(r["tokens_by_tier"].get(t)) for t in tiers] +
             [_fmt(r["tokens"]), _fmt(r["wall_seconds"], 1), _fmt(r["tool_calls"]), _fmt(r["approvals"]), _fmt(r["guard_blocks"])]
             for r in summary]
    text = ["Per row (median [min-max] over counted cells; first cell excluded):"] + _columns(head, lines)
    if first:
        text.append("First cell %s: %s" % (first["cell"], "not finished" if not first["finished"] else
                                           "reward %s, tokens %s, per role %s, per tier %s" % (
                                               first["reward"], first["tokens"], json.dumps(first["tokens_by_role"], sort_keys=True),
                                               json.dumps(first["tokens_by_tier"], sort_keys=True))))
    return "\n".join(text)


def format_table(rows):
    head = ["row", "task", "success", "tokens", "wall s", "tool calls", "approvals", "guard blocks"]
    lines = []
    for r in rows:
        lines.append([r["row"], r["task"], "%d/%d%s" % (r["success"], r["counted"], " (+%d infra)" % r["infra_errors"] if r["infra_errors"] else ""),
                      _fmt(r["tokens"]), _fmt(r["wall_seconds"], 1), _fmt(r["tool_calls"]), _fmt(r["approvals"]),
                      _fmt(r["guard_blocks"])])
    text = _columns(head, lines)
    metas = {}
    for r in rows:
        if r["meta"]:
            metas[r["row"]] = r["meta"]
    for rid, m in metas.items():
        text.append("%s: commit %s%s, versions %s, main %s, roles %s, thinking configured %s (null = shipped default), "
                    "thinking seen %s" % (
                        rid, (m.get("pi_foreman_commit") or "?")[:12], " (dirty)" if m.get("pi_foreman_dirty") else "",
                        json.dumps(m.get("versions"), sort_keys=True), m.get("model_main"),
                        json.dumps(m.get("models_by_role"), sort_keys=True), json.dumps(m.get("thinking"), sort_keys=True),
                        json.dumps(m.get("thinking_seen"), sort_keys=True)))
    return "\n".join(text)


def main(argv=None):
    ap = argparse.ArgumentParser(prog="foreman bench", description="pi-foreman benchmark rig (Harbor)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("run", "table"):
        s = sub.add_parser(name)
        s.add_argument("--preset", required=True)
        s.add_argument("--tasks", default=None, help="task dir (overrides bench.tasks_dir)")
        s.add_argument("--jobs-dir", default=None, help="jobs dir (default: bench.jobs_dir or ~/.pi-foreman/bench-jobs)")
    r = sub.choices["run"]
    r.add_argument("--rows", nargs="*", default=None)
    r.add_argument("--task", nargs="*", default=None)
    r.add_argument("--repeats", type=int, default=None)
    r.add_argument("--harbor", default="harbor")
    r.add_argument("--dry-run", action="store_true", help="print the cell order and commands; run nothing")
    r.add_argument("--token-cap", type=int, default=None, help="stop before the next cell once finished cells used N tokens")
    r.add_argument("--setup-only", action="store_true",
                   help="install check for the first selected cell: install, zero-model checks, no prompt")
    sub.choices["table"].add_argument("--json", action="store_true")
    args = ap.parse_args(argv)
    if args.cmd == "run":
        return run(args)
    preset = load_preset(args.preset)
    tdir, jdir = tasks_dir(preset, args.tasks), jobs_dir(preset, args.jobs_dir)
    rows, summary, first = table(preset, tdir, jdir), row_summary(preset, tdir, jdir), first_summary(preset, tdir, jdir)
    if args.json:
        print(json.dumps({"rows": summary, "first": first, "cells": rows}, indent=1))
    else:
        print(format_summary(summary, first) + "\n\nPer row and task:\n" + format_table(rows))
    return 0


if __name__ == "__main__":
    sys.exit(main())
