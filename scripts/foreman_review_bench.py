#!/usr/bin/env python3
"""`foreman bench review`: score reviewer models on diffs with planted defects (stdlib, 3.9+).

    python scripts/foreman_bench.py review --tasks DIR [--models id[,id]] [--repeats 2] [--out DIR]
                                           [--jobs 3] [--token-cap N] [--timeout 900] [--dry-run]
    python scripts/foreman_bench.py review-table --out DIR

Task dir (one per task; --tasks names one task dir or a folder of them):
    base/ (or base.tar.gz)  the repo before the builder's change, plain files
    diff.patch              the builder's change, `git apply`-able onto base/
    prompt.md               the owner's task text the builder was given
    ground_truth.json       {"clean": false, "defects": [{"id", "file", "lines": [a, b], "class", "description"}]}
                            or {"clean": true, "defects": []} for a clean control

One cell = one task x one model x one repeat = one reviewer launch through the harness's own
review path: the base is committed in a fresh git repo, the diff applied uncommitted, the diff
facts and owner block come from extensions/core-adapter/diffscan.ts (bench/review_facts.mjs),
and Pi runs the reviewer role prompt with the core-adapter extension loaded as a reviewer child
(PI_SUBAGENT_CHILD=1, a launch binding with role reviewer), which adds instructions/reviewer.md
and foreman_ledger exactly as in a session. Cells run in a work dir outside --out (the reviewer
must not reach other cells' results or the ground truth). A cell whose json exists is skipped,
so a second run resumes; failed launches are written as `<cell>.error.json` and retried.

Auth for claude-bridge models: the token is read from the file named by
FOREMAN_BENCH_OAUTH_TOKEN_FILE (else FOREMAN_BENCH_OAUTH_TOKEN) and handed to Pi only as
CLAUDE_CODE_OAUTH_TOKEN in its process env; CLAUDE_CONFIG_DIR points at an empty folder in the
cell's agent dir so no host Claude Code settings, hooks or plugins load. The token is never
printed, logged or written (every file the runner writes is redacted).
"""
from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import math
import os
import re
import shutil
import signal
import statistics
import subprocess
import sys
import tarfile
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))
import foreman_bench  # noqa: E402

CLASSES = ("auth", "shell-injection", "path-traversal", "secret-log", "off-by-one", "resource-leak", "race",
           "swallowed-error", "insecure-default")
DEFAULT_MODELS = ("claude-bridge/claude-haiku-5-5:medium", "claude-bridge/claude-sonnet-5-5:medium",
                  "claude-bridge/claude-opus-5-5:medium")
BRIDGE_PROVIDER = "claude-bridge"
FAKE_PROVIDERS = ("foreman-fake", "foreman-fake-b")
BRIDGE = "pi-claude-bridge@0.9.2"  # same pins as bench/harbor_agent.py
AGENT_SDK = "@anthropic-ai/claude-agent-sdk@0.3.293"
# The reviewer role's tools plus foreman_ledger, which a session adds for reviewer children
# (scripts/foreman_config.py with_ledger_tool, ceremony.ledgerHelper "tool").
TOOLS = "read,ls,grep,find,bash,foreman_ledger"
FACTS_SHIM = REPO / "bench" / "review_facts.mjs"
ADAPTER = REPO / "extensions" / "core-adapter" / "index.ts"
FAKE_PROVIDER = REPO / "tests" / "replay" / "fake_provider.ts"
REVIEWER_AGENT = REPO / "agents" / "reviewer.md"
FAKE_TAG = "[[replay:review-bench]]"
# Words that must never reach the reviewer (its prompt, env, cwd or file names).
FORBIDDEN = ("seeded", "ground_truth")
LINE_SLACK = 3

# The foreman's task text: fixed and neutral, followed by the owner's prompt.md.
TASK_TEMPLATE = (
    "Review the builder's uncommitted change in this repository against commit {base} (`git diff {base}`; new "
    "files are included) for the owner's task below.\n"
    "Ledger:\n"
    "1. The change does what the task asks.\n"
    "2. The change introduces no defects: correctness, security, error handling, resource handling, concurrency.\n"
    "3. The tests pass; no test is weakened, removed or skipped.\n\n"
    "Owner's task:\n{prompt}")

# A defect counts as caught when a FAIL evidence line names its file and either one of its
# class's words (regex, case-insensitive, matched at a word start) or a line inside its range +-3.
CLASS_SYNONYMS = {
    "auth": [r"auth", r"permission", r"access control", r"privilege", r"bypass", r"unauthori[sz]ed"],
    "shell-injection": [r"shell", r"inject", r"unquoted", r"unescaped", r"quot(?:e|ing)", r"metachar",
                        r"execsync", r"sh -c", r"command line"],
    "path-traversal": [r"travers", r"\.\./", r"\.\.\\", r"escape", r"outside (?:the|of)", r"symlink",
                       r"canonical", r"absolute path", r"sanitiz"],
    "secret-log": [r"secret", r"token", r"credential", r"password", r"bearer", r"authorization header",
                   r"api key", r"leak", r"redact", r"sensitive"],
    "off-by-one": [r"off[- ]by[- ]one", r"fencepost", r"boundar", r"inclusive", r"exclusive", r"one too",
                   r"out of (?:range|bounds)", r"last (?:element|item|byte|line)", r"first (?:element|item)"],
    "resource-leak": [r"leak", r"not closed", r"never closed", r"unclosed", r"close", r"defer", r"handle",
                      r"descriptor", r"not released", r"dispose"],
    "race": [r"race", r"racy", r"lock", r"mutex", r"concurren", r"thread[- ]safe", r"atomic", r"synchroni",
             r"toctou", r"goroutine", r"simultaneous"],
    "swallowed-error": [r"swallow", r"ignor", r"discard", r"silent", r"unchecked", r"not checked",
                        r"error handling", r"lost error", r"unwrap_or", r"except(?:ion)?: pass", r"suppress"],
    "insecure-default": [r"insecure", r"default", r"tls", r"verif", r"permissive", r"world[- ]", r"0o?777",
                         r"0o?666", r"plaintext", r"debug"],
}
_SYN = {c: re.compile(r"(?<![\w])(?:%s)" % "|".join(v), re.I) for c, v in CLASS_SYNONYMS.items()}

