"""Benchmark waiter: runs one Pi session inside a task container and returns only when the
whole session is done. Standard library only, Python 3.9+. Started by bench/harbor_agent.py.

Done means all of:
  1. Pi is idle: the newest run ended with `agent_settled`, and `get_state` reports
     isStreaming false with no pending messages;
  2. no pi-subagents async run is still active: every run dir under
     $PI_SUBAGENTS_TEMP_ROOT/async-subagent-runs/ has a status.json whose `state` is not
     `queued` or `running` (a run dir without status.json counts as active);
  3. a quiet period passed with no RPC record and no status.json change.
A wall-clock cap (the cell's budget cap) ends the session early.

`--driver print` runs `pi --print --mode json` instead and returns when Pi exits, which is
what Harbor's stock Pi adapter does.

A provider answer "usage limit reached" ends the session at once and is recorded as an
infrastructure error, not as a task result.

Outputs under --out (the trial's /logs/agent): bench-run.json (status, timings, child runs,
versions, config checks), rpc.jsonl (RPC records without message_update), sessions/ (Pi
session files of the foreman and every child) and trace/ (pi-foreman trace files).
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
sys.path.insert(0, str(REPO / "tests" / "replay"))
from driver import PiRpc  # noqa: E402

ACTIVE_STATES = ("queued", "running")
DIALOGS = ("select", "confirm", "input", "editor")
USAGE_LIMIT = re.compile(r"usage limit|limit reached|hit your (?:usage |session |weekly )?limit|quota exceeded", re.I)


def usage_limit_error(record):
    """The provider's error text when this RPC record / session entry is an assistant message
    that failed with a usage-limit answer, else None."""
    msg = record.get("message") if isinstance(record.get("message"), dict) else None
    if not msg or msg.get("role") != "assistant":
        return None
    if msg.get("stopReason") != "error":
        return None
    text = str(msg.get("errorMessage") or "")
    return text if USAGE_LIMIT.search(text) else None


def async_runs(temp_root):
    """[{runId, state, startedAt, lastUpdate, mtime}] for every pi-subagents async run dir."""
    base = Path(temp_root) / "async-subagent-runs"
    out = []
    if not base.is_dir():
        return out
    for d in sorted(base.iterdir()):
        if not d.is_dir() or d.name.startswith("."):
            continue
        st = d / "status.json"
        rec = {"runId": d.name, "state": None, "mtime": None}
        try:
            rec["mtime"] = st.stat().st_mtime
            data = json.loads(st.read_text("utf-8"))
            rec.update({"state": data.get("state"), "startedAt": data.get("startedAt"), "lastUpdate": data.get("lastUpdate")})
        except (OSError, ValueError):
            pass
        out.append(rec)
    return out


def active(runs):
    return [r for r in runs if r["state"] is None or r["state"] in ACTIVE_STATES]


def empty_dir_check(path):
    p = Path(path)
    return {"path_set": bool(path), "exists": p.is_dir(), "empty": p.is_dir() and not any(p.iterdir())}


def write_json(path, data):
    Path(path).write_text(json.dumps(data, indent=1, sort_keys=True), "utf-8")


def read_secret(path):
    """Read and delete the token file the agent uploaded (never logged, never copied to /logs)."""
    if not path or not os.path.isfile(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return fh.read().strip() or None
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass


def build_world(args, row):
    """Agent dir with foreman.json + settings.json (foreman rows) or settings.json only (plain)."""
    root = Path(args.work)
    agent = root / "agent"
    for d in (agent, root / "sessions", root / "tmp", root / "subagents"):
        d.mkdir(parents=True, exist_ok=True)
    packages = list(row.get("_packages") or [])
    settings = {"packages": packages}
    if row.get("agent") == "foreman":
        l2 = {"version": 1, "providers": {row["provider"]: {"roles": row["roles"]}}, "trace": {"enabled": True}}
        if row.get("_required_child_extensions"):
            l2["safety"] = {"requiredChildExtensions": row["_required_child_extensions"]}
        write_json(agent / "foreman.json", l2)
        gen = subprocess.run([sys.executable, str(REPO / "scripts" / "foreman_config.py"), "generate-subagents", "--json",
                              "--agent-dir", str(agent), "--project-dir", args.cwd],
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120)
        if gen.returncode != 0:
            raise RuntimeError("generate-subagents failed: %s" % gen.stderr.decode("utf-8", "replace")[-800:])
        settings["subagents"] = json.loads(gen.stdout.decode("utf-8"))["subagents"]
    write_json(agent / "settings.json", settings)
    return agent


def pi_env(args, agent, secret):
    root = Path(args.work)
    claude_dir = Path(tempfile.mkdtemp(prefix="claude-config-", dir=str(root)))
    env = {k: v for k, v in os.environ.items() if not k.upper().startswith(("PI_", "FOREMAN_", "CLAUDE_", "ANTHROPIC_"))}
    env.update({"PI_CODING_AGENT_DIR": str(agent), "PI_SUBAGENTS_TEMP_ROOT": str(root / "subagents"),
                "TMPDIR": str(root / "tmp"), "TEMP": str(root / "tmp"), "TMP": str(root / "tmp"),
                "CLAUDE_CONFIG_DIR": str(claude_dir)})
    if args.fake_script:
        env["FOREMAN_FAKE_SCRIPT"] = args.fake_script
    if secret:
        env["CLAUDE_CODE_OAUTH_TOKEN"] = secret
    return env


def pi_args(args, row, mode_args):
    cmd = [shutil.which("pi") or "pi"] + mode_args + ["--approve", "--model", row["model"], "--session-dir", str(Path(args.work) / "sessions")]
    if row.get("thinking"):
        cmd += ["--thinking", row["thinking"]]
    for ext in row.get("_extensions") or []:
        cmd += ["-e", ext]
    return cmd


def drive_rpc(args, row, env, status):
    """Drive `pi --mode rpc` until the done condition, the cap, or a usage-limit answer."""
    rpc_log = open(Path(args.out) / "rpc.jsonl", "w", encoding="utf-8")
    pi = PiRpc(pi_args(args, row, ["--mode", "rpc"]), cwd=args.cwd, env=env)
    temp_root = env["PI_SUBAGENTS_TEMP_ROOT"]
    t0 = time.time()
    deadline = t0 + args.cap_seconds
    last_activity = t0
    settled = False
    seen_mtimes = {}
    status["asks"] = 0
    try:
        pi.send({"id": "bench-prompt", "type": "prompt", "message": Path(args.instruction_file).read_text("utf-8")})
        while True:
            now = time.time()
            if now > deadline:
                status["status"] = "cap_reached"
                break
            try:
                rec = pi._next(min(deadline, now + 1.0))
            except TimeoutError:
                rec = None
            except EOFError:
                status["status"] = "pi_exited"
                break
            if rec is not None:
                last_activity = time.time()
                if rec.get("type") != "message_update":
                    rpc_log.write(json.dumps(rec) + "\n")
                if rec.get("type") == "extension_ui_request" and rec.get("method") in DIALOGS:
                    status["asks"] += 1  # guard asks are denied: the benchmark has no human
                    pi.send({"type": "extension_ui_response", "id": rec["id"], "cancelled": True})
                if rec.get("type") == "response" and rec.get("id") == "bench-prompt" and not rec.get("success"):
                    status["status"] = "prompt_rejected"
                    status["error"] = str(rec.get("error"))[:500]
                    break
                if rec.get("type") == "agent_start":
                    settled = False
                elif rec.get("type") == "agent_settled":
                    settled = True
                limit = usage_limit_error(rec) if rec.get("type") == "message_end" else None
                if limit:
                    status["status"] = "infra_error"
                    status["infra_error"] = "usage_limit"
                    status["error"] = limit[:500]
                    break
                continue
            runs = async_runs(temp_root)
            for r in runs:
                if r["mtime"] and seen_mtimes.get(r["runId"]) != r["mtime"]:
                    seen_mtimes[r["runId"]] = r["mtime"]
                    last_activity = time.time()
            if active(runs):
                last_activity = time.time()
                continue
            if settled and time.time() - last_activity >= args.quiet_seconds:
                st = pi.request({"type": "get_state"})
                if not st.get("isStreaming") and not st.get("pendingMessageCount"):
                    status["status"] = "done"
                    break
                settled = False
    finally:
        status["pi_seconds"] = round(time.time() - t0, 3)
        status["async_runs_at_end"] = async_runs(temp_root)
        status["waiter_end_ms"] = int(time.time() * 1000)
        pi.close()
        rpc_log.close()


def drive_print(args, row, env, status):
    """`pi --print --mode json`, like Harbor's stock Pi adapter: return when Pi exits."""
    t0 = time.time()
    cmd = pi_args(args, row, ["--print", "--mode", "json"]) + [Path(args.instruction_file).read_text("utf-8")]
    try:
        r = subprocess.run(cmd, cwd=args.cwd, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                           stderr=subprocess.PIPE, timeout=args.cap_seconds)
        status["status"] = "done" if r.returncode == 0 else "pi_exit_%d" % r.returncode
        out = r.stdout.decode("utf-8", "replace")
    except subprocess.TimeoutExpired as e:
        status["status"] = "cap_reached"
        out = (e.stdout or b"").decode("utf-8", "replace")
    with open(Path(args.out) / "rpc.jsonl", "w", encoding="utf-8") as fh:
        for line in out.splitlines():
            if '"type":"message_update"' in line:
                continue
            fh.write(line + "\n")
            try:
                limit = usage_limit_error(json.loads(line))
            except ValueError:
                limit = None
            if limit:
                status.update({"status": "infra_error", "infra_error": "usage_limit", "error": limit[:500]})
    status["pi_seconds"] = round(time.time() - t0, 3)
    status["async_runs_at_end"] = async_runs(env["PI_SUBAGENTS_TEMP_ROOT"])
    status["waiter_end_ms"] = int(time.time() * 1000)


