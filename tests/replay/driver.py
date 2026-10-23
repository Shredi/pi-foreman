"""Replay driver for pi-foreman (design section 10). Standard library only, Python 3.9+.

Each Rig owns a fresh temp root with:
  agent/    PI_CODING_AGENT_DIR: settings.json (packages: this repo, which bundles pi-subagents, the permission system and pi-intercom; the
            generated subagents block) and the L2 foreman.json (fake providers, trace on,
            the fake provider as a required child extension)
  project/  a throwaway git repo, the cwd of every Pi process
  tmp/      TMPDIR/TEMP/TMP for Pi and its detached children
The user's real Pi agent dir is never read or written: PI_CODING_AGENT_DIR always points
into the temp root, and inherited PI_* / FOREMAN_* variables are dropped.

Environment knobs:
  FOREMAN_PI_CLI         path to Pi's cli.js; wins over the defaults, which are tried in order:
                         <npm root -g>/@earendil-works/pi-coding-agent/dist/bundle/cli.js, then Pi's managed
                         install ~/.pi/agent/install/releases/<current-version>/node_modules/
                         @earendil-works/pi-coding-agent/dist/cli.js (read-only; <current-version> from
                         ~/.pi/agent/install/current-version)
  FOREMAN_REPLAY_KEEP=1  keep temp roots for inspection
"""
from __future__ import annotations

import json
import os
import queue
import re
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
PROVIDER_A = "foreman-fake"
PROVIDER_B = "foreman-fake-b"
ROLES = ["foreman", "planner", "explorer", "builder", "reviewer", "senior-reviewer", "finalizer"]
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


PI_PACKAGE = ("@earendil-works", "pi-coding-agent")


def _pi_pin():
    """(version, range) from packages.lock.json, so the install hint follows the supported range."""
    try:
        pi = json.loads((REPO / "packages.lock.json").read_text("utf-8"))["pi"]
        return pi["version"], pi["range"]
    except (OSError, ValueError, KeyError, TypeError):
        return "<pinned>", "<supported>"


def pi_cli_candidates(environ=None, npm_root=None, home=None):
    """Pi CLI paths to try, in order. FOREMAN_PI_CLI, when set, is the only candidate. Otherwise the global
    npm install, then Pi's managed install (the user's ~/.pi/agent; the rig's temp agent dir has none).
    `npm_root` may be a callable (called lazily); a failing npm lookup just drops that candidate."""
    environ = os.environ if environ is None else environ
    explicit = environ.get("FOREMAN_PI_CLI")
    if explicit:
        return [Path(explicit)]
    out = []
    root = npm_root_global if npm_root is None else npm_root
    try:
        root = root() if callable(root) else root
    except (OSError, RuntimeError, subprocess.SubprocessError):
        root = None
    if root:
        out.append(Path(root).joinpath(*PI_PACKAGE, "dist", "bundle", "cli.js"))
    install = (Path.home() if home is None else Path(home)) / ".pi" / "agent" / "install"
    try:
        current = (install / "current-version").read_text("utf-8").strip()
    except OSError:
        current = ""
    if current and "/" not in current and "\\" not in current and current not in (".", ".."):
        out.append(install.joinpath("releases", current, "node_modules", *PI_PACKAGE, "dist", "cli.js"))
    else:
        out.append(install / "current-version")  # named in the error so the reader sees where it looked
    return out


def resolve_pi_cli(environ=None, npm_root=None, home=None):
    """First existing candidate; RuntimeError naming every path tried otherwise."""
    tried = pi_cli_candidates(environ, npm_root, home)
    for cli in tried:
        if cli.name == "cli.js" and cli.is_file():
            return cli
    version, rng = _pi_pin()
    raise RuntimeError("Pi CLI not found; tried: %s (Pi %s is supported: npm install -g @earendil-works/pi-coding-agent@%s, "
                       "or set FOREMAN_PI_CLI to its cli.js)" % (", ".join(str(p) for p in tried), rng, version))


def pi_cli():
    return resolve_pi_cli()


def bundled_check():
    """The repo package entry brings pi-subagents, the permission system and pi-intercom from <repo>/node_modules."""
    for rel in ("pi-subagents", "@gotgenes/pi-permission-system", "pi-intercom"):
        if not (REPO / "node_modules" / rel / "package.json").is_file():
            raise RuntimeError("%s missing under %s (run npm install in the repo)" % (rel, REPO / "node_modules"))


# permissions="open" keeps the older scenarios unchanged; "baseline" is what the installer writes.
OPEN_PERMISSIONS = {"permission": {"*": "allow", "bash": {"*": "allow"}}}


def deep_merge(base, over):
    out = dict(base)
    for k, v in over.items():
        out[k] = deep_merge(out[k], v) if isinstance(v, dict) and isinstance(out.get(k), dict) else v
    return out


def provider_map(providers, unmapped=()):
    return {p: {"roles": {r: {"model": "%s/%s" % (p, r)} for r in ROLES if r not in unmapped}} for p in providers}