VERDICT_RE = re.compile(r"\b(?:overall\s+)?verdict\s*\**\s*:\s*\**\s*(pass|fail|approve|block)\b", re.I)
ITEM_RE = re.compile(r"^\s*(?:[-*]\s+)?\**\s*(\d+)\.\s*\**\s*(PASS|FAIL)\b", re.M)
PATHLINE_RE = re.compile(r"[\w./\\-]*\w\.[A-Za-z0-9]{1,6}:\d+")
PATHTOKEN_RE = re.compile(r"[\w./\\-]*\w\.[A-Za-z][A-Za-z0-9]{0,5}(?![\w])")
LINENUM_RE = re.compile(r"(?::|\blines?\s+)(\d+)(?:\s*[-–]\s*(\d+))?", re.I)


# ------------------------------------------------------------------ parsing and scoring

def verdict_of(text):
    """Twin of rounds.ts verdictOf: any fail/block wins, else pass/approve, else None."""
    found = [m.lower() for m in VERDICT_RE.findall(text or "")]
    if any(v in ("fail", "block") for v in found):
        return "fail"
    return "pass" if found else None


def items_of(text):
    """Per-item lines `N. PASS|FAIL <evidence>` (reviewmarks.ts item shape, markdown bullets and bold allowed)."""
    out = []
    for m in ITEM_RE.finditer(text or ""):
        line = (text[m.start():].split("\n", 1)[0]).strip()
        out.append({"n": int(m.group(1)), "verdict": m.group(2).upper(), "line": line})
    return out


def fail_evidence(text):
    """FAIL evidence lines: `N. FAIL` items, lines citing `path:line` (not `N. PASS` or verdict lines), and
    `Missing:` lines that cite a path."""
    out = []
    for raw in (text or "").splitlines():
        line = raw.strip()
        if not line:
            continue
        m = ITEM_RE.match(line)
        if m:
            if m.group(2).upper() == "FAIL":
                out.append(line)
            continue
        if VERDICT_RE.search(line) and not PATHLINE_RE.search(line):
            continue
        if re.match(r"^\W*missing\s*:", line, re.I):
            if PATHTOKEN_RE.search(line) and not re.match(r"^\W*missing\s*:\W*none\b", line, re.I):
                out.append(line)
            continue
        if PATHLINE_RE.search(line):
            out.append(line)
    return out


def _norm(p):
    return p.replace("\\", "/")


def names_file(line, rel):
    """True when `line` names repo file `rel` by its path or its basename."""
    rel = _norm(rel)
    text = _norm(line)
    base = rel.rsplit("/", 1)[-1]
    if re.search(r"(?<![\w.-])" + re.escape(rel) + r"(?![\w])", text) or ("/" + rel) in text:
        return True
    return re.search(r"(?<![\w-])" + re.escape(base) + r"(?![\w])", text) is not None


def _line_hits(line, rel):
    """Line numbers the evidence line gives: `<file>:N[-M]` for this file, else `line(s) N[-M]`."""
    text = _norm(line)
    base = re.escape(_norm(rel).rsplit("/", 1)[-1])
    spans = [(int(a), int(b or a)) for a, b in re.findall(base + r":(\d+)(?:\s*[-–]\s*(\d+))?", text)]
    if spans:
        return spans
    return [(int(a), int(b or a)) for a, b in re.findall(r"\blines?\s+(\d+)(?:\s*[-–]\s*(\d+))?", text, re.I)]


def catches(line, defect):
    if not names_file(line, defect["file"]):
        return False
    if _SYN.get(defect["class"]) and _SYN[defect["class"]].search(line):
        return True
    a, b = defect["lines"][0] - LINE_SLACK, defect["lines"][-1] + LINE_SLACK
    return any(lo <= b and hi >= a for lo, hi in _line_hits(line, defect["file"]))


def files_named(line, files):
    """Repo files (from `files`) the line names; with no file list, the path-like tokens themselves."""
    if files:
        return sorted(f for f in files if names_file(line, f))
    return sorted({_norm(t).lstrip("./") for t in PATHTOKEN_RE.findall(line)})


def score(text, truth, files=()):
    """Deterministic score of one review against its ground truth (docs/bench.md "Review bench").

    An overall PASS scores nothing (no catches, no false alarms). Otherwise a defect is caught when one FAIL
    evidence line names its file and a class word or a line within its range +-3. Evidence lines that catch
    nothing are false alarms, counted once per distinct repo file they name that holds no planted defect; on a
    clean task a line naming no repo file counts once as `(no file)`."""
    verdict = verdict_of(text)
    defects = truth.get("defects") or []
    res = {"verdict": verdict, "caught": [], "missed": [d["id"] for d in defects], "false_alarms": [],
           "defects": len(defects), "clean": bool(truth.get("clean"))}
    if verdict == "pass":
        return res
    evidence = fail_evidence(text)
    planted = {_norm(d["file"]) for d in defects}
    caught, fa = set(), set()
    for line in evidence:
        hit = [d["id"] for d in defects if catches(line, d)]
        caught.update(hit)
        if hit:
            continue
        named = [f for f in files_named(line, files) if _norm(f) not in planted]
        fa.update(named)
        if not named and res["clean"]:
            fa.add("(no file)")
    res["caught"] = [d["id"] for d in defects if d["id"] in caught]
    res["missed"] = [d["id"] for d in defects if d["id"] not in caught]
    res["false_alarms"] = sorted(fa)
    return res


