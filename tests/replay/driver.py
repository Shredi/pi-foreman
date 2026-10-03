"""Replay driver for pi-foreman (design section 10). Standard library only, Python 3.9+.

Each Rig owns a fresh temp root with:
  agent/    PI_CODING_AGENT_DIR: settings.json (packages: pi-subagents + this repo, the
            generated subagents block) and the L2 foreman.json (fake providers, trace on,
            the fake provider as a required child extension)
  project/  a throwaway git repo, the cwd of every Pi process
  tmp/      TMPDIR/TEMP/TMP for Pi and its detached children
The user's real Pi agent dir is never read or written: PI_CODING_AGENT_DIR always points
into the temp root, and inherited PI_* / FOREMAN_* variables are dropped.

Environment knobs:
  FOREMAN_PI_CLI         path to Pi's cli.js (default: <npm root -g>/@earendil-works/pi-coding-agent/dist/bundle/cli.js)
  FOREMAN_PI_SUBAGENTS   path to an installed pi-subagents package dir (skips the npm install)
  FOREMAN_REPLAY_CACHE   npm prefix used to install pi-subagents once (default: <tempdir>/pi-foreman-replay-cache)
  FOREMAN_REPLAY_KEEP=1  keep temp roots for inspection
"""
from __future__ import annotations

import json
import os
import queue
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
FAKE_PROVIDER = HERE / "fake_provider.ts"
PI_SUBAGENTS_VERSION = "0.75.0"
PROVIDER_A = "foreman-fake"
PROVIDER_B = "foreman-fake-b"
ROLES = ["foreman", "explorer", "builder", "reviewer", "senior-reviewer", "finalizer"]
DIALOGS = ("select", "confirm", "input", "editor")

_npm_root = None


def _run(cmd, timeout, **kw):
    return subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout, **kw)


def _tool(name):
    found = shutil.which(name)
    if not found:
        raise RuntimeError("%s not found on PATH" % name)
    return found


def npm_root_global():
    global _npm_root
    if _npm_root is None:
        r = _run([_tool("npm"), "root", "-g"], 60)
        _npm_root = r.stdout.decode().strip()
    return _npm_root


def pi_cli():
    env = os.environ.get("FOREMAN_PI_CLI")
    cli = Path(env) if env else Path(npm_root_global()) / "@earendil-works" / "pi-coding-agent" / "dist" / "bundle" / "cli.js"
    if not cli.is_file():
        raise RuntimeError("Pi CLI not found at %s (npm install -g @earendil-works/pi-coding-agent@1.0.0 or set FOREMAN_PI_CLI)" % cli)
    return cli


def pi_subagents_dir():
    env = os.environ.get("FOREMAN_PI_SUBAGENTS")
    if env:
        return Path(env).resolve()
    cache = Path(os.environ.get("FOREMAN_REPLAY_CACHE") or Path(tempfile.gettempdir()) / "pi-foreman-replay-cache")
    pkg = cache / "node_modules" / "pi-subagents"
    manifest = pkg / "package.json"
    if not manifest.is_file() or json.loads(manifest.read_text("utf-8")).get("version") != PI_SUBAGENTS_VERSION:
        cache.mkdir(parents=True, exist_ok=True)
        r = _run([_tool("npm"), "install", "--no-audit", "--no-fund", "--prefix", str(cache), "pi-subagents@" + PI_SUBAGENTS_VERSION], 600)
        if r.returncode != 0:
            raise RuntimeError("npm install pi-subagents failed: %s" % r.stderr.decode()[-500:])
    return pkg.resolve()


def deep_merge(base, over):
    out = dict(base)
    for k, v in over.items():
        out[k] = deep_merge(out[k], v) if isinstance(v, dict) and isinstance(out.get(k), dict) else v
    return out


def provider_map(providers):
    return {p: {"roles": {r: {"model": "%s/%s" % (p, r)} for r in ROLES}} for p in providers}


