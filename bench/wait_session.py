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

`--setup-check` sends no prompt and calls no model: it builds the same agent dir and Pi env
(without the token), runs `pi --list-models` and the Agent SDK's native `claude --version`,
checks that CLAUDE_CONFIG_DIR is a fresh empty dir and stats the token file (mode, owner,
size; never read), then deletes the token file. Results go to bench-run.json `setup_check`.

A provider answer "usage limit reached" ends the session at once and is recorded as an
infrastructure error, not as a task result. A provider refusal ("safeguards flagged this
message") is recorded as infra_error "provider_refusal" and does not stop the session.
Human dialogs (select, confirm, input, editor) are denied explicitly, never confirmed (except the
plan checkpoint select, answered `approve`), and
listed in bench-run.json `asks_denied`; the whole pi-foreman state dir is copied to state/.

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

# A provider refusal (safety classifier) is an infrastructure error too, but it does not stop the run.
PROVIDER_REFUSAL = re.compile(r"safeguards flagged|flagged this message", re.I)


def _error_text(record, pattern):
    msg = record.get("message") if isinstance(record.get("message"), dict) else None
    if not msg or msg.get("role") != "assistant" or msg.get("stopReason") != "error":
        return None
    text = str(msg.get("errorMessage") or "")
    return text if pattern.search(text) else None


def usage_limit_error(record):
    """The provider's error text when this RPC record / session entry is an assistant message
    that failed with a usage-limit answer, else None."""
    return _error_text(record, USAGE_LIMIT)


def provider_refusal_error(record):
    """Like usage_limit_error, for a provider refusal ("safeguards flagged this message")."""
    return _error_text(record, PROVIDER_REFUSAL)


CHECKPOINT_PREFIX = "pi-foreman checkpoint:"
CHECKPOINT_ANSWERS = ["approve", "reject", "revise"]


def deny_response(rec):
    """The extension_ui_response that denies one dialog request; never confirms. One exception: the plan
    checkpoint `select` (title starts with `pi-foreman checkpoint:` and the options are exactly approve,
    revise and reject, in any order) is answered `approve`, so a heavy
    bench run can proceed; the harness records it as by "rig" (`checkpoint_auto`)."""
    base = {"type": "extension_ui_response", "id": rec.get("id")}
    method = rec.get("method")
    options = rec.get("options")
    if (method == "select" and str(rec.get("title") or "").startswith(CHECKPOINT_PREFIX)
            and isinstance(options, list) and all(isinstance(o, str) for o in options)
            and sorted(options) == CHECKPOINT_ANSWERS):
        return dict(base, value="approve")
    if method == "select":
        options = [o if isinstance(o, str) else str((o or {}).get("label") or (o or {}).get("value") or "")
                   for o in rec.get("options") or []]
        for o in options:
            if o.strip().lower() == "no":
                return dict(base, value=o)
        return dict(base, cancelled=True)
    if method == "confirm":
        return dict(base, confirmed=False)
    return dict(base, cancelled=True)


def note_refusal(status, text):
    """First refusal wins; a usage limit already recorded is not overwritten."""
    if not status.get("infra_error"):
        status.update({"status": "infra_error", "infra_error": "provider_refusal", "error": text[:200]})


ROLE_IDS = ("senior-reviewer", "finalizer", "explorer", "planner", "builder", "reviewer", "foreman")
FAKE_REVIEW_MODEL = "review-defer"  # never auto-allows: the ask reaches the dialog


KEEP_ASK_LINES = re.compile(r"^\s*(tool|subagent|rule)\s*:", re.I)
DROP_ASK_LINES = re.compile(r"^\s*(command|full command|input)\s*:", re.I)


def ask_title(title):
    """The title's first line plus its `tool :` / `subagent :` / `rule :` lines. A `command :`,
    `full command :` or `input :` line, and everything after it, is dropped (no command text in the record)."""
    lines = str(title or "").splitlines()
    out = lines[:1]
    for line in lines[1:]:
        if DROP_ASK_LINES.match(line):
            break
        if KEEP_ASK_LINES.match(line):
            out.append(line)
    return "\n".join(out)[:200]


def ask_role(rec):
    """Best effort: the role id named in a dialog request (a forwarded child ask names its agent), else None."""
    text = "%s %s" % (rec.get("title") or "", rec.get("message") or "")
    hit = re.search(r"(?:sub-?agent|child|agent)\W+(%s)\b" % "|".join(ROLE_IDS), text, re.I)
    return hit.group(1).lower() if hit else None


def foreman_config(row):
    """The user-layer foreman.json for a foreman row: the row's roles (incl. builder.strong),
    the review model (the row's review_model, else the reviewer role's model; the fake provider's
    non-allowing review model for fake rows), trace on, and the row's `project_commands` as
    safety.permissions.projectCommands. The row's `foreman_edits` becomes ceremony.foremanEdits; ceremony.requireTriage
    stays at its default. The row's `user_config` object is deep-merged in last, so a preset can set any knob."""
    provider = row["provider"]
    roles = row["roles"]
    review = row.get("review_model")
    if not review:
        if row.get("_fake"):
            review = "%s/%s" % (provider, FAKE_REVIEW_MODEL)
        else:
            review = (roles.get("reviewer") or {}).get("model")
    block = {"roles": roles}
    if review:
        block["review"] = {"model": review}
    l2 = {"version": 1, "providers": {provider: block}, "trace": {"enabled": True}}
    if row.get("_required_child_extensions"):
        l2["safety"] = {"requiredChildExtensions": row["_required_child_extensions"]}
    if row.get("foreman_edits"):
        l2["ceremony"] = {"foremanEdits": row["foreman_edits"]}
    for key, name in (("foreman_reads", "foremanReads"), ("recheck_budget", "recheckBudget"),
                      ("launch_wait", "launchWait"), ("dedupe_notify", "dedupeNotify")):
        if key in row:  # ceremony knobs of the frugality work, forwarded as given
            l2.setdefault("ceremony", {})[name] = row[key]
    if row.get("project_commands"):  # the repo's test/build commands, as an owner would set them
        l2.setdefault("safety", {})["permissions"] = {"projectCommands": list(row["project_commands"])}
    if isinstance(row.get("user_config"), dict):
        _deep_merge(l2, row["user_config"])
    return l2


def _deep_merge(base, extra):
    """Merge `extra` into `base` in place: objects merge key by key, anything else replaces."""
    for key, value in extra.items():
        if isinstance(value, dict) and isinstance(base.get(key), dict):
            _deep_merge(base[key], value)
        else:
            base[key] = value


POST_STEP_COMMANDS = {"retro": "/retro", "sync": "/sync --dry-run"}
POST_MARKER = "bench-post-marker.json"  # in the agent state dir: {"ms", "ts"}; usage from then on is the post steps'
POST_STEP_CAP = 300.0  # seconds per step
HASH_FULL_BYTES = 8 * 1024 * 1024  # larger files are hashed by size only


def post_steps_of(row):
    """The row's `bench.post_steps` (default none): names of POST_STEP_COMMANDS run after the task is done."""
    steps = (row.get("bench") or {}).get("post_steps") if isinstance(row.get("bench"), dict) else None
    return [str(x) for x in steps] if isinstance(steps, list) else []


def workspace_hash(root):
    """sha256 over the file tree below root (relative path + content), .git excluded; files above
    HASH_FULL_BYTES count by size. Symlinks are hashed by target. A missing root hashes as empty."""
    import hashlib
    h = hashlib.sha256()
    base = Path(root)
    for dirpath, dirs, files in os.walk(str(base)):
        dirs[:] = sorted(d for d in dirs if d != ".git")
        for name in sorted(files):
            f = Path(dirpath) / name
            h.update(f.relative_to(base).as_posix().encode("utf-8", "replace") + b"\0")
            try:
                if f.is_symlink():
                    h.update(b"L" + os.readlink(str(f)).encode("utf-8", "replace"))
                elif f.stat().st_size > HASH_FULL_BYTES:
                    h.update(b"S%d" % f.stat().st_size)
                else:
                    h.update(f.read_bytes())
            except OSError:
                h.update(b"?")
    return h.hexdigest()


def run_post_step(pi, index, command, quiet_seconds, cap_seconds, clock=time.time, rpc_log=None):
    """Send one slash command to the idle foreman session and wait until it is idle again; returns the captured
    text (notify messages, assistant text) and an error string or None. Dialogs are denied like in the main drive."""
    rid = "bench-post-%d" % index
    pi.send({"id": rid, "type": "prompt", "message": command})
    started = last = clock()
    got, texts, err, settled = False, [], None, False
    while clock() - started < cap_seconds:
        try:
            rec = pi._next(1.0)
        except TimeoutError:
            rec = None
        except EOFError:
            return "\n".join(texts), "pi_exited"
        if rec is None:
            if got and (settled or clock() - last >= quiet_seconds):
                st = pi.request({"type": "get_state"})
                if not st.get("isStreaming") and not st.get("pendingMessageCount"):
                    return "\n".join(texts), err
                settled = False
            continue
        last = clock()
        if rpc_log is not None and rec.get("type") != "message_update":
            rpc_log.write(json.dumps(rec) + "\n")
        kind = rec.get("type")
        if kind == "extension_ui_request":
            if rec.get("method") in DIALOGS:
                pi.send(deny_response(rec))
            elif rec.get("message"):
                texts.append(str(rec["message"]))
        elif kind == "response" and rec.get("id") == rid:
            got = True
            if not rec.get("success"):
                err = str(rec.get("error") or "rejected")[:300]
        elif kind == "agent_start":
            settled = False
        elif kind == "agent_settled":
            settled = True
        elif kind == "message_end":
            msg = rec.get("message") if isinstance(rec.get("message"), dict) else {}
            if msg.get("role") == "assistant":
                texts += [str(c.get("text")) for c in msg.get("content") or [] if isinstance(c, dict) and c.get("type") == "text"]
    return "\n".join(texts), err or "step_cap_reached"


def run_post_steps(pi, row, cwd, state_dir, status, quiet_seconds, cap_seconds=POST_STEP_CAP, clock=time.time, rpc_log=None):
    """After the task is done: hash the workspace, write the usage marker, run the row's post steps in the foreman
    session, hash again. Outputs go to <state_dir>/post-steps/<step>.txt, never the workspace. A changed workspace
    marks the cell infra `post_step_changed_workspace` (an earlier infra error is kept). Records status["post_steps"]."""
    steps = post_steps_of(row)
    if not steps:
        return
    state = Path(state_dir)
    state.mkdir(parents=True, exist_ok=True)
    before = workspace_hash(cwd)
    now = clock()
    write_json(state / POST_MARKER, {"ms": int(now * 1000), "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now))})
    results = []
    for i, step in enumerate(steps):
        command = POST_STEP_COMMANDS.get(step)
        if command is None:
            results.append({"step": step, "error": "unknown_step"})
            continue
        text, err = run_post_step(pi, i, command, quiet_seconds, cap_seconds, clock, rpc_log)
        out = state / "post-steps"
        out.mkdir(parents=True, exist_ok=True)
        (out / ("%s.txt" % step)).write_text(text + "\n", "utf-8")
        results.append({"step": step, "chars": len(text), **({"error": err} if err else {})})
    changed = workspace_hash(cwd) != before
    status["post_steps"] = {"steps": results, "workspace_changed": changed}
    if changed and not status.get("infra_error"):
        status["infra_error"] = "post_step_changed_workspace"


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
            rec.update({"state": data.get("state"), "startedAt": data.get("startedAt"), "lastUpdate": data.get("lastUpdate"),
                        "agents": [s.get("agent") for s in data.get("steps") or [] if isinstance(s, dict)] or
                        ([data["agent"]] if isinstance(data.get("agent"), str) else [])})
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
    for d in (agent, agent / "pi-foreman" / "state", root / "sessions", root / "tmp", root / "subagents"):
        d.mkdir(parents=True, exist_ok=True)
    packages = list(row.get("_packages") or [])
    settings = {"packages": packages}
    if row.get("agent") == "foreman":
        write_json(agent / "foreman.json", foreman_config(row))
        gen = subprocess.run([sys.executable, str(REPO / "scripts" / "foreman_config.py"), "generate-subagents", "--json",
                              "--agent-dir", str(agent), "--project-dir", args.cwd],
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120)
        if gen.returncode != 0:
            raise RuntimeError("generate-subagents failed: %s" % gen.stderr.decode("utf-8", "replace")[-800:])
        settings["subagents"] = json.loads(gen.stdout.decode("utf-8"))["subagents"]
        if row.get("_permission_system"):  # same render the installer runs (setup.mjs)
            pg = subprocess.run([sys.executable, str(REPO / "scripts" / "permissions_gen.py"), "render", "--agent-dir", str(agent)],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120)
            if pg.returncode != 0:
                raise RuntimeError("permissions_gen failed: %s" % pg.stderr.decode("utf-8", "replace")[-800:])
            cfg = agent / "extensions" / "pi-permission-system" / "config.json"
            cfg.parent.mkdir(parents=True, exist_ok=True)
            rendered = json.loads(pg.stdout.decode("utf-8"))["config"]
            # Opt-in rig-side extras (row key `permission_tools_allow`), e.g. bash for the scripted
            # fake rows. foreman_triage is in the baseline since 17a3412.
            for tool in row.get("permission_tools_allow") or []:
                rendered.setdefault("permission", {})[tool] = "allow"
            write_json(cfg, rendered)
    write_json(agent / "settings.json", settings)
    return agent


SCRUB = ("PI_", "FOREMAN_", "CLAUDE_", "ANTHROPIC_")


def pi_env(args, agent, secret):
    root = Path(args.work)
    claude_dir = Path(tempfile.mkdtemp(prefix="claude-config-", dir=str(root)))
    # Inherited ANTHROPIC_* / CLAUDE_* vars would redirect the bridge's Claude child (bridge
    # issue #107), so none reach Pi; only the fresh config dir and the token are set.
    env = {k: v for k, v in os.environ.items() if not k.upper().startswith(SCRUB)}
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
    status["asks_denied"] = []
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
                    status["asks"] += 1  # the benchmark has no human: deny explicitly, keep the session running
                    status.setdefault("asks_denied", []).append(
                        {"method": rec.get("method"), "title": ask_title(rec.get("title")), "role": ask_role(rec)})
                    pi.send(deny_response(rec))
                if rec.get("type") == "response" and rec.get("id") == "bench-prompt" and not rec.get("success"):
                    status["status"] = "prompt_rejected"
                    status["error"] = str(rec.get("error"))[:500]
                    break
                if rec.get("type") == "agent_start":
                    settled = False
                elif rec.get("type") == "agent_settled":
                    settled = True
                if rec.get("type") == "message_end":
                    refusal = provider_refusal_error(rec)
                    if refusal:
                        note_refusal(status, refusal)
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
                    if post_steps_of(row):
                        run_post_steps(pi, row, args.cwd, Path(env["PI_CODING_AGENT_DIR"]) / "pi-foreman" / "state", status,
                                       args.quiet_seconds, rpc_log=rpc_log)
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
                rec = json.loads(line)
            except ValueError:
                continue
            if provider_refusal_error(rec):
                note_refusal(status, provider_refusal_error(rec))
            limit = usage_limit_error(rec)
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
    for name in ("foreman.json", "settings.json"):  # the generated config, for the record
        if (agent / name).is_file():
            shutil.copy2(str(agent / name), str(out / ("agent-" + name)))
    state = agent / "pi-foreman" / "state"
    if state.is_dir():
        # The whole state dir (usage log, traces, drift baselines, session markers) for the rig.
        shutil.copytree(str(state), str(out / "state"), dirs_exist_ok=True)
        (out / "trace").mkdir(exist_ok=True)
        for f in state.glob("trace-*.jsonl"):
            shutil.copy2(str(f), str(out / "trace" / f.name))
        # Session markers (session id + bound ledger path) for the task verifiers.
        (out / "state").mkdir(exist_ok=True)
        for f in state.glob("fable-orch-model-*.json"):
            shutil.copy2(str(f), str(out / "state" / f.name))
    runs = Path(args.work) / "subagents" / "async-subagent-runs"
    if runs.is_dir():
        (out / "async-runs").mkdir(exist_ok=True)
        for d in runs.iterdir():
            if (d / "status.json").is_file():
                shutil.copy2(str(d / "status.json"), str(out / "async-runs" / ("%s.json" % d.name)))
    if status.get("infra_error") == "usage_limit":
        return
    for f in sessions.rglob("*.jsonl"):
        if "subagent-artifacts" in f.parts:
            continue
        for line in f.read_text("utf-8", "replace").splitlines():
            try:
                rec = json.loads(line)
            except ValueError:
                continue
            limit = usage_limit_error(rec)
            if limit:
                status.update({"status": "infra_error", "infra_error": "usage_limit", "error": limit[:500]})
                return
            if provider_refusal_error(rec):
                note_refusal(status, provider_refusal_error(rec))


def versions(row):
    v = {}
    try:
        v["pi"] = subprocess.run([shutil.which("pi") or "pi", "--version"], stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                 timeout=60).stdout.decode().strip().splitlines()[-1]
    except (OSError, subprocess.SubprocessError, IndexError):
        v["pi"] = None
    for pkg in list(row.get("_packages") or []) + list(row.get("_version_packages") or []):
        try:
            meta = json.loads((Path(pkg) / "package.json").read_text("utf-8"))
            v[meta.get("name", pkg)] = meta.get("version")
        except (OSError, ValueError):
            pass
    return v


def setup_check(args, row, env):
    """Zero-model install check (no prompt, no token in env)."""
    import glob
    import stat as stat_mod
    res = {"claude_config_dir_before": empty_dir_check(env["CLAUDE_CONFIG_DIR"])}
    res["python"] = {"version": "%d.%d.%d" % sys.version_info[:3], "ok": sys.version_info >= (3, 9)}
    res["permission_system_config"] = (Path(env["PI_CODING_AGENT_DIR"]) / "extensions" / "pi-permission-system" / "config.json").is_file()

    def run(cmd):
        try:
            r = subprocess.run(cmd, env=env, cwd=args.cwd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                               stderr=subprocess.STDOUT, timeout=120)
            return r.returncode, r.stdout.decode("utf-8", "replace")
        except (OSError, subprocess.SubprocessError) as e:
            return None, str(e)

    code, out = run([shutil.which("pi") or "pi", "--list-models"])
    res["list_models_exit"] = code
    res["claude_bridge_models"] = sorted({w for line in out.splitlines() for w in line.split()
                                          if w.startswith("claude-") and w != "claude-bridge"} if "claude-bridge" in out else set())
    res["list_models_lines"] = [l.strip() for l in out.splitlines() if "claude-bridge" in l][:20]
    bins = sorted(glob.glob(row.get("_claude_bin_glob") or "")) if row.get("_claude_bin_glob") else []
    res["claude_bin"] = bins[0] if bins else None
    if bins:
        code, out = run([bins[0], "--version"])
        res["claude_version_exit"] = code
        res["claude_version"] = out.strip().splitlines()[-1] if out.strip() else None
    res["claude_config_dir_after"] = empty_dir_check(env["CLAUDE_CONFIG_DIR"])
    res["scrubbed_env_present"] = sorted(k for k in env if k.upper().startswith(("ANTHROPIC_",)) or
                                         (k.upper().startswith("CLAUDE_") and k != "CLAUDE_CONFIG_DIR"))
    if args.secret_file:
        try:
            st = os.stat(args.secret_file)
            res["token_file"] = {"exists": True, "mode": oct(stat_mod.S_IMODE(st.st_mode)), "size_gt_0": st.st_size > 0,
                                 "owner_is_agent_user": st.st_uid == os.getuid(),
                                 "readable": os.access(args.secret_file, os.R_OK)}
        except OSError:
            res["token_file"] = {"exists": False}
        try:
            os.unlink(args.secret_file)
        except OSError:
            pass
    return res


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
    ap.add_argument("--setup-check", action="store_true", help="no prompt, no model: install checks only")
    args = ap.parse_args(argv)
    row = json.loads(Path(args.row).read_text("utf-8"))
    Path(args.out).mkdir(parents=True, exist_ok=True)
    status = {"driver": args.driver, "row": row.get("id"), "waiter_start_ms": int(time.time() * 1000)}
    if args.setup_check:
        agent = build_world(args, row)
        env = pi_env(args, agent, None)
        status["versions"] = versions(row)
        status["setup_check"] = setup_check(args, row, env)
        status["status"] = "setup_only"
        write_json(Path(args.out) / "bench-run.json", status)
        print(json.dumps({"status": "setup_only"}))
        return 0
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