# ------------------------------------------------------------------ task dirs

def validate_task(path):
    """Problems with one task dir ([] = valid)."""
    p = Path(path)
    errs = []
    if not (p / "base").is_dir() and not (p / "base.tar.gz").is_file():
        errs.append("no base/ or base.tar.gz")
    for name in ("diff.patch", "prompt.md", "ground_truth.json"):
        if not (p / name).is_file():
            errs.append("no %s" % name)
    if (p / "diff.patch").is_file() and not (p / "diff.patch").read_text("utf-8", "replace").strip():
        errs.append("diff.patch is empty")
    if (p / "ground_truth.json").is_file():
        try:
            gt = json.loads((p / "ground_truth.json").read_text("utf-8"))
        except ValueError as e:
            return errs + ["ground_truth.json: %s" % e]
        errs += truth_errors(gt)
    return errs


def truth_errors(gt):
    if not isinstance(gt, dict) or not isinstance(gt.get("clean"), bool) or not isinstance(gt.get("defects"), list):
        return ["ground_truth.json: needs {\"clean\": bool, \"defects\": [...]}"]
    errs = []
    if gt["clean"] and gt["defects"]:
        errs.append("ground_truth.json: a clean task has no defects")
    if not gt["clean"] and not gt["defects"]:
        errs.append("ground_truth.json: a task that is not clean needs at least one defect")
    ids = set()
    for i, d in enumerate(gt["defects"]):
        where = "ground_truth.json defect %d" % (i + 1)
        if not isinstance(d, dict):
            errs.append(where + ": not an object")
            continue
        for k in ("id", "file", "class", "description"):
            if not isinstance(d.get(k), str) or not d[k]:
                errs.append("%s: %s missing" % (where, k))
        if d.get("class") and d["class"] not in CLASSES:
            errs.append("%s: class %r not one of %s" % (where, d["class"], ", ".join(CLASSES)))
        ln = d.get("lines")
        if not (isinstance(ln, list) and len(ln) == 2 and all(isinstance(x, int) and x > 0 for x in ln) and ln[0] <= ln[1]):
            errs.append(where + ": lines must be [first, last], 1-based")
        if d.get("id") in ids:
            errs.append("%s: duplicate id %s" % (where, d["id"]))
        ids.add(d.get("id"))
    return errs


def find_tasks(root):
    """Task dirs under `root` (or `root` itself when it is one), sorted by name."""
    r = Path(root)
    marks = ("diff.patch", "ground_truth.json", "prompt.md")
    if any((r / m).exists() for m in marks):
        return [r]
    return sorted((d for d in r.iterdir() if d.is_dir() and any((d / m).exists() for m in marks)), key=lambda d: d.name)


# ------------------------------------------------------------------ cells

def model_slug(model):
    return re.sub(r"[^A-Za-z0-9._-]+", "-", model).strip("-")


def bare_model(model):
    return model.split("/", 1)[-1].split(":", 1)[0]


def provider_of(model):
    return model.split("/", 1)[0]


def cell_name(task, model, rep):
    return "%s__%s__r%d" % (task, model_slug(model), rep)


def plan_cells(tasks, models, repeats):
    """Repeat outermost, then task, then model: a stop leaves every model with the same tasks."""
    return [(t, m, r) for r in range(1, repeats + 1) for t in tasks for m in models]


def _git(repo, *args, timeout=120):
    r = subprocess.run(["git", "-c", "core.autocrlf=false", *args], cwd=str(repo),
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, stdin=subprocess.DEVNULL, timeout=timeout)
    if r.returncode != 0:
        raise RuntimeError("git %s failed: %s" % (args[0], r.stderr.decode("utf-8", "replace").strip()[-400:]))
    return r.stdout.decode("utf-8", "replace")


def _safe_extract(archive, dest):
    with tarfile.open(str(archive), "r:gz") as tf:
        members = []
        for m in tf.getmembers():
            name = _norm(m.name)
            if name.startswith("/") or re.match(r"^[A-Za-z]:", name) or ".." in name.split("/"):
                raise RuntimeError("unsafe path in %s: %s" % (archive.name, m.name))
            if m.issym() or m.islnk():
                target = _norm(m.linkname)
                if target.startswith("/") or ".." in target.split("/"):
                    raise RuntimeError("unsafe link in %s: %s" % (archive.name, m.name))
            elif not (m.isfile() or m.isdir()):
                continue
            members.append(m)
        kw = {"filter": "data"} if hasattr(tarfile, "data_filter") else {}
        tf.extractall(str(dest), members=members, **kw)


def build_repo(task_dir, repo):
    """Copy or extract the base into `repo`, commit it, apply diff.patch uncommitted (new files intent-to-add).
    Returns the base sha."""
    task_dir = Path(task_dir)
    if (task_dir / "base").is_dir():
        shutil.copytree(str(task_dir / "base"), str(repo), symlinks=True, ignore=shutil.ignore_patterns(".git"))
    else:
        stage = repo.parent / "x"
        stage.mkdir()
        _safe_extract(task_dir / "base.tar.gz", stage)
        inner = stage / "base"
        if [p.name for p in stage.iterdir()] == ["base"] and inner.is_dir():
            inner.rename(repo)
            stage.rmdir()
        else:
            stage.rename(repo)
    _git(repo, "init", "-q", "--template=")
    _git(repo, "add", "-A")
    _git(repo, "-c", "user.name=dev", "-c", "user.email=dev@example.invalid", "-c", "commit.gpgsign=false",
         "commit", "-q", "--no-verify", "-m", "base")
    base = _git(repo, "rev-parse", "HEAD").strip()
    _git(repo, "apply", "--whitespace=nowarn", "--intent-to-add", str((task_dir / "diff.patch").resolve()))
    return base


def repo_files(repo):
    return sorted(f for f in _git(repo, "ls-files", "-z").split("\0") if f)