def _under_tmp(p):
    """True if `p` (literal or resolved) is /tmp or below it. Never on Windows."""
    if os.name == "nt":
        return False
    for c in (os.path.abspath(p), os.path.realpath(p)):
        if c == "/tmp" or c.startswith("/tmp/"):
            return True
    return False


def scenario_tmp_base():
    """Base dir for scenario workspaces, never under a literal /tmp. The overlay adds /tmp as a write root
    on non-win32, so a workspace below it (Linux CI: tempfile.gettempdir() == /tmp) would be classed
    tmp-scratch and hide the containment the scenarios assert. PI_FOREMAN_TEST_TMP overrides the base
    (mirrors extensions/core-adapter/test/_tmpbase.ts)."""
    env = os.environ.get("PI_FOREMAN_TEST_TMP", "").strip()
    base = env or tempfile.gettempdir()
    if _under_tmp(base):
        base = os.path.join(os.path.expanduser("~"), ".cache", "pi-foreman-tests")
    os.makedirs(base, exist_ok=True)
    return base


class Rig:
    """One throwaway Pi world: agent dir + project + tmp, plus the processes started in it."""

    def __init__(self, name, script, providers=(PROVIDER_A,), config=None, settings=None, unmapped=(),
                 project_config=None, l2_providers=True, permissions="open", intercom=False):
        """`project_config` is written to project/.pi/foreman.json after the user block is
        generated (Pi runs with --approve, so the adapter trusts it); `l2_providers=False` leaves
        the L2 `providers` map, and so the generated agentOverridesByProvider, empty."""
        # pi-intercom's broker socket lives in the agent dir; macOS caps socket paths at 103 bytes,
        # which the default temp dir there exceeds, so intercom rigs use /tmp on POSIX.
        base = "/tmp" if intercom and os.name != "nt" and os.path.isdir("/tmp") else scenario_tmp_base()
        self.root = Path(tempfile.mkdtemp(prefix="pf-replay-%s-" % name, dir=base)).resolve()
        self.procs = []
        try:
            self._setup(script, providers, config, settings, unmapped, project_config, l2_providers, permissions, intercom)
        except BaseException:
            self.close()  # same pf-replay- prefix and tmp-root check; the caller's addCleanup is not registered yet
            raise

    def _setup(self, script, providers, config, settings, unmapped, project_config, l2_providers, permissions, intercom):
        self.agent = self.root / "agent"
        self.project = self.root / "project"
        self.tmp = self.root / "tmp"
        for d in (self.agent, self.project, self.tmp):
            d.mkdir()
        _run(["git", "init", "-q"], 60, cwd=str(self.project))
        # the pressure sampler never reads the live host in a rig: an ok host sample unless a case passes its own PI_FOREMAN_PRESSURE_FIXTURE
        self.ok_host = self.root / "host-ok.json"
        self.ok_host.write_text(json.dumps({"loadPerCore": 0.1, "freeMemMB": 16000, "freeDiskGB": 500}), "utf-8")
        self.script = self.root / "script.json"
        self.script.write_text(json.dumps(script, indent=1), "utf-8")
        l2 = {
            "providers": provider_map(providers, unmapped) if l2_providers else {},
            "trace": {"enabled": True},
            "safety": {"requiredChildExtensions": [str(FAKE_PROVIDER)]},
            # Scenarios written for detached launches keep them; launch-wait scenarios set "block".
            "ceremony": {"launchWait": "detach"},
        }
        if config:
            l2 = deep_merge(l2, config)
        (self.agent / "foreman.json").write_text(json.dumps(l2, indent=1), "utf-8")
        gen = _run([sys.executable, str(REPO / "scripts" / "foreman_config.py"), "generate-subagents", "--json",
                    "--agent-dir", str(self.agent), "--project-dir", str(self.project)], 60)
        # Exit 3 = roles without a model (expected when `unmapped` is set); the block is still written.
        if gen.returncode != 0 and not ((unmapped or not l2_providers) and gen.returncode == 3):
            raise RuntimeError("generate-subagents failed: %s" % gen.stderr.decode())
        block = json.loads(gen.stdout.decode())["subagents"]
        bundled_check()
        # one package entry: the repo brings pi-subagents, permission system and intercom; non-intercom rigs filter intercom out
        entry = str(REPO) if intercom else {"source": str(REPO), "extensions": ["!node_modules/pi-intercom/**"]}
        st = {"packages": [entry], "subagents": block}
        if settings:
            st = deep_merge(st, settings)
        (self.agent / "settings.json").write_text(json.dumps(st, indent=1), "utf-8")
        ps_cfg = self.agent / "extensions" / "pi-permission-system" / "config.json"
        ps_cfg.parent.mkdir(parents=True)
        if permissions == "baseline":
            out = _run([sys.executable, str(REPO / "scripts" / "permissions_gen.py"), "render", "--agent-dir", str(self.agent)], 60)
            if out.returncode != 0:
                raise RuntimeError("permissions_gen failed: %s" % out.stderr.decode())
            ps_cfg.write_text(json.dumps(json.loads(out.stdout.decode())["config"], indent=1), "utf-8")
        else:
            ps_cfg.write_text(json.dumps(OPEN_PERMISSIONS), "utf-8")
        if project_config is not None:
            (self.project / ".pi").mkdir()
            (self.project / ".pi" / "foreman.json").write_text(json.dumps(project_config, indent=1), "utf-8")

    @property
    def state_dir(self):
        return self.agent / "pi-foreman" / "state"

    def env(self, extra=None):
        env = {k: v for k, v in os.environ.items()
               if not k.upper().startswith(("PI_", "FOREMAN_")) and k.upper() not in ("TMPDIR", "TEMP", "TMP")}
        env.update({"PI_CODING_AGENT_DIR": str(self.agent), "FOREMAN_FAKE_SCRIPT": str(self.script),
                    "TMPDIR": str(self.tmp), "TEMP": str(self.tmp), "TMP": str(self.tmp),
                    "PI_FOREMAN_PRESSURE_FIXTURE": str(self.ok_host)})
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
        tmp_roots = {Path(tempfile.gettempdir()).resolve(), Path("/tmp").resolve(), Path(scenario_tmp_base()).resolve()}
        if self.root.parent in tmp_roots and self.root.name.startswith("pf-replay-"):
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
        self._threads = [threading.Thread(target=self._read_out, daemon=True),
                         threading.Thread(target=self._read_err, daemon=True)]
        for t in self._threads:
            t.start()

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
            ans = answers.pop(0) if answers else {"cancelled": True}
            ans = dict(ans(rec) if callable(ans) else ans)  # a callable sees the open dialog first
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

    def close(self, timeout=45.0):
        if self.proc.poll() is None:
            try:
                self.proc.stdin.close()
            except OSError:
                pass
            # Windows: Pi can exit slowly after EOF. Wait longer, then terminate, then kill; never raises.
            if not _wait_exit(self.proc, timeout):
                self.proc.terminate()
                if not _wait_exit(self.proc, 15):
                    self.proc.kill()
                    _wait_exit(self.proc, 15)
        # Reader threads end at EOF; then release the pipes (ResourceWarning otherwise).
        for t in self._threads:
            t.join(5)
        for f in (self.proc.stdin, self.proc.stdout, self.proc.stderr):
            try:
                f.close()
            except (OSError, ValueError):
                pass