class Rig:
    """One throwaway Pi world: agent dir + project + tmp, plus the processes started in it."""

    def __init__(self, name, script, providers=(PROVIDER_A,), config=None, settings=None):
        self.root = Path(tempfile.mkdtemp(prefix="pf-replay-%s-" % name)).resolve()
        self.agent = self.root / "agent"
        self.project = self.root / "project"
        self.tmp = self.root / "tmp"
        for d in (self.agent, self.project, self.tmp):
            d.mkdir()
        _run(["git", "init", "-q"], 60, cwd=str(self.project))
        self.script = self.root / "script.json"
        self.script.write_text(json.dumps(script, indent=1), "utf-8")
        l2 = {
            "providers": provider_map(providers),
            "trace": {"enabled": True},
            "safety": {"requiredChildExtensions": [str(FAKE_PROVIDER)]},
        }
        if config:
            l2 = deep_merge(l2, config)
        (self.agent / "foreman.json").write_text(json.dumps(l2, indent=1), "utf-8")
        gen = _run([sys.executable, str(REPO / "scripts" / "foreman_config.py"), "generate-subagents", "--json",
                    "--agent-dir", str(self.agent), "--project-dir", str(self.project)], 60)
        if gen.returncode != 0:
            raise RuntimeError("generate-subagents failed: %s" % gen.stderr.decode())
        block = json.loads(gen.stdout.decode())["subagents"]
        st = {"packages": [str(pi_subagents_dir()), str(REPO)], "subagents": block}
        if settings:
            st = deep_merge(st, settings)
        (self.agent / "settings.json").write_text(json.dumps(st, indent=1), "utf-8")
        self.procs = []

    @property
    def state_dir(self):
        return self.agent / "pi-foreman" / "state"

    def env(self, extra=None):
        env = {k: v for k, v in os.environ.items()
               if not k.upper().startswith(("PI_", "FOREMAN_")) and k.upper() not in ("TMPDIR", "TEMP", "TMP")}
        env.update({"PI_CODING_AGENT_DIR": str(self.agent), "FOREMAN_FAKE_SCRIPT": str(self.script),
                    "TMPDIR": str(self.tmp), "TEMP": str(self.tmp), "TMP": str(self.tmp)})
        env.update(extra or {})
        return env

    def pi_args(self, provider, mode_args, extra_args=()):
        return [_tool("node"), str(pi_cli())] + list(mode_args) + ["-e", str(FAKE_PROVIDER), "--model", "%s/foreman" % provider, "--approve"] + list(extra_args)

    def start(self, provider=PROVIDER_A, extra_args=(), env=None):
        p = PiRpc(self.pi_args(provider, ["--mode", "rpc"], extra_args), cwd=self.project, env=self.env(env))
        self.procs.append(p)
        return p

    def run_print(self, prompt, provider=PROVIDER_A, mode="json", timeout=60, extra_args=()):
        """One-shot `pi --mode json|text -p` (text = print mode): returns (exit code, stdout records or text, stderr)."""
        args = self.pi_args(provider, ["--mode", mode, "-p", prompt], extra_args)
        r = subprocess.run(args, cwd=str(self.project), env=self.env(), stdin=subprocess.DEVNULL,
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
        out = r.stdout.decode("utf-8", "replace")
        if mode == "json":
            recs = []
            for line in out.splitlines():
                try:
                    recs.append(json.loads(line))
                except ValueError:
                    pass
            return r.returncode, recs, r.stderr.decode("utf-8", "replace")
        return r.returncode, out, r.stderr.decode("utf-8", "replace")

    # ----------------------------------------------------------------- trace

    def traces(self):
        """{file stem: [records]} for every trace file in the state dir."""
        out = {}
        if not self.state_dir.is_dir():
            return out
        for f in sorted(self.state_dir.glob("trace-*.jsonl")):
            recs = []
            for line in f.read_text("utf-8").splitlines():
                if line.strip():
                    recs.append(json.loads(line))
            out[f.stem] = recs
        return out

    def wait_trace(self, predicate, timeout=60.0, interval=0.25):
        """Poll the trace files until predicate(traces) is truthy; return the traces."""
        deadline = time.time() + timeout
        while True:
            t = self.traces()
            if predicate(t):
                return t
            if time.time() > deadline:
                raise TimeoutError("trace condition not met within %.0fs: %s" % (timeout, json.dumps(t)[:2000]))
            time.sleep(interval)

    def close(self):
        for p in self.procs:
            p.close()
        if os.environ.get("FOREMAN_REPLAY_KEEP") == "1":
            sys.stderr.write("replay: kept %s\n" % self.root)
            return
        tmp_root = Path(tempfile.gettempdir()).resolve()
        if tmp_root in self.root.parents and self.root.name.startswith("pf-replay-"):
            for _ in range(5):
                try:
                    shutil.rmtree(str(self.root))
                    return
                except OSError:
                    time.sleep(0.5)  # Windows: a detached child may still hold a handle


class PiRpc:
    """`pi --mode rpc` with stdin kept open. JSONL split on LF only (see Pi docs/rpc.md)."""

    def __init__(self, args, cwd, env):
        kw = {}
        if os.name == "nt":
            kw["creationflags"] = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
        self.proc = subprocess.Popen(args, cwd=str(cwd), env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.PIPE, **kw)
        self.records = queue.Queue()
        self.stderr = []
        self.seen = []
        self._n = 0
        threading.Thread(target=self._read_out, daemon=True).start()
        threading.Thread(target=self._read_err, daemon=True).start()

    def _read_out(self):
        buf = b""
        while True:
            chunk = self.proc.stdout.read1(65536) if hasattr(self.proc.stdout, "read1") else self.proc.stdout.read(1)
            if not chunk:
                break
            buf += chunk
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                line = line.rstrip(b"\r")
                if line:
                    try:
                        self.records.put(json.loads(line.decode("utf-8")))
                    except ValueError:
                        pass
        self.records.put(None)

    def _read_err(self):
        for line in self.proc.stderr:
            self.stderr.append(line.decode("utf-8", "replace").rstrip())

    def send(self, record):
        self.proc.stdin.write((json.dumps(record) + "\n").encode("utf-8"))
        self.proc.stdin.flush()

    def next_id(self):
        self._n += 1
        return "req-%d" % self._n

    def _next(self, deadline):
        left = deadline - time.time()
        if left <= 0:
            raise TimeoutError("no RPC record in time; stderr tail: %s" % "\n".join(self.stderr[-15:]))
        try:
            rec = self.records.get(timeout=left)
        except queue.Empty:
            raise TimeoutError("no RPC record in time; stderr tail: %s" % "\n".join(self.stderr[-15:]))
        if rec is None:
            raise EOFError("pi exited (code %s); stderr tail: %s" % (self.proc.poll(), "\n".join(self.stderr[-15:])))
        self.seen.append(rec)
        return rec

    def _answer(self, rec, answers):
        if rec.get("type") == "extension_ui_request" and rec.get("method") in DIALOGS:
            ans = dict(answers.pop(0)) if answers else {"cancelled": True}
            ans.update({"type": "extension_ui_response", "id": rec["id"]})
            self.send(ans)

    def prompt(self, text, answers=None, timeout=60.0):
        """Send a prompt and collect records until `agent_settled` (or a handled disposition)."""
        answers = list(answers or [])
        rid = self.next_id()
        self.send({"id": rid, "type": "prompt", "message": text})
        deadline = time.time() + timeout
        out = []
        handled = False
        while True:
            try:
                rec = self._next(deadline)
            except TimeoutError:
                if handled:
                    return out
                raise
            out.append(rec)
            self._answer(rec, answers)
            if rec.get("type") == "response" and rec.get("id") == rid:
                if not rec.get("success"):
                    raise RuntimeError("prompt rejected: %s" % rec.get("error"))
                if (rec.get("data") or {}).get("disposition") == "handled":
                    # A command ran instead of a model turn: collect its notifications briefly.
                    handled = True
                    deadline = min(deadline, time.time() + 1.0)
            if rec.get("type") == "agent_settled" and not handled:
                return out

    def request(self, record, timeout=15.0):
        """Send a non-prompt command and return its response data."""
        rid = self.next_id()
        self.send(dict(record, id=rid))
        deadline = time.time() + timeout
        while True:
            rec = self._next(deadline)
            if rec.get("type") == "response" and rec.get("id") == rid:
                if not rec.get("success"):
                    raise RuntimeError("%s failed: %s" % (record.get("type"), rec.get("error")))
                return rec.get("data") or {}

    def session_id(self):
        return self.request({"type": "get_state"})["sessionId"]

    def wait_child_notify(self, timeout=90.0, answers=None):
        """Wait for a detached child's completion notice and the parent run it triggers to settle.
        Returns (notice text, records)."""
        answers = list(answers or [])
        deadline = time.time() + timeout
        out, notice = [], None
        while True:
            rec = self._next(deadline)
            out.append(rec)
            self._answer(rec, answers)
            msg = rec.get("message") if isinstance(rec.get("message"), dict) else {}
            if rec.get("type") == "message_end" and msg.get("customType") == "subagent-notify":
                notice = msg.get("content") if isinstance(msg.get("content"), str) else json.dumps(msg.get("content"))
            if notice is not None and rec.get("type") == "agent_settled":
                return notice, out

    def drain(self, seconds, answers=None):
        """Collect whatever arrives in the next `seconds` (answering dialogs)."""
        answers = list(answers or [])
        deadline = time.time() + seconds
        out = []
        while True:
            try:
                rec = self._next(deadline)
            except TimeoutError:
                return out
            out.append(rec)
            self._answer(rec, answers)

    def close(self, timeout=15.0):
        if self.proc.poll() is not None:
            return
        try:
            self.proc.stdin.close()
        except OSError:
            pass
        try:
            self.proc.wait(timeout)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait(5)


# ------------------------------------------------------------------ helpers

def tool_results(records, tool=None):
    """[(toolName, isError, text)] from tool_execution_end records."""
    out = []
    for r in records:
        if r.get("type") != "tool_execution_end":
            continue
        if tool and r.get("toolName") != tool:
            continue
        res = r.get("result") or {}
        text = "\n".join(c.get("text", "") for c in res.get("content") or [] if isinstance(c, dict))
        out.append((r.get("toolName"), bool(r.get("isError")), text))
    return out


def notifications(records):
    return [r.get("message", "") for r in records if r.get("type") == "extension_ui_request" and r.get("method") == "notify"]


def shape(records, keys=("event", "role", "toolFamily", "guard", "decision", "model", "tier", "exit")):
    """Golden-comparable view of trace records: volatile fields (ts, latency, tokens, cost) dropped."""
    return [{k: r[k] for k in keys if k in r} for r in records]


PAD = "synthetic filler text for an over-threshold delegation. " * 30  # > 1500 characters


def load_fixture(name):
    """Fixture script with {{PAD}} expanded (keeps the JSON files readable)."""
    raw = (HERE / "fixtures" / (name + ".json")).read_text("utf-8")
    return json.loads(raw.replace("{{PAD}}", PAD.strip()))


def marker(rig, session_id):
    """The adapter's session marker (fable-orch-model-<sid>.json) as a dict, or None."""
    sid = "".join(c for c in session_id if c.isalnum() or c in "-_")
    f = rig.state_dir / ("fable-orch-model-%s.json" % sid)
    return json.loads(f.read_text("utf-8")) if f.is_file() else None


def trace_of(traces, role, model=None):
    """Records of the first trace whose session_start has this role (and model prefix)."""
    for recs in traces.values():
        head = recs[0] if recs else {}
        if head.get("event") == "session_start" and head.get("role") == role and (model is None or str(head.get("model", "")).startswith(model)):
            return recs
    return None


def load_golden(name):
    return json.loads((HERE / "golden" / (name + ".json")).read_text("utf-8"))
