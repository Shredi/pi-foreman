#!/usr/bin/env python3
"""`foreman bench`: run the pi-foreman benchmark matrix through Harbor and tabulate it
(stdlib, 3.9+). The Harbor side lives in bench/harbor_agent.py; this script never imports it.

    python scripts/foreman_bench.py run   --preset bench/presets/smoke.json [--tasks DIR] [--jobs-dir DIR]
                                          [--token-cap N] [--dry-run] [--setup-only]
    python scripts/foreman_bench.py table --preset bench/presets/smoke.json [--jobs-dir DIR] [--json] [--cost]

Preset (JSON):
    {"bench": {"tasks_dir": "<dir, relative to the preset file>", "repeats": 3, "jobs_dir": "<optional>",
               "tasks": ["<task>", ...], "token_cap": 1000000,
               "repeats_by_task": {"<task>": <n>},   (per-task repeats; overrides `repeats`)
               "cap_seconds_by_task": {"<task>": <seconds>},   (per-task wall cap; overrides the row's cap_seconds)
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
infrastructure-error cells in one invocation stop the run too (exit 5). Besides Harbor's own
infrastructure exceptions, a cell is an infrastructure error when Pi never reached a model turn,
its first assistant message ended with stopReason "error" (provider, bridge or auth failure),
or the run used zero model tokens. SIGINT or SIGTERM stops the run cleanly (exit 6): the signal
is forwarded to the running Harbor child, which cancels the trial and stops its environment
(leftover containers of that trial are removed), and the interrupted cell is marked
(bench-interrupted in its job dir) so it is never counted and a later `run` re-runs it. The
per-cell wall cap is the row's cap_seconds.

Run it on a host that cannot sleep (on AC power, lid open or clamshell with display): the
first real run spent most of its ~6.7 h with the laptop asleep on battery, which stretched
setup and quiet-period phases across sleep gaps.

Harbor telemetry is always switched off for every Harbor process (HARBOR_TELEMETRY=off); the
script never passes --upload or --launch. The result table holds counters only.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import signal
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
EXIT_INTERRUPTED = 6
INTERRUPTED_MARK = "bench-interrupted"  # in a job dir: the cell was stopped by SIGINT/SIGTERM, not counted
HARBOR_STOP_GRACE = 300  # seconds Harbor gets after the forwarded signal to stop its environment
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
    cfg = preset.get("bench") or {}
    reps = int(repeats or cfg.get("repeats") or 1)
    by_task = cfg.get("repeats_by_task") or {}  # task -> repeats; overrides the global value (not an explicit --repeats)
    row_list = [r for r in preset.get("rows") or [] if not rows or r["id"] in rows]
    tasks = [t for t in ordered_tasks(preset, tdir) if not task_names or t in task_names]
    out = []
    first = first_cell(preset, tdir)
    if first and (not rows or first[0]["id"] in rows) and (not task_names or first[1] in task_names):
        out.append(first)
    task_reps = {t: reps if repeats else int(by_task.get(t) or reps) for t in tasks}
    for k in range(1, max(task_reps.values(), default=0) + 1):
        for task in tasks:
            if k > task_reps[task]:
                continue
            for row in row_list:
                out.append((row, task, k, Path(tdir) / task))
    return out


def row_model(row):
    provider = row.get("provider", "foreman-fake")
    return row.get("model") or "%s/foreman" % provider


def harbor_command(row, task_path, preset_path, jdir, job_name, harbor="harbor", cap_by_task=None):
    kind = row.get("agent", "foreman")
    if kind not in AGENT_CLASSES:
        raise ValueError("row %s: agent must be one of %s" % (row.get("id"), sorted(AGENT_CLASSES)))
    cap = (cap_by_task or {}).get(Path(task_path).name)
    return [harbor, "run", "-p", str(task_path), "-a", AGENT_CLASSES[kind], "-m", row_model(row),
            "--ak", "preset=%s" % preset_path, "--ak", "row=%s" % row["id"]] + (
        ["--ak", "cap_seconds=%s" % cap] if cap else []) + [
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


REFUSAL = re.compile(r"safeguards flagged|flagged this message", re.I)


def logs_refusal(agent_dir):
    """True when an assistant message with stopReason error in the session or rpc files of a cell's agent
    logs dir carries a provider refusal text (same rule as bench/harbor_agent.classify_infra)."""
    agent_dir = Path(agent_dir)
    files = sorted((agent_dir / "sessions").rglob("*.jsonl")) if (agent_dir / "sessions").is_dir() else []
    files += [agent_dir / "rpc.jsonl"] if (agent_dir / "rpc.jsonl").is_file() else []
    for f in files:
        if "subagent-artifacts" in f.parts:
            continue
        for line in f.read_text("utf-8", "replace").splitlines():
            if "error" not in line:
                continue
            try:
                rec = json.loads(line)
            except ValueError:
                continue
            msg = rec.get("message") if isinstance(rec, dict) else None
            if isinstance(msg, dict) and msg.get("role") == "assistant" and msg.get("stopReason") == "error" and \
                    REFUSAL.search("%s %s" % (msg.get("errorMessage") or "", json.dumps(msg.get("content") or ""))):
                return True
    return False


def agent_infra(rpc_log, tokens_total):
    """Infrastructure error of an agent run that never really worked on the task, else None:
    the main Pi session never reached a model turn (no assistant message in rpc.jsonl), its
    first assistant message failed (stopReason "error": provider, bridge or auth failure), or
    the run used zero model tokens. The rpc.jsonl checks apply only when the file exists."""
    rpc_log = Path(rpc_log)
    if logs_refusal(rpc_log.parent):
        return "provider_refusal"
    if rpc_log.is_file():
        first = None
        for line in rpc_log.read_text("utf-8", "replace").splitlines():
            try:
                rec = json.loads(line)
            except ValueError:
                continue
            if not isinstance(rec, dict):
                continue
            msg = rec.get("message")
            if rec.get("type") == "message_end" and isinstance(msg, dict) and msg.get("role") == "assistant":
                first = msg
                break
        if first is None:
            return "no_model_turn"
        if first.get("stopReason") == "error":
            return "assistant_error"
    if tokens_total is not None and int(tokens_total) == 0:
        return "zero_tokens"
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
        flagged = bench.get("infra") if isinstance(bench.get("infra"), dict) else None
        detail = (flagged or {}).get("detail") or str((r.get("exception_info") or {}).get("exception_message") or "")
        if exc == USAGE_LIMIT_EXC or bench.get("infra_error") == "usage_limit":
            infra = "usage_limit"
        elif flagged and flagged.get("flag"):
            infra = flagged.get("reason") or "unknown"
        elif exc in INFRA_EXC or bench.get("infra_error"):
            infra = exc or bench.get("infra_error")
        elif reward is None:
            infra = exc or "no_verifier_result"
        counters = bench.get("counters") or {}
        if not infra and (Path(job_dir) / INTERRUPTED_MARK).is_file():
            infra = "interrupted"
        if not infra and flagged is None:  # 2a job dirs: no flag recorded, classify from the logs
            infra = agent_infra(f.parent / "agent" / "rpc.jsonl", (counters.get("tokens") or {}).get("total"))
        by_tier, usage = {}, {}
        for model, t in (counters.get("tokens_by_model") or {}).items():
            by_tier[tier(model)] = by_tier.get(tier(model), 0) + sum(int(v or 0) for v in t.values())
            u = usage.setdefault(str(model).rsplit("/", 1)[-1], {k: 0 for k in TOKEN_KINDS})
            for k in TOKEN_KINDS:
                u[k] += int((t or {}).get(k) or 0)
        return {
            "job": Path(job_dir).name, "reward": reward, "success": reward is not None and float(reward) >= 1.0,
            "infra": infra, "infra_detail": detail if infra else "", "exception": exc,
            "usage_by_role_model": counters.get("usage_by_role_model"), "usage_log_delta": counters.get("usage_log_delta"),
            "triage": _triage(counters, bench),
            "tokens": (counters.get("tokens") or {}).get("total"),
            "tokens_by_tier": by_tier, "usage_by_model": usage, "tokens_by_role": counters.get("tokens_by_role"),
            "wall_seconds": _seconds(r.get("agent_execution")),
            "tool_calls": counters.get("tool_calls"), "approvals": counters.get("approvals"),
            "guard_blocks": counters.get("guard_blocks"),
            "meta": dict({k: bench.get(k) for k in ("pi_foreman_commit", "pi_foreman_dirty", "versions", "model_main",
                                                   "models_by_role", "thinking", "driver", "status", "setup_check")},
                         thinking_seen=counters.get("thinking_by_role")),
        }
    return None


def _triage(counters, bench):
    """Triage evidence of a cell (tier, launches, revisions, gate_blocks, asks_denied, asks_reviewed), or None
    when the cell has no trace (2a job dirs, plain rows)."""
    t = counters.get("triage")
    if not t:
        return None
    return dict(t, asks_denied=len(bench.get("asks_denied") or []))


TOKEN_KINDS = ("input", "cacheRead", "cacheWrite", "output")
PRICES_FILE = REPO / "bench" / "prices.json"
COST_LABEL = "list-price equivalent (runs go through the subscription)"


def load_prices(path=None):
    """Price file: {"source", "retrieved", "models": {bare model id: {input, output, cache_read, cache_write_5m,
    cache_write_1h}}} in USD per MTok. Replaceable data."""
    return json.loads(Path(path or PRICES_FILE).read_text("utf-8"))


def cost_of(rec, prices):
    """List-price cost of one finished record from its recorded tokens. Cache writes are priced at the 5-minute
    rate (the records do not tell 5m from 1h); `usd_1h` is the same total with every write at the 1-hour rate.
    None when the record has no usage; models without a price are listed in `unpriced` and left out."""
    usage = rec.get("usage_by_model") or {}
    if not usage:
        return None
    known = prices.get("models") or {}
    out = {"usd": 0.0, "usd_1h": 0.0, "by_tier": {}, "read_tokens": 0, "write_tokens": 0, "read_usd": 0.0,
           "write_usd": 0.0, "unpriced": [], "by_role": {}}
    for role, models in (rec.get("usage_by_role_model") or {}).items():
        for model, u in models.items():
            p = known.get(model)
            if not p:
                out["unpriced"].append(model)
                continue
            out["by_role"][role] = out["by_role"].get(role, 0.0) + (
                u["input"] * p["input"] + u["output"] * p["output"] + u["cacheRead"] * p["cache_read"]
                + u["cacheWrite"] * p["cache_write_5m"]) / 1e6
    for model, u in usage.items():
        p = known.get(model)
        if not p:
            out["unpriced"].append(model)
            continue
        base = (u["input"] * p["input"] + u["output"] * p["output"]) / 1e6
        rd = u["cacheRead"] * p["cache_read"] / 1e6
        w5 = u["cacheWrite"] * p["cache_write_5m"] / 1e6
        w1 = u["cacheWrite"] * p["cache_write_1h"] / 1e6
        t = tier(model)
        out["by_tier"][t] = out["by_tier"].get(t, 0.0) + base + rd + w5
        out["usd"] += base + rd + w5
        out["usd_1h"] += base + rd + w1
        out["read_tokens"] += u["cacheRead"]
        out["write_tokens"] += u["cacheWrite"]
        out["read_usd"] += rd
        out["write_usd"] += w5
    return out


def _share(a, b):
    return a / (a + b) if a + b else None


def cost_stats(done, prices):
    """Median/min/max over the counted records: total USD (5m writes, and with 1h writes), USD per tier, cache
    read and write tokens and cost, and the warm share (read / (read + write)) by tokens and by cost."""
    cs = [c for c in (cost_of(r, prices) for r in done) if c]
    if not cs:
        return None
    tiers = sorted({t for c in cs for t in c["by_tier"]})
    with_log = [c for c in cs if c["by_role"]]
    roles = sorted({r for c in with_log for r in c["by_role"]})
    shares = lambda a, b: [x for x in (_share(c[a], c[b]) for c in cs) if x is not None]  # noqa: E731
    return {"usd": _stat([c["usd"] for c in cs]), "usd_1h": _stat([c["usd_1h"] for c in cs]),
            "by_tier": {t: _stat([c["by_tier"].get(t, 0.0) for c in cs]) for t in tiers},
            "read_tokens": _stat([c["read_tokens"] for c in cs]), "write_tokens": _stat([c["write_tokens"] for c in cs]),
            "read_usd": _stat([c["read_usd"] for c in cs]), "write_usd": _stat([c["write_usd"] for c in cs]),
            "warm_share_tokens": _stat(shares("read_tokens", "write_tokens")),
            "warm_share_usd": _stat(shares("read_usd", "write_usd")),
            "unpriced": sorted({m for c in cs for m in c["unpriced"]}),
            **({"by_role": {r: _stat([c["by_role"].get(r, 0.0) for c in with_log]) for r in roles}} if with_log else {})}


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


_STOP = {"signal": None, "at": None, "child": None}


def _on_signal(signum, _frame):
    """SIGINT/SIGTERM: remember it and forward SIGINT to the running Harbor child once (Harbor
    then cancels the trial and stops its environment); a second signal terminates the child."""
    first = _STOP["signal"] is None
    if first:
        _STOP["signal"], _STOP["at"] = signum, time.time()
    child = _STOP["child"]
    if child is None or child.poll() is not None:
        return
    try:
        if not first:
            child.terminate()
        elif os.name == "nt":
            child.send_signal(signal.CTRL_BREAK_EVENT)
        else:
            child.send_signal(signal.SIGINT)
    except OSError:
        pass


def run_harbor(cmd, env, cwd):
    """Run one `harbor run` in its own process group (a terminal Ctrl-C reaches only this
    script, which forwards it). After a stop signal Harbor gets HARBOR_STOP_GRACE seconds to
    clean up, then it is killed."""
    kw = {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP} if os.name == "nt" else {"start_new_session": True}
    child = subprocess.Popen(cmd, env=env, cwd=cwd, **kw)
    _STOP["child"] = child
    try:
        while True:
            try:
                return child.wait(timeout=1)
            except subprocess.TimeoutExpired:
                if _STOP["at"] and time.time() - _STOP["at"] > HARBOR_STOP_GRACE:
                    child.kill()
                    return child.wait()
    finally:
        _STOP["child"] = None


def remove_cell_containers(job_dir, runner=subprocess.run):
    """Remove containers Harbor left behind for an interrupted job: its compose projects are
    named after the trial (`<trial>__env`, sanitized as Harbor does)."""
    for trial in sorted(Path(job_dir).iterdir()) if Path(job_dir).is_dir() else []:
        if not trial.is_dir():
            continue
        name = (trial.name + "__env").lower()
        name = re.sub(r"[^a-z0-9_-]", "-", name if re.match(r"^[a-z0-9]", name) else "0" + name)
        try:
            ids = runner(["docker", "ps", "-aq", "--filter", "label=com.docker.compose.project=%s" % name],
                         stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=60).stdout.decode().split()
            if ids:
                runner(["docker", "rm", "-f"] + ids, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=120)
                print("bench: removed %d leftover container(s) of %s" % (len(ids), name), flush=True)
        except (OSError, subprocess.SubprocessError, AttributeError):
            pass


def setup_only(args, todo, preset, jdir, runner, now):
    """Install check for the first selected cell: the agent installs, runs the zero-model
    setup checks and returns before any prompt. The job is named setup__..., never a cell."""
    if not todo:
        print("bench: no cell selected", flush=True)
        return 2
    row, task, k, path = todo[0]
    job = "setup__%s__%s" % (cell_id(row["id"], task, k), time.strftime("%Y%m%d-%H%M%S", time.gmtime(now())))
    cmd = harbor_command(row, path, preset["_path"], jdir, job, harbor=args.harbor,
                          cap_by_task=(preset.get("bench") or {}).get("cap_seconds_by_task")) + ["--ak", "setup_only=1"]
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


def run(args, runner=None, now=time.time):
    """`run` with SIGINT/SIGTERM handling: a stop signal ends the run after the current cell's
    Harbor child has stopped; that cell is marked interrupted (not counted) and exit is 6."""
    _STOP.update(signal=None, at=None, child=None)
    if runner is not None or args.dry_run or getattr(args, "setup_only", False):
        return _run(args, runner or subprocess.run, now)
    old = {s: signal.signal(s, _on_signal) for s in (signal.SIGINT, signal.SIGTERM)}
    try:
        return _run(args, run_harbor, now)
    finally:
        for s, h in old.items():
            signal.signal(s, h)


def _run(args, runner, now):
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
        cmd = harbor_command(row, path, preset["_path"], jdir, job, harbor=args.harbor,
                          cap_by_task=(preset.get("bench") or {}).get("cap_seconds_by_task"))
        print("bench: [%d/%d] %s" % (i, len(todo), " ".join(cmd)), flush=True)
        if args.dry_run:
            continue
        jdir.mkdir(parents=True, exist_ok=True)
        started = _STOP["signal"] is None
        if started:
            runner(cmd, env=env, cwd=str(REPO))
        if _STOP["signal"] is not None:
            if started:  # the cell ran (partly): never count it, and leave no container behind
                (jdir / job).mkdir(parents=True, exist_ok=True)
                (jdir / job / INTERRUPTED_MARK).write_text("signal %s\n" % _STOP["signal"], "utf-8")
                remove_cell_containers(jdir / job)
            print("bench: interrupted (signal %s)%s; %d cell(s) finished in this invocation. "
                  "Resume with the same `run` command." % (_STOP["signal"], " during %s, which is not counted" % cid
                                                           if started else " before %s" % cid, ran), flush=True)
            return EXIT_INTERRUPTED
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


def _triage_stats(done):
    ts = [r["triage"] for r in done if r.get("triage")]
    tiers = [t["tier"] for t in ts]
    return {"tier": max(sorted(set(tiers)), key=tiers.count) if tiers else None,
            "launches": _stat([sum((t.get("launches") or {}).values()) for t in ts]),
            "revisions": _stat([t.get("revisions") for t in ts]), "asks_denied": _stat([t.get("asks_denied") for t in ts]),
            "gate_blocks": _stat([t.get("gate_blocks") for t in ts]),
            "pollBash": _stat([t.get("pollBash") for t in ts]), "ceremony_incomplete": _stat([t.get("ceremony_incomplete") for t in ts]),
            "foreman_edit_refused": _stat([t.get("foreman_edit_refused") for t in ts]),
            "pr_refused": _stat([t.get("pr_refused") for t in ts]),
            "checkpoint_auto": _stat([t.get("checkpoint_auto") for t in ts])}


def infra_cells(preset, tdir, jdir):
    """Every infrastructure-error attempt of the matrix: cell, reason, detail, job dir name."""
    out = []
    for row, task, k, _ in cells(preset, tdir):
        cid = cell_id(row["id"], task, k)
        out += [{"cell": cid, "reason": r["infra"], "detail": r.get("infra_detail") or "", "job": r["job"]}
                for r in cell_results(jdir, cid) if r["infra"]]
    return out


def format_infra(items):
    if not items:
        return ""
    lines = [[i["cell"], i["reason"], (i["detail"] or "").replace("\n", " ")[:80], i["job"]] for i in items]
    return "Infra cells (excluded from the medians; a later `run` reruns them):\n" + "\n".join(
        _columns(["cell", "reason", "detail", "job dir"], lines))


def table(preset, tdir, jdir, prices=None):
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
            **_triage_stats(done),
            "meta": done[-1]["meta"] if done else None,
            **({"cost": cost_stats(done, prices)} if prices else {}),
        })
    return out


def _tier_stats(done):
    tiers = sorted({t for r in done for t in r.get("tokens_by_tier") or {}})
    return {t: _stat([(r.get("tokens_by_tier") or {}).get(t, 0) for r in done]) for t in tiers}


def row_summary(preset, tdir, jdir, prices=None):
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
            **_triage_stats(done),
            **({"cost": cost_stats(done, prices)} if prices else {}),
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
    head = ["row", "success"] + ["tokens %s" % t for t in tiers] + ["tokens all", "wall s", "tool calls", "approvals", "guard blocks",
                                                                "tier", "launches", "revisions", "asks_denied", "gate_blocks", "pollBash", "ceremony_incomplete",
            "foreman_edit_refused", "pr_refused", "checkpoint_auto"]
    lines = [[r["row"], "%d/%d (%d cells)" % (r["success"], r["counted"], r["cells"])] +
             [_fmt(r["tokens_by_tier"].get(t)) for t in tiers] +
             [_fmt(r["tokens"]), _fmt(r["wall_seconds"], 1), _fmt(r["tool_calls"]), _fmt(r["approvals"]), _fmt(r["guard_blocks"]),
              r.get("tier") or "-", _fmt(r.get("launches")), _fmt(r.get("revisions")), _fmt(r.get("asks_denied")),
              _fmt(r.get("gate_blocks")), _fmt(r.get("pollBash")), _fmt(r.get("ceremony_incomplete")),
              _fmt(r.get("foreman_edit_refused")), _fmt(r.get("pr_refused")), _fmt(r.get("checkpoint_auto"))] for r in summary]
    text = ["Per row (median [min-max] over counted cells; first cell excluded):"] + _columns(head, lines)
    if first:
        text.append("First cell %s: %s" % (first["cell"], "not finished" if not first["finished"] else
                                           "reward %s, tokens %s, per role %s, per tier %s" % (
                                               first["reward"], first["tokens"], json.dumps(first["tokens_by_role"], sort_keys=True),
                                               json.dumps(first["tokens_by_tier"], sort_keys=True))))
    return "\n".join(text)


def _usd(s):
    if not s:
        return "-"
    f = "$%.2f"
    return f % s["median"] if s["min"] == s["max"] else (f + " [" + f + "-" + f + "]") % (s["median"], s["min"], s["max"])


def _pct(s):
    if not s:
        return "-"
    f = "%.0f%%"
    if s["min"] == s["max"]:
        return f % (100 * s["median"])
    return (f + " [" + f + "-" + f + "]") % (100 * s["median"], 100 * s["min"], 100 * s["max"])


def format_cost(summary, rows, prices):
    """The cost block: per row and per (row, task), dollars per tier plus the warm/cold cache split."""
    out = ["Cost, %s. Median [min-max] over counted cells (first cell excluded from the per-row block)." % COST_LABEL,
           "Prices: %s, retrieved %s (bench/prices.json). Cache writes are priced at the 5-minute rate; the records do not "
           "tell 5-minute from 1-hour writes, so 'usd 1h' shows the same cells with every write at the 1-hour rate "
           "(upper bound). Warm = cache read / (cache read + cache write), by tokens and by cost." % (
               prices.get("source"), prices.get("retrieved"))]
    for title, items, keys in (("Per row", summary, ["row"]), ("Per row and task", rows, ["row", "task"])):
        tiers = sorted({t for r in items if r.get("cost") for t in r["cost"]["by_tier"]})
        head = keys + ["usd (5m writes)"] + ["usd %s" % t for t in tiers] + [
            "usd 1h", "cache read tok", "cache write tok", "warm tok", "read usd", "write usd", "warm usd"]
        lines = []
        for r in items:
            c = r.get("cost")
            if not c:
                lines.append([r[k] for k in keys] + ["-"] * (len(head) - len(keys)))
                continue
            lines.append([r[k] for k in keys] + [_usd(c["usd"])] + [_usd(c["by_tier"].get(t)) for t in tiers] + [
                _usd(c["usd_1h"]), _fmt(c["read_tokens"]), _fmt(c["write_tokens"]), _pct(c["warm_share_tokens"]),
                _usd(c["read_usd"]), _usd(c["write_usd"]), _pct(c["warm_share_usd"])])
        out += ["", title + ":"] + _columns(head, lines)
    for title, items, keys in (("Per row, cost per role (usage log)", summary, ["row"]),
                               ("Per row and task, cost per role (usage log)", rows, ["row", "task"])):
        roles = sorted({x for r in items if r.get("cost") for x in r["cost"].get("by_role") or {}})
        if roles:
            out += ["", title + ", median USD per cell (role 'child' = tasks/chain children, whose real role the log does not record):"]
            out += _columns(keys + roles, [[r[k] for k in keys] + [_usd(((r.get("cost") or {}).get("by_role") or {}).get(x))
                                                                  for x in roles] for r in items])
    unpriced = sorted({m for r in summary + rows if r.get("cost") for m in r["cost"]["unpriced"]})
    if unpriced:
        out.append("Not priced (left out of the totals): %s" % ", ".join(unpriced))
    return "\n".join(out)


def format_table(rows):
    head = ["row", "task", "success", "tokens", "wall s", "tool calls", "approvals", "guard blocks",
            "tier", "launches", "revisions", "asks_denied", "gate_blocks", "pollBash", "ceremony_incomplete",
            "foreman_edit_refused", "pr_refused", "checkpoint_auto"]
    lines = []
    for r in rows:
        lines.append([r["row"], r["task"], "%d/%d%s" % (r["success"], r["counted"], " (+%d infra)" % r["infra_errors"] if r["infra_errors"] else ""),
                      _fmt(r["tokens"]), _fmt(r["wall_seconds"], 1), _fmt(r["tool_calls"]), _fmt(r["approvals"]),
                      _fmt(r["guard_blocks"]), r.get("tier") or "-", _fmt(r.get("launches")), _fmt(r.get("revisions")),
                      _fmt(r.get("asks_denied")), _fmt(r.get("gate_blocks")), _fmt(r.get("pollBash")), _fmt(r.get("ceremony_incomplete")),
              _fmt(r.get("foreman_edit_refused")), _fmt(r.get("pr_refused")), _fmt(r.get("checkpoint_auto"))])
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
    sub.choices["table"].add_argument("--cost", action="store_true",
                                      help="add the list-price-equivalent cost block (prices from bench/prices.json)")
    sub.choices["table"].add_argument("--prices", default=None, help="price file (default: bench/prices.json)")
    args = ap.parse_args(argv)
    if args.cmd == "run":
        return run(args)
    preset = load_preset(args.preset)
    tdir, jdir = tasks_dir(preset, args.tasks), jobs_dir(preset, args.jobs_dir)
    prices = load_prices(args.prices) if args.cost else None
    rows, summary = table(preset, tdir, jdir, prices), row_summary(preset, tdir, jdir, prices)
    first = first_summary(preset, tdir, jdir)
    if args.json:
        print(json.dumps({"rows": summary, "first": first, "cells": rows, "infra_cells": infra_cells(preset, tdir, jdir)}, indent=1))
    else:
        text = format_summary(summary, first) + "\n\nPer row and task:\n" + format_table(rows)
        text += ("\n\n" + format_infra(infra_cells(preset, tdir, jdir))).rstrip()
        print(text + ("\n\n" + format_cost(summary, rows, prices) if prices else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