def collect(args, agent, status):
    """Copy session files and traces to --out; scan child sessions for a usage-limit answer."""
    out = Path(args.out)
    sessions = out / "sessions"
    for src in (Path(args.work) / "sessions", agent / "sessions"):
        if src.is_dir():
            shutil.copytree(str(src), str(sessions / src.parent.name), dirs_exist_ok=True)
    state = agent / "pi-foreman" / "state"
    if state.is_dir():
        (out / "trace").mkdir(exist_ok=True)
        for f in state.glob("trace-*.jsonl"):
            shutil.copy2(str(f), str(out / "trace" / f.name))
    if status.get("infra_error"):
        return
    for f in sessions.rglob("*.jsonl"):
        if "subagent-artifacts" in f.parts:
            continue
        for line in f.read_text("utf-8", "replace").splitlines():
            try:
                limit = usage_limit_error(json.loads(line))
            except ValueError:
                continue
            if limit:
                status.update({"status": "infra_error", "infra_error": "usage_limit", "error": limit[:500]})
                return


def versions(row):
    v = {}
    try:
        v["pi"] = subprocess.run([shutil.which("pi") or "pi", "--version"], stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                 timeout=60).stdout.decode().strip().splitlines()[-1]
    except (OSError, subprocess.SubprocessError, IndexError):
        v["pi"] = None
    for pkg in row.get("_packages") or []:
        try:
            meta = json.loads((Path(pkg) / "package.json").read_text("utf-8"))
            v[meta.get("name", pkg)] = meta.get("version")
        except (OSError, ValueError):
            pass
    return v


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--row", required=True, help="row JSON file (written by harbor_agent.py)")
    ap.add_argument("--instruction-file", required=True)
    ap.add_argument("--cwd", required=True)
    ap.add_argument("--work", required=True, help="scratch root for agent dir, sessions, tmp")
    ap.add_argument("--out", required=True)
    ap.add_argument("--driver", choices=("rpc", "print"), default="rpc")
    ap.add_argument("--cap-seconds", type=float, default=1800.0)
    ap.add_argument("--quiet-seconds", type=float, default=10.0)
    ap.add_argument("--fake-script", default=None)
    ap.add_argument("--secret-file", default=None)
    args = ap.parse_args(argv)
    row = json.loads(Path(args.row).read_text("utf-8"))
    Path(args.out).mkdir(parents=True, exist_ok=True)
    status = {"driver": args.driver, "row": row.get("id"), "waiter_start_ms": int(time.time() * 1000)}
    secret = read_secret(args.secret_file)
    agent = build_world(args, row)
    env = pi_env(args, agent, secret)
    status["claude_config_dir"] = empty_dir_check(env["CLAUDE_CONFIG_DIR"])
    status["oauth_token_present"] = bool(secret)
    status["versions"] = versions(row)
    if not status["claude_config_dir"]["empty"]:
        status["status"] = "setup_error"
        status["error"] = "CLAUDE_CONFIG_DIR is not a fresh empty dir"
    else:
        (drive_rpc if args.driver == "rpc" else drive_print)(args, row, env, status)
        collect(args, agent, status)
    write_json(Path(args.out) / "bench-run.json", status)
    print(json.dumps({k: status.get(k) for k in ("status", "infra_error", "pi_seconds")}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