def reviewer_system_prompt():
    """What pi-subagents gives a reviewer child: the active-agent tag and the role body (frontmatter stripped)."""
    text = REVIEWER_AGENT.read_text("utf-8")
    m = re.match(r"^---\r?\n.*?\r?\n---\r?\n", text, re.S)
    return '<active_agent name="reviewer"/>\n\n' + (text[m.end():] if m else text).strip()


def facts_for(repo, base, owner_file, scratch, timeout=120):
    node = shutil.which("node")
    if not node:
        raise RuntimeError("node not found on PATH (needed for bench/review_facts.mjs)")
    r = subprocess.run([node, str(FACTS_SHIM), str(repo), base, str(owner_file), str(scratch)], cwd=str(REPO),
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, stdin=subprocess.DEVNULL, timeout=timeout)
    if r.returncode != 0:
        raise RuntimeError("review_facts.mjs failed: %s" % r.stderr.decode("utf-8", "replace").strip()[-400:])
    return json.loads(r.stdout.decode("utf-8"))


def compose_task(base, prompt, facts, fake=False):
    """The reviewer's user message: `Task: ` + the foreman task, the diffscan augment (facts block + owner block,
    only when there is a fact), then the scratch line (childscratch.ts launchScratch)."""
    msg = "Task: " + TASK_TEMPLATE.format(base=base, prompt=prompt.strip())
    if facts.get("count", 0) > 0 and facts.get("block"):
        msg += "\n" + facts["block"] + "\n" + facts["owner"]
    if facts.get("scratch"):
        msg += "\n\n" + facts["scratch"]
    if fake:
        msg += "\n" + FAKE_TAG
    return msg


def blind_violations(texts, tree, task_dir):
    """Ways the reviewer could learn the answer: a forbidden word or the task dir path in any text it gets (prompt,
    env, cwd), or a forbidden word in a file name of its tree. Base file contents are not scanned."""
    td = Path(task_dir).resolve()
    needles = [w for w in FORBIDDEN] + [str(td).lower(), td.as_posix().lower()]
    out = []
    for name, text in texts.items():
        low = str(text).lower()
        out += ["%s contains %r" % (name, n) for n in needles if n and n in low]
    for p in Path(tree).rglob("*"):
        if ".git" in p.relative_to(tree).parts:
            continue
        low = p.name.lower()
        out += ["tree file %s" % p.relative_to(tree).as_posix() for w in FORBIDDEN if w in low]
    return sorted(set(out))


def child_env(agent, tmp, scratch, repo, launch_id, token=None, fake_script=None):
    env = {k: v for k, v in os.environ.items()
           if not k.upper().startswith(("PI_", "FOREMAN_", "CLAUDE_", "ANTHROPIC_"))
           and k.upper() not in ("TMPDIR", "TEMP", "TMP")}
    binding = {"foremanSession": "review-bench", "workspace": str(repo), "role": "reviewer", "launchId": launch_id,
               "kind": "first", "model": None, "scratch": str(scratch)}
    env.update({"PI_CODING_AGENT_DIR": str(agent), "TMPDIR": str(tmp), "TEMP": str(tmp), "TMP": str(tmp),
                "PI_SUBAGENT_CHILD": "1", "PI_SUBAGENT_EXTENSION_BINDINGS": json.dumps({"pi-foreman/1": binding}),
                "PI_TELEMETRY": "0", "PI_SKIP_VERSION_CHECK": "1",
                "CLAUDE_CONFIG_DIR": str(Path(agent) / "pi-foreman" / "claude-config")})
    if fake_script:
        env["FOREMAN_FAKE_SCRIPT"] = str(fake_script)
    if token:
        env["CLAUDE_CODE_OAUTH_TOKEN"] = token
    return env


def pi_args(pi_cli, model, system, user, fake):
    args = [shutil.which("node") or "node", str(pi_cli), "-p", "--mode", "json", "--no-session", "--no-context-files",
            "--no-skills", "-e", str(ADAPTER)]
    if fake:
        args += ["-e", str(FAKE_PROVIDER)]
    return args + ["--model", model, "--tools", TOOLS, "--system-prompt", system, user]


def _text(content):
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    out = []
    for c in content:
        if isinstance(c, dict):
            if c.get("type") == "text":
                out.append(str(c.get("text") or ""))
            elif c.get("type") in ("toolCall", "tool_call"):
                out.append(json.dumps(c.get("arguments") or {}))
    return "\n".join(out)


def _msg_chars(m):
    n = len(_text(m.get("content")))
    for v in (m.get("sections") or {}).values():
        if isinstance(v, str):
            n += len(v)
    return n


def parse_events(stdout):
    """(final text, per-request usage rows, estimated?, last stop reason, error message) from `pi --mode json`."""
    msgs = []
    for line in stdout.splitlines():
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        if isinstance(rec, dict) and rec.get("type") == "message_end" and isinstance(rec.get("message"), dict):
            msgs.append(rec["message"])
    ctx, reqs, est, final, stop, err = 0, [], False, "", None, None
    for m in msgs:
        chars = _msg_chars(m)
        if m.get("role") == "assistant":
            u = m.get("usage") or {}
            row = [int(u.get(k) or 0) for k in ("input", "cacheRead", "cacheWrite", "output")]
            if not any(row):
                row = [math.ceil(ctx / 4), 0, 0, math.ceil(chars / 4)]
                est = True
            reqs.append(row)
            t = _text([c for c in (m.get("content") or []) if isinstance(c, dict) and c.get("type") == "text"]
                      if isinstance(m.get("content"), list) else m.get("content"))
            if t.strip():
                final = t
            stop, err = m.get("stopReason"), m.get("errorMessage")
        ctx += chars
    return final, reqs, est, stop, err