# ------------------------------------------------------------------ helpers

def _wait_exit(proc, timeout):
    """True when `proc` exits within `timeout` seconds."""
    try:
        proc.wait(timeout)
        return True
    except subprocess.TimeoutExpired:
        return False


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


# Custom message types that wake or notify the foreman (foreman_wake covers wait, timer and pressure outcomes).
WAKE_TYPES = ("foreman_wake", "pi-foreman-pr")
_WAKE_SUBS = (  # applied in order: one rule per kind of volatile value, not per wake event
    (re.compile(r"https?://\S+"), "<url>"),
    (re.compile(r"\d{4}-\d\d-\d\d[T ]\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:?\d\d)?"), "<ts>"),
    (re.compile(r"(?<![\w/.:-])(?:[A-Za-z]:[\\/]|/)[^\s\"'`,;)]+"), "<path>"),
    (re.compile(r"\bw\d+\b"), "<id>"),
    (re.compile(r"#\d+\b"), "#<n>"),
    (re.compile(r"\b\d+(?:\.\d+)? ?(?:ms|s|min|m)\b"), "<dur>"),
)


def normalise_wake(text):
    """A wake or notification text with ids, timestamps, paths, urls, PR numbers and durations replaced by placeholders."""
    for rx, rep in _WAKE_SUBS:
        text = rx.sub(rep, text)
    return text


def wake_messages(records):
    """[(customType, normalised content)] of every foreman wake message in an RPC transcript."""
    out = []
    for r in records:
        msg = r.get("message") if isinstance(r.get("message"), dict) else {}
        if r.get("type") == "message_end" and msg.get("customType") in WAKE_TYPES:
            c = msg.get("content")
            if isinstance(c, list):
                c = "\n".join(p.get("text", "") for p in c if isinstance(p, dict))
            out.append((msg["customType"], normalise_wake(str(c or ""))))
    return out


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


def wait_until(pred, timeout=30.0, describe=None, interval=0.25):
    """Poll `pred()` until it returns a truthy value, and return that value. On timeout raise AssertionError
    with the last value `pred` returned (`describe(last)` when given), so a slow CI run fails with the state it saw."""
    deadline = time.time() + timeout
    while True:
        last = pred()
        if last:
            return last
        if time.time() > deadline:
            shown = describe(last) if describe else repr(last)
            raise AssertionError("condition not met within %.0fs; last state: %s" % (timeout, str(shown)[:2000]))
        time.sleep(interval)
