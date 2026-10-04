#!/usr/bin/env python3
"""`foreman bench`: run the pi-foreman benchmark matrix through Harbor and tabulate it
(stdlib, 3.9+). The Harbor side lives in bench/harbor_agent.py; this script never imports it.

    python scripts/foreman_bench.py run   --preset bench/presets/smoke.json [--tasks DIR] [--jobs-dir DIR]
    python scripts/foreman_bench.py table --preset bench/presets/smoke.json [--jobs-dir DIR] [--json]

Preset (JSON):
    {"bench": {"tasks_dir": "<dir, relative to the preset file>", "repeats": 3, "jobs_dir": "<optional>"},
     "rows": [{"id": "R2", "agent": "foreman"|"plain", "provider": "...", "model": "provider/model",
               "roles": {"<role>": {"model": "...", "thinking": "..."}}, "thinking": "...",
               "driver": "rpc"|"print", "cap_seconds": 1800}]}

Matrix: rows x tasks (each subdir of the task dir with a task.toml) x repeats. Each cell is one
`harbor run` job named `<row>__<task>__r<n>__<stamp>` in the jobs dir (default outside the
repo: ~/.pi-foreman/bench-jobs). `run` skips cells that already have a counted result, so a
second `run` resumes; infrastructure-error cells are re-run. A provider usage-limit answer
stops the run at once (exit 3); rerun later to resume.

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


def default_jobs_dir():
    return Path.home() / ".pi-foreman" / "bench-jobs"


def load_preset(path):
    path = Path(path).resolve()
    data = json.loads(path.read_text("utf-8"))
    data["_path"] = str(path)
    return data


def tasks_dir(preset, override=None):
    if override:
        return Path(override).resolve()
    raw = (preset.get("bench") or {}).get("tasks_dir")
    if not raw:
        raise SystemExit("no task dir: pass --tasks DIR or set bench.tasks_dir in the preset")
    p = Path(raw)
    return (p if p.is_absolute() else Path(preset["_path"]).parent / p).resolve()


def jobs_dir(preset, override=None):
    raw = override or (preset.get("bench") or {}).get("jobs_dir")
    return Path(raw).expanduser().resolve() if raw else default_jobs_dir()


def list_tasks(tdir):
    return sorted(d.name for d in Path(tdir).iterdir() if (d / "task.toml").is_file())


def cell_id(row_id, task, rep):
    return "%s__%s__r%d" % (row_id, task, rep)


def cells(preset, tdir, rows=None, task_names=None, repeats=None):
    reps = int(repeats or (preset.get("bench") or {}).get("repeats") or 1)
    out = []
    for row in preset.get("rows") or []:
        if rows and row["id"] not in rows:
            continue
        for task in list_tasks(tdir):
            if task_names and task not in task_names:
                continue
            for k in range(1, reps + 1):
                out.append((row, task, k))
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
            "-o", str(jdir), "--job-name", job_name, "-n", "1", "-q"]


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
        return {
            "job": Path(job_dir).name, "reward": reward, "success": reward is not None and float(reward) >= 1.0,
            "infra": infra, "exception": exc,
            "tokens": (counters.get("tokens") or {}).get("total"),
            "wall_seconds": _seconds(r.get("agent_execution")),
            "tool_calls": counters.get("tool_calls"), "approvals": counters.get("approvals"),
            "guard_blocks": counters.get("guard_blocks"),
            "meta": {k: bench.get(k) for k in ("pi_foreman_commit", "pi_foreman_dirty", "versions", "model_main",
                                              "models_by_role", "thinking", "driver", "status")},
        }
    return None


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


def run(args, runner=subprocess.run, now=time.time):
    preset = load_preset(args.preset)
    tdir = tasks_dir(preset, args.tasks)
    jdir = jobs_dir(preset, args.jobs_dir)
    todo = cells(preset, tdir, rows=args.rows, task_names=args.task, repeats=args.repeats)
    env = harbor_env()
    ran = skipped = 0
    for row, task, k in todo:
        cid = cell_id(row["id"], task, k)
        if counted(cell_results(jdir, cid)):
            skipped += 1
            continue
        job = "%s__%s" % (cid, time.strftime("%Y%m%d-%H%M%S", time.gmtime(now())))
        cmd = harbor_command(row, tdir / task, preset["_path"], jdir, job, harbor=args.harbor)
        print("bench: %s" % " ".join(cmd), flush=True)
        if args.dry_run:
            continue
        jdir.mkdir(parents=True, exist_ok=True)
        runner(cmd, env=env, cwd=str(REPO))
        ran += 1
        rec = read_trial(jdir / job)
        if rec is None:
            print("bench: %s left no trial result (infrastructure error; rerun to retry)" % cid, flush=True)
            continue
        if rec["infra"] == "usage_limit":
            print("bench: provider usage limit reached in %s; stopping. The cell is not counted; rerun later to resume." % cid,
                  flush=True)
            return EXIT_USAGE_LIMIT
        print("bench: %s reward=%s%s" % (cid, rec["reward"], " infra=%s" % rec["infra"] if rec["infra"] else ""), flush=True)
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
    for row, task, k in cells(preset, tdir):
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


def _fmt(s, nd=0):
    if not s:
        return "-"
    f = "%%.%df" % nd
    if s["min"] == s["max"]:
        return f % s["median"]
    return (f + " [" + f + "-" + f + "]") % (s["median"], s["min"], s["max"])


def format_table(rows):
    head = ["row", "task", "success", "tokens", "wall s", "tool calls", "approvals", "guard blocks"]
    lines = [head]
    for r in rows:
        lines.append([r["row"], r["task"], "%d/%d%s" % (r["success"], r["counted"], " (+%d infra)" % r["infra_errors"] if r["infra_errors"] else ""),
                      _fmt(r["tokens"]), _fmt(r["wall_seconds"], 1), _fmt(r["tool_calls"]), _fmt(r["approvals"]),
                      _fmt(r["guard_blocks"])])
    widths = [max(len(str(l[i])) for l in lines) for i in range(len(head))]
    text = ["  ".join(str(c).ljust(w) for c, w in zip(l, widths)) for l in lines]
    metas = {}
    for r in rows:
        if r["meta"]:
            metas[r["row"]] = r["meta"]
    for rid, m in metas.items():
        text.append("%s: commit %s%s, versions %s, main %s, roles %s, thinking %s" % (
            rid, (m.get("pi_foreman_commit") or "?")[:12], " (dirty)" if m.get("pi_foreman_dirty") else "",
            json.dumps(m.get("versions"), sort_keys=True), m.get("model_main"), json.dumps(m.get("models_by_role"), sort_keys=True),
            json.dumps(m.get("thinking"), sort_keys=True)))
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
    r.add_argument("--dry-run", action="store_true")
    sub.choices["table"].add_argument("--json", action="store_true")
    args = ap.parse_args(argv)
    if args.cmd == "run":
        return run(args)
    preset = load_preset(args.preset)
    rows = table(preset, tasks_dir(preset, args.tasks), jobs_dir(preset, args.jobs_dir))
    print(json.dumps(rows, indent=1) if args.json else format_table(rows))
    return 0


if __name__ == "__main__":
    sys.exit(main())