def _kill_tree(proc):
    try:
        if os.name == "nt":
            subprocess.run(["taskkill", "/T", "/F", "/PID", str(proc.pid)], stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL, timeout=30)
        else:
            os.killpg(proc.pid, signal.SIGKILL)
    except (OSError, subprocess.SubprocessError):
        pass
    try:
        proc.kill()
    except OSError:
        pass


def _redact(text, token):
    return text.replace(token, "<redacted>") if token and isinstance(text, str) else text


def _write_json(path, data, token=None):
    tmp = Path(str(path) + ".tmp")
    tmp.write_text(_redact(json.dumps(data, indent=1), token), "utf-8")
    os.replace(str(tmp), str(path))


class Bench:
    """One review-bench run: tasks x models x repeats into `out`."""

    def __init__(self, out, tasks, models, repeats=2, jobs=3, token_cap=None, timeout=900, work=None,
                 pi_cli=None, bridge=None, token=None, fake_script=None, prices=None, log=None):
        self.out = Path(out)
        self.tasks = {Path(t).name: Path(t).resolve() for t in tasks}
        self.models, self.repeats, self.jobs = list(models), repeats, max(1, jobs)
        self.token_cap, self.timeout = token_cap, timeout
        self.work = Path(work) if work else Path(tempfile.gettempdir()) / "pf-rb-work" / hashlib.sha1(
            str(self.out.resolve()).encode()).hexdigest()[:10]
        self.pi_cli, self.bridge, self.token, self.fake_script = pi_cli, bridge, token, fake_script
        self.prices = prices
        self.log = log or (lambda s: print(s, flush=True))
        self.procs = set()

    @property
    def cells_dir(self):
        return self.out / "cells"

    def cell_path(self, task, model, rep):
        return self.cells_dir / (cell_name(task, model, rep) + ".json")

    def truth(self, task):
        return json.loads((self.tasks[task] / "ground_truth.json").read_text("utf-8"))

    def prepare(self, task, model, rep):
        """Workspace and composed launch for one cell (no launch): dict with paths, prompts and env."""
        uniq = hashlib.sha1(("%s|%s|%d|%d" % (task, model, rep, time.time_ns())).encode()).hexdigest()[:12]
        root = self.work / uniq
        repo, agent, tmp = root / "repo", root / "agent", root / "tmp"
        root.mkdir(parents=True)
        tmp.mkdir()
        (agent / "pi-foreman" / "claude-config").mkdir(parents=True)
        scratch = tmp / "pi-foreman-scratch" / "review-bench" / uniq
        scratch.mkdir(parents=True)
        fake = provider_of(model) in FAKE_PROVIDERS
        pkgs = [str(self.bridge)] if self.bridge and not fake else []
        (agent / "settings.json").write_text(json.dumps({"packages": pkgs}, indent=1), "utf-8")
        tdir = self.tasks[task]
        base = build_repo(tdir, repo)
        facts = facts_for(repo, base, tdir / "prompt.md", scratch)
        system = reviewer_system_prompt()
        user = compose_task(base, (tdir / "prompt.md").read_text("utf-8"), facts, fake=fake)
        env = child_env(agent, tmp, scratch, repo, "rb-" + uniq, fake_script=self.fake_script if fake else None)
        added = {k: v for k, v in env.items() if os.environ.get(k) != v}
        texts = {"system prompt": system, "task": user, "cwd": str(repo)}
        texts.update({"env " + k: v for k, v in added.items()})
        bad = blind_violations(texts, repo, tdir)
        diff_text = (tdir / "diff.patch").read_text("utf-8", "replace").lower()
        bad += ["diff.patch contains %r" % w for w in FORBIDDEN if w in diff_text]
        return {"root": root, "repo": repo, "base": base, "facts": facts, "system": system, "user": user,
                "env": env, "env_set": added, "fake": fake, "blind": bad, "files": repo_files(repo)}

    def run_cell(self, task, model, rep):
        """Launch one cell; writes cells/<cell>.json (or .error.json) and returns its record."""
        name = cell_name(task, model, rep)
        rec = {"task": task, "model": model, "repeat": rep, "run": self.out.name}
        t0 = time.time()
        try:
            prep = self.prepare(task, model, rep)
        except (OSError, RuntimeError, ValueError, subprocess.SubprocessError) as e:
            rec.update(status="error", error="prepare: %s" % e)
            _write_json(self.cells_dir / (name + ".error.json"), rec, self.token)
            return rec
        if prep["blind"]:
            rec.update(status="error", error="blindness check failed: " + "; ".join(prep["blind"]))
            _write_json(self.cells_dir / (name + ".error.json"), rec, self.token)
            return rec
        env = dict(prep["env"])
        if not prep["fake"] and self.token:
            env["CLAUDE_CODE_OAUTH_TOKEN"] = self.token
        args = pi_args(self.pi_cli, model, prep["system"], prep["user"], prep["fake"])
        kw = {"creationflags": getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)} if os.name == "nt" else {"start_new_session": True}
        proc = subprocess.Popen(args, cwd=str(prep["repo"]), env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, **kw)
        self.procs.add(proc)
        timed_out = False
        try:
            out, err = proc.communicate(timeout=self.timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
            _kill_tree(proc)
            out, err = proc.communicate()
        finally:
            self.procs.discard(proc)
        secs = round(time.time() - t0, 1)
        stdout = out.decode("utf-8", "replace")
        (prep["root"] / "events.jsonl").write_text(_redact(stdout, self.token), "utf-8")
        final, reqs, est, stop, perr = parse_events(stdout)
        bare = bare_model(model)
        usage = {k: sum(r[i] for r in reqs) for i, k in enumerate(("input", "cacheRead", "cacheWrite", "output"))}
        usage["total"] = sum(usage.values())
        usage["requests"] = len(reqs)
        usage["estimated"] = est
        cost = foreman_bench.cost_of({"usage_requests": [["reviewer", bare] + r for r in reqs]}, self.prices) \
            if self.prices and reqs else None
        truth = self.truth(task)
        rec.update({"secs": secs, "exit_code": proc.returncode, "timed_out": timed_out, "stop_reason": stop,
                    "verdict": verdict_of(final), "items": items_of(final), "evidence": fail_evidence(final),
                    "score": score(final, truth, prep["files"]), "ground_truth": truth, "usage": usage,
                    "usd": None if cost is None or cost["unpriced"] else round(cost["usd"], 6),
                    "unpriced": cost["unpriced"] if cost else [], "base": prep["base"],
                    "facts_count": prep["facts"].get("count", 0), "files": prep["files"],
                    "work": str(prep["root"]), "final_text": final,
                    "prompt": {"system": prep["system"], "task": prep["user"]},
                    "env_set": sorted(prep["env_set"]) + (["CLAUDE_CODE_OAUTH_TOKEN"] if not prep["fake"] and self.token else []),
                    "stderr_tail": _redact(err.decode("utf-8", "replace")[-2000:], self.token)})
        problem = "timeout after %ss" % self.timeout if timed_out else (
            "provider error: %s" % (perr or "")[:300] if stop == "error" else (
                "no model answer (exit %s)" % proc.returncode if not reqs else None))
        if problem or not final.strip():
            rec.update(status="error", error=problem or "empty final text")
            _write_json(self.cells_dir / (name + ".error.json"), rec, self.token)
            return rec
        rec["status"] = "ok"
        _write_json(self.cells_dir / (name + ".json"), rec, self.token)
        err_file = self.cells_dir / (name + ".error.json")
        if err_file.exists():
            os.replace(str(err_file), str(self.cells_dir / (name + ".error.prev.json")))
        return rec

    def used_tokens(self):
        n = 0
        for p in self.cells_dir.glob("*.json"):  # failed launches spent tokens too
            try:
                n += int((json.loads(p.read_text("utf-8")).get("usage") or {}).get("total") or 0)
            except (OSError, ValueError):
                pass
        return n

    def run(self):
        """Run every missing cell. Exit codes: 0 done, 4 token cap reached, 6 interrupted."""
        self.cells_dir.mkdir(parents=True, exist_ok=True)
        _write_json(self.out / "run.json", {"run": self.out.name, "tasks": sorted(self.tasks), "models": self.models,
                                            "repeats": self.repeats, "timeout": self.timeout, "work": str(self.work)})
        todo = [c for c in plan_cells(sorted(self.tasks), self.models, self.repeats) if not self.cell_path(*c).exists()]
        self.log("review bench: %d cells to run, %d done; work dir %s" % (
            len(todo), len(self.tasks) * len(self.models) * self.repeats - len(todo), self.work))
        code = 0
        pool = concurrent.futures.ThreadPoolExecutor(max_workers=self.jobs)
        running = {}
        try:
            while todo or running:
                while todo and len(running) < self.jobs:
                    if self.token_cap and self.used_tokens() >= self.token_cap:
                        self.log("review bench: token cap %d reached; stopping (rerun to resume)" % self.token_cap)
                        todo, code = [], 4
                        break
                    c = todo.pop(0)
                    running[pool.submit(self.run_cell, *c)] = c
                if not running:
                    break
                done, _ = concurrent.futures.wait(list(running), return_when=concurrent.futures.FIRST_COMPLETED)
                for f in done:
                    c = running.pop(f)
                    try:
                        r = f.result()
                    except Exception as e:  # noqa: BLE001 - one broken cell must not stop the run
                        r = {"status": "error", "error": "%s: %s" % (type(e).__name__, e)}
                        _write_json(self.cells_dir / (cell_name(*c) + ".error.json"),
                                    dict(task=c[0], model=c[1], repeat=c[2], **r), self.token)
                    s = r.get("score") or {}
                    self.log("%s %s%s" % (cell_name(*c), r.get("status"), " %s caught %d/%d fa %d %.0fs" % (
                        s.get("verdict"), len(s.get("caught", [])), s.get("defects", 0), len(s.get("false_alarms", [])),
                        r.get("secs", 0)) if r.get("status") == "ok" else ": " + _redact(str(r.get("error")), self.token)))
        except KeyboardInterrupt:
            for p in list(self.procs):
                _kill_tree(p)
            code = 6
            self.log("review bench: interrupted; rerun to resume")
        finally:
            pool.shutdown(wait=code != 6, cancel_futures=True)
        text = render_table(self.out, self.prices)
        (self.out / ("review-bench-%s.md" % self.out.name)).write_text(text, "utf-8")
        self.log(text)
        return code

    def dry_run(self):
        """Validate, prepare one workspace per task (no launch) and print the plan; writes nothing under --out."""
        keep = self.work
        self.work = Path(tempfile.mkdtemp(prefix="pf-rb-dry-"))
        problems = 0
        try:
            for task in sorted(self.tasks):
                try:
                    prep = self.prepare(task, self.models[0], 1)
                except (OSError, RuntimeError, ValueError, subprocess.SubprocessError) as e:
                    self.log("%s: prepare failed: %s" % (task, e))
                    problems += 1
                    continue
                gt = self.truth(task)
                self.log("%s: %s, %d defect(s), %d file(s), facts %d, task %d chars, blind %s" % (
                    task, "clean" if gt["clean"] else "planted", len(gt["defects"]), len(prep["files"]),
                    prep["facts"].get("count", 0), len(prep["user"]), "ok" if not prep["blind"] else "FAIL: " + "; ".join(prep["blind"])))
                problems += bool(prep["blind"])
        finally:
            _remove_tree(self.work)
            self.work = keep
        for c in plan_cells(sorted(self.tasks), self.models, self.repeats):
            self.log("%-60s %s" % (cell_name(*c), "done" if self.cell_path(*c).exists() else "run"))
        self.log("launch: node <pi cli> -p --mode json --no-session --no-context-files --no-skills -e %s --model <model> "
                 "--tools %s --system-prompt <reviewer> <task>" % (Path(ADAPTER).relative_to(REPO).as_posix(), TOOLS))
        return 1 if problems else 0


def _remove_tree(path):
    """Remove a dir this module created (dry run); read-only git objects are made writable first (Windows)."""
    def onerror(func, p, _exc):
        os.chmod(p, 0o700)
        func(p)
    if Path(path).name.startswith("pf-rb-dry-"):
        shutil.rmtree(str(path), onerror=onerror)


# ------------------------------------------------------------------ table

def load_cells(out):
    ok, errors = [], []
    cdir = Path(out) / "cells"
    for p in sorted(cdir.glob("*.json")) if cdir.is_dir() else []:
        if p.name.endswith(".error.prev.json"):
            continue
        try:
            rec = json.loads(p.read_text("utf-8"))
        except (OSError, ValueError):
            continue
        if p.name.endswith(".error.json"):
            if not (cdir / p.name.replace(".error.json", ".json")).exists():
                errors.append(rec)
        else:
            ok.append(rec)
    return ok, errors


def _fmt_usd(x):
    return "-" if x is None else "%.2f" % x if x >= 1 else "%.3f" % x


def render_table(out, prices=None):
    """The markdown result: one row per model, the per-class catch matrix and the per-task detail. Scores are
    recomputed from each cell's final text and ground truth, so a scorer change applies to old cells."""
    cells, errors = load_cells(out)
    for c in cells:
        c["score"] = score(c.get("final_text") or "", c.get("ground_truth") or {"clean": True, "defects": []},
                           c.get("files") or ())
    models = sorted({c["model"] for c in cells} | {e.get("model") for e in errors if e.get("model")})
    tasks = sorted({c["task"] for c in cells})
    lines = ["# Review bench %s" % Path(out).name, "",
             "Cells: %d scored, %d failed launches. USD is the %s; `~est` marks chars/4 token estimates." % (
                 len(cells), len(errors), foreman_bench.COST_LABEL), "",
             "| model | cells | catches | FA seeded | FA clean | clean PASS | USD | $/catch | median s | errors |",
             "|---|---|---|---|---|---|---|---|---|---|"]
    for m in models:
        mc = [c for c in cells if c["model"] == m]
        seeded = [c for c in mc if not c["score"]["clean"]]
        clean = [c for c in mc if c["score"]["clean"]]
        caught = sum(len(c["score"]["caught"]) for c in seeded)
        total = sum(c["score"]["defects"] for c in seeded)
        usd_cells = [c["usd"] for c in mc if c.get("usd") is not None]
        usd = sum(usd_cells) if usd_cells else None
        est = any((c.get("usage") or {}).get("estimated") for c in mc)
        secs = [c["secs"] for c in mc if c.get("secs") is not None]
        lines.append("| %s | %d | %d/%d%s | %d/%d | %d/%d | %d/%d | %s%s | %s | %s | %d |" % (
            m, len(mc), caught, total, " (%.0f%%)" % (100.0 * caught / total) if total else "",
            sum(len(c["score"]["false_alarms"]) for c in seeded), len(seeded),
            sum(len(c["score"]["false_alarms"]) for c in clean), len(clean),
            sum(1 for c in clean if c["score"]["verdict"] == "pass"), len(clean),
            _fmt_usd(usd), " ~est" if est and usd is not None else "",
            _fmt_usd(usd / caught) if usd is not None and caught else "-",
            "%.0f" % statistics.median(secs) if secs else "-", sum(1 for e in errors if e.get("model") == m)))
    lines += ["", "FA seeded / FA clean: false alarms over seeded / clean cells. clean PASS: clean cells with an "
              "overall PASS.", "", "## Catches by class", ""]
    classes = [k for k in CLASSES if any(d["class"] == k for c in cells for d in (c.get("ground_truth") or {}).get("defects", []))]
    lines += ["| model | " + " | ".join(classes) + " |", "|---|" + "---|" * len(classes)]
    for m in models:
        row = []
        for k in classes:
            hit = tot = 0
            for c in cells:
                if c["model"] != m:
                    continue
                for d in c["ground_truth"].get("defects", []):
                    if d["class"] == k:
                        tot += 1
                        hit += d["id"] in c["score"]["caught"]
            row.append("%d/%d" % (hit, tot))
        lines.append("| %s | %s |" % (m, " | ".join(row)))
    lines += ["", "## Per task", "", "| task | model | cells (verdict caught/defects fa) |", "|---|---|---|"]
    for t in tasks:
        for m in models:
            tc = sorted((c for c in cells if c["task"] == t and c["model"] == m), key=lambda c: c["repeat"])
            if tc:
                lines.append("| %s | %s | %s |" % (t, m, ", ".join("r%d %s %d/%d fa%d" % (
                    c["repeat"], c["score"]["verdict"] or "none", len(c["score"]["caught"]), c["score"]["defects"],
                    len(c["score"]["false_alarms"])) for c in tc)))
    if errors:
        lines += ["", "## Failed launches", ""] + ["- %s %s r%s: %s" % (e.get("task"), e.get("model"), e.get("repeat"),
                                                                       str(e.get("error"))[:200]) for e in errors]
    return "\n".join(lines) + "\n"


# ------------------------------------------------------------------ entry

def read_token():
    """The benchmark token, or None. Never printed or logged."""
    path = os.environ.get("FOREMAN_BENCH_OAUTH_TOKEN_FILE")
    if path:
        return Path(path).expanduser().read_text("utf-8").strip() or None
    return os.environ.get("FOREMAN_BENCH_OAUTH_TOKEN") or None


def pi_cli_path():
    env = os.environ.get("FOREMAN_PI_CLI")
    if env:
        return Path(env)
    npm = shutil.which("npm")
    if not npm:
        raise RuntimeError("npm not found on PATH (or set FOREMAN_PI_CLI to Pi's cli.js)")
    root = subprocess.run([npm, "root", "-g"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60).stdout.decode().strip()
    return Path(root) / "@earendil-works" / "pi-coding-agent" / "dist" / "bundle" / "cli.js"


def bridge_dir():
    """An installed pi-claude-bridge: FOREMAN_REVIEW_BENCH_BRIDGE, else installed once into a cache prefix
    (FOREMAN_REVIEW_BENCH_CACHE, default <tempdir>/pi-foreman-review-bench-cache). Never the user's Pi agent dir."""
    env = os.environ.get("FOREMAN_REVIEW_BENCH_BRIDGE")
    if env:
        return Path(env).resolve()
    cache = Path(os.environ.get("FOREMAN_REVIEW_BENCH_CACHE") or Path(tempfile.gettempdir()) / "pi-foreman-review-bench-cache")
    pkg = cache / "node_modules" / "pi-claude-bridge"
    want = BRIDGE.rsplit("@", 1)[1]
    manifest = pkg / "package.json"
    if not manifest.is_file() or json.loads(manifest.read_text("utf-8")).get("version") != want:
        npm = shutil.which("npm")
        if not npm:
            raise RuntimeError("npm not found on PATH (needed to install %s)" % BRIDGE)
        cache.mkdir(parents=True, exist_ok=True)
        r = subprocess.run([npm, "install", "--no-audit", "--no-fund", "--prefix", str(cache), BRIDGE, AGENT_SDK],
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=900)
        if r.returncode != 0:
            raise RuntimeError("npm install %s failed: %s" % (BRIDGE, r.stderr.decode("utf-8", "replace")[-500:]))
    return pkg.resolve()


def add_arguments(p):
    p.add_argument("--tasks", required=True, help="a task dir or a folder of task dirs")
    p.add_argument("--models", default=",".join(DEFAULT_MODELS), help="comma-separated provider/model[:thinking]")
    p.add_argument("--repeats", type=int, default=2)
    p.add_argument("--out", default=None, help="run dir (default ~/.pi-foreman/review-bench/<timestamp>)")
    p.add_argument("--jobs", type=int, default=3, help="parallel launches")
    p.add_argument("--token-cap", type=int, default=None, help="stop before the next cell once finished cells used N tokens")
    p.add_argument("--timeout", type=int, default=900, help="seconds per launch")
    p.add_argument("--dry-run", action="store_true", help="validate tasks, prepare one workspace each, launch nothing")
    p.add_argument("--prices", default=None, help="price file (default: bench/prices.json)")


def add_table_arguments(p):
    p.add_argument("--out", required=True, help="the run dir of a review run")
    p.add_argument("--prices", default=None)


def run_args(args):
    tasks = find_tasks(args.tasks)
    if not tasks:
        print("review bench: no task dirs under %s" % args.tasks, file=sys.stderr)
        return 2
    bad = [(t.name, e) for t in tasks for e in validate_task(t)]
    if bad:
        for name, e in bad:
            print("review bench: %s: %s" % (name, e), file=sys.stderr)
        return 1
    models = [m.strip() for m in args.models.split(",") if m.strip()]
    out = Path(args.out).expanduser() if args.out else Path.home() / ".pi-foreman" / "review-bench" / time.strftime("%Y%m%d-%H%M%S")
    if any(w in str(out.resolve()).lower() for w in FORBIDDEN):
        print("review bench: --out must not contain %s" % " or ".join(FORBIDDEN), file=sys.stderr)
        return 2
    prices = foreman_bench.load_prices(args.prices)
    bench = Bench(out, tasks, models, repeats=args.repeats, jobs=args.jobs, token_cap=args.token_cap,
                  timeout=args.timeout, prices=prices, fake_script=os.environ.get("FOREMAN_REVIEW_BENCH_FAKE_SCRIPT"))
    bridged = any(provider_of(m) == BRIDGE_PROVIDER for m in models)
    if args.dry_run:
        print("review bench (dry run): %d task(s), models %s, %d repeat(s), out %s; token source: %s" % (
            len(tasks), ", ".join(models), args.repeats, out, "FOREMAN_BENCH_OAUTH_TOKEN_FILE" if os.environ.get(
                "FOREMAN_BENCH_OAUTH_TOKEN_FILE") else "FOREMAN_BENCH_OAUTH_TOKEN" if os.environ.get(
                "FOREMAN_BENCH_OAUTH_TOKEN") else "none" if bridged else "not needed"))
        return bench.dry_run()
    bench.token = read_token()
    if bridged and not bench.token:
        print("review bench: claude-bridge models need FOREMAN_BENCH_OAUTH_TOKEN_FILE (or FOREMAN_BENCH_OAUTH_TOKEN)",
              file=sys.stderr)
        return 2
    bench.pi_cli = pi_cli_path()
    if not bench.pi_cli.is_file():
        print("review bench: Pi CLI not found at %s (set FOREMAN_PI_CLI)" % bench.pi_cli, file=sys.stderr)
        return 2
    if bridged:
        bench.bridge = bridge_dir()
    return bench.run()


def table_args(args):
    text = render_table(args.out, foreman_bench.load_prices(args.prices))
    out = Path(args.out)
    if (out / "cells").is_dir():
        (out / ("review-bench-%s.md" % out.name)).write_text(text, "utf-8")
    print(text, end="")
    return 0


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv[:1] == ["table"]:
        p = argparse.ArgumentParser(prog="foreman bench review-table")
        add_table_arguments(p)
        return table_args(p.parse_args(argv[1:]))
    p = argparse.ArgumentParser(prog="foreman bench review")
    add_arguments(p)
    return run_args(p.parse_args(argv))


if __name__ == "__main__":
    sys.exit(main())
