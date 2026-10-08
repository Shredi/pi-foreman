"""Harbor agents for the pi-foreman benchmark rig (`foreman bench`).

This is the only module in the repository that imports `harbor`. It lives under bench/, is not
installed by setup.mjs and is not imported by core/ or extensions/. It runs inside Harbor's own
interpreter (`harbor run -a bench.harbor_agent:ForemanPi`, with the repository root on
PYTHONPATH).

  ForemanPi  Pi + pi-subagents + this pi-foreman checkout, driven over RPC by
             bench/wait_session.py until the foreman session and every detached child are done.
  PlainPi    Pi alone (plus the provider package), same waiter.

Agent kwargs (`--ak key=value`): preset=<path to a bench preset JSON>, row=<row id>,
driver=rpc|print (print = Harbor's stock adapter style, `pi --print --mode json`),
setup_only=1 (install, then run the zero-model setup checks of bench/wait_session.py
--setup-check instead of the prompt; no model is called).

Rows on the replay fake provider (`foreman-fake`) load tests/replay/fake_provider.ts and
bench/fake_script.json (a row's `replay_tag` is appended to the instruction as a hidden
`[[replay:<tag>]]` marker, so a task's real instruction can be replayed unchanged); every
other row installs pi-claude-bridge plus the Claude Agent SDK and its native binary for the
container's platform.

Token for real rows: read on the host from FOREMAN_BENCH_OAUTH_TOKEN_FILE (a path outside the
repository) or FOREMAN_BENCH_OAUTH_TOKEN, uploaded as a 0600 file to /tmp/pf-secret in the
container, owned by the non-root agent user (AGENT_USER) Pi runs as, read and deleted by the
waiter and handed to Pi only as CLAUDE_CODE_OAUTH_TOKEN in its process env. It is never passed
via `--ae`, a kwarg or a command line, because Harbor persists those (see the bench
token-persistence notes).

Pi, the waiter and the bridge's Claude Code child run as AGENT_USER, not root: Claude Code
refuses --dangerously-skip-permissions as root. install() creates that user and hands it the
task's working dir (chown -R of the image WORKDIR), root's git identity and a prefilled Go build
cache; the verifier still runs as the task's own user (git marks every dir safe system-wide in
the container, so a root verifier can run git on the agent-owned repo).
"""
from __future__ import annotations

import json
import os
import re
import shlex
import shutil
import sys
import subprocess
import tempfile
from pathlib import Path

from harbor.agents.installed.base import ApiUsageLimitError, BaseInstalledAgent
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

REPO = Path(__file__).resolve().parents[1]
PI_PACKAGE = "@earendil-works/pi-coding-agent"
PI_VERSION = "1.1.0"
SUBAGENTS = "pi-subagents@0.75.0"
BRIDGE = "pi-claude-bridge@0.9.2"
# Bridge 0.9.2 asks for ^0.3.293 (0.9.1 and the stage-1 model check used 0.3.288). npm picks
# the platform package (claude-agent-sdk-linux-<arch>) from the SDK's optional dependencies.
AGENT_SDK = "@anthropic-ai/claude-agent-sdk@0.3.293"
FAKE_PROVIDERS = ("foreman-fake", "foreman-fake-b")
PERMISSION_SYSTEM = "@gotgenes/pi-permission-system"
ROLES = ["foreman", "planner", "explorer", "builder", "reviewer", "senior-reviewer", "finalizer"]

R_REPO = "/opt/pi-foreman"
R_NPM = "/opt/pf-npm"
R_WORK = "/tmp/pf-bench"
R_SECRET = "/tmp/pf-secret/token"
CLAUDE_BIN_GLOB = R_NPM + "/node_modules/@anthropic-ai/claude-agent-sdk-linux-*/claude"
# Pi (and so the bridge's Claude Code child) runs as this non-root user: Claude Code refuses
# --dangerously-skip-permissions as root. Node lives in a shared nvm dir that user can read.
AGENT_USER = "pfbench"
AGENT_HOME = "/home/" + AGENT_USER
R_NVM = "/opt/pf-nvm"
NVM = 'export NVM_DIR=%s; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"; ' % R_NVM
NODE_INSTALL = (
    "command -v node >/dev/null 2>&1 || { mkdir -p %s && curl -fsSL -o /tmp/nvm-install.sh "
    "https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.2/install.sh && env -u NODE_VERSION NVM_DIR=%s PROFILE=/dev/null "
    'bash /tmp/nvm-install.sh && export NVM_DIR=%s && . "$NVM_DIR/nvm.sh" && nvm install 22 && nvm alias default 22; }'
    % (R_NVM, R_NVM, R_NVM)
)
# Create the agent user and hand it the task's working dir (the image WORKDIR, the cwd of every
# exec), root's git identity and a prefilled Go build cache. Refuses a system dir as workdir.
AGENT_USER_SETUP = (
    "set -e; id -u {u} >/dev/null 2>&1 || useradd -m -d {h} -s /bin/bash {u} 2>/dev/null "
    "|| adduser -D -h {h} -s /bin/sh {u}; mkdir -p {h}; "
    'case "$PWD" in /|/root|/home|/usr|/usr/*|/etc|/etc/*|/bin|/sbin|/lib|/lib/*|/opt|/tmp|/var|/proc|/sys|/dev) '
    'echo "pf-bench: refusing to hand the system dir $PWD to {u}" >&2; exit 1;; esac; '
    'chown -R {u}: "$PWD"; '
    # The verifier runs as root on a repo now owned by the agent user: no "dubious ownership".
    "if command -v git >/dev/null 2>&1; then git config --system --add safe.directory '*'; fi; "
    "if [ -f /root/.gitconfig ]; then cp /root/.gitconfig {h}/.gitconfig; fi; "
    "if [ -d /root/.cache/go-build ]; then mkdir -p {h}/.cache && cp -a /root/.cache/go-build {h}/.cache/; fi; "
    "chown -R {u}: {h}"
).format(u=AGENT_USER, h=AGENT_HOME)


def load_row(preset, row_id):
    data = json.loads(Path(preset).read_text("utf-8"))
    for row in data.get("rows") or []:
        if row.get("id") == row_id:
            return dict(row)
    raise ValueError("row %r not found in preset %s" % (row_id, preset))


def locked_version(name):
    """Version of a package from packages.lock.json (the single pin list, shared with setup.mjs)."""
    lock = json.loads((REPO / "packages.lock.json").read_text("utf-8"))
    for pkg in lock.get("packages") or []:
        if pkg.get("name") == name and pkg.get("version"):
            return pkg["version"]
    raise ValueError("%s has no version in packages.lock.json" % name)


def repo_state():
    """(commit, dirty) of the pi-foreman checkout the container gets."""
    def git(*a):
        return subprocess.run(["git", "-C", str(REPO)] + list(a), stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                              timeout=60).stdout.decode().strip()
    return git("rev-parse", "HEAD") or None, bool(git("status", "--porcelain", "--untracked-files=no"))


def tracked_copy(dest):
    """Copy the tracked files of this checkout (working-tree content) into dest. Untracked and
    ignored files (.workflow/, local notes) never enter the container, nor do the benchmark
    tasks (their hidden tests and solutions must stay out of the agent's reach)."""
    out = subprocess.run(["git", "-C", str(REPO), "ls-files", "-z"], stdout=subprocess.PIPE, check=True, timeout=60).stdout
    for rel in out.decode("utf-8").split("\0"):
        if not rel or rel.startswith("bench/tasks/"):
            continue
        src = REPO / rel
        if not src.is_file():
            continue
        dst = Path(dest) / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(str(src), str(dst))


CHILD_SESSION = re.compile(r"^subagent-(.+?)-[0-9a-f]{8}-[0-9a-f]{4}-")


def summarize_logs(logs_dir, main_role="main"):
    """Counters only, from the synced /logs/agent: tokens over the foreman and every child
    session (per model and per role), the thinking levels the sessions ran with, tool calls,
    approvals and guard blocks from the pi-foreman traces. A child session's role comes from
    the session name pi-subagents gives it (`subagent-<role>-<run id>-<n>`); every other
    session counts as `main_role`."""
    logs = Path(logs_dir)
    tok = {"input": 0, "cacheRead": 0, "cacheWrite": 0, "output": 0}
    cost = 0.0
    tool_calls = 0
    sessions = 0
    by_model = {}
    by_role = {}
    thinking_by_model = {}
    thinking_by_role = {}
    wait_turns = text_only_turns = codemode_turns = 0
    for f in sorted((logs / "sessions").rglob("*.jsonl")) if (logs / "sessions").is_dir() else []:
        if "subagent-artifacts" in f.parts:
            continue  # transcripts duplicate the child session file
        sessions += 1
        role = main_role
        levels = set()
        models = set()
        for line in f.read_text("utf-8", "replace").splitlines():
            try:
                rec = json.loads(line)
            except ValueError:
                continue
            if rec.get("type") == "session_info":
                hit = CHILD_SESSION.match(str(rec.get("name") or ""))
                role = hit.group(1) if hit else role
            elif rec.get("type") == "thinking_level_change" and rec.get("thinkingLevel"):
                levels.add(str(rec["thinkingLevel"]))
            msg = rec.get("message") if rec.get("type") == "message" else None
            if not isinstance(msg, dict) or msg.get("role") != "assistant":
                continue
            usage = msg.get("usage") or {}
            model = "%s/%s" % (msg.get("provider"), msg.get("model"))
            models.add(model)
            m = by_model.setdefault(model, {"input": 0, "cacheRead": 0, "cacheWrite": 0, "output": 0})
            r = by_role.setdefault(role, {"input": 0, "cacheRead": 0, "cacheWrite": 0, "output": 0})
            for k in tok:
                v = int(usage.get(k) or 0)
                tok[k] += v
                m[k] += v
                r[k] += v
            cost += float((usage.get("cost") or {}).get("total") or 0)
            calls = [c for c in msg.get("content") or [] if isinstance(c, dict) and c.get("type") == "toolCall"]
            tool_calls += len(calls)
            if role == main_role and msg.get("usage"):  # one foreman turn = one assistant message with usage
                names = [str(c.get("name")) + (":" + str((c.get("arguments") or {}).get("action")) if c.get("name") == "subagent" else "") for c in calls]
                if not calls:
                    text_only_turns += 1
                elif all(n in ("bg_wait", "subagent:list", "subagent:status") for n in names):
                    wait_turns += 1
                if any(c.get("name") == "codemode" for c in calls):
                    codemode_turns += 1
        for model in models:
            thinking_by_model.setdefault(model, set()).update(levels)
        if models:
            thinking_by_role.setdefault(role, set()).update(levels)
    approvals = guard_blocks = gate_blocks = revisions = poll_bash = ceremony_incomplete = 0
    foreman_edit_refused = pr_refused = checkpoint_auto = 0
    read_blocks = recheck_blocks = finish_refused = launch_waits = rereviews = orient_lines = 0
    roles = {}
    reviewed = {}
    tiers = {"recorded": None, "tier": None}
    traces = trace_files(logs)
    for f in traces:
        for line in f.read_text("utf-8", "replace").splitlines():
            try:
                rec = json.loads(line)
            except ValueError:
                continue
            if not isinstance(rec, dict):
                continue
            ev = rec.get("event")
            if isinstance(rec.get("pollBash"), int):
                poll_bash += rec["pollBash"]
            if ev == "ceremony_incomplete":
                ceremony_incomplete += 1
            elif ev == "foreman_edit_refused":
                foreman_edit_refused += 1
            elif ev == "pr_refused":
                pr_refused += 1
            elif ev == "read_budget" and rec.get("action") == "deny":
                read_blocks += 1
            elif ev == "recheck_budget" and rec.get("action") == "deny":
                recheck_blocks += 1
            elif ev == "finish_refused":
                finish_refused += 1
            elif ev == "rereview":
                rereviews += 1
            elif ev == "orientation" and isinstance(rec.get("lines"), int):
                orient_lines = rec["lines"]
            elif ev == "launch_wait":
                launch_waits += 1
            elif ev == "checkpoint" and rec.get("by") == "rig" and rec.get("decision") == "approve":
                checkpoint_auto += 1
            if ev == "ask":
                approvals += 1
            elif ev == "guard" and rec.get("decision") == "deny":
                guard_blocks += 1
            elif ev == "role_launch":
                roles[rec.get("role")] = roles.get(rec.get("role"), 0) + 1
            elif ev == "triage" and rec.get("decision") == "recorded" and rec.get("tier"):
                tiers["recorded"] = str(rec["tier"])
            elif ev == "tier" and rec.get("tier"):
                tiers["tier"] = str(rec["tier"])
            elif ev == "triage_gate" and rec.get("decision") == "blocked":
                gate_blocks += 1
            elif ev == "revision" and rec.get("decision") in ("revision", "strong-relaunch"):
                revisions += 1
            elif ev == "review":
                d = str(rec.get("decision"))
                reviewed[d] = reviewed.get(d, 0) + 1
    by_rm = usage_by_role_model(logs)
    log_total = sum(u[k] for m in by_rm.values() for u in m.values() for k in tok)
    out = {"tokens": dict(tok, total=sum(tok.values())), "tokens_by_model": by_model,
           "tokens_by_role": {k: dict(v, total=sum(v.values())) for k, v in by_role.items()},
           "thinking_by_model": {k: sorted(v) for k, v in thinking_by_model.items()},
           "thinking_by_role": {k: sorted(v) for k, v in thinking_by_role.items()}, "cost_usd": cost,
           "tool_calls": tool_calls, "approvals": approvals, "guard_blocks": guard_blocks, "sessions": sessions,
           "role_launches": roles}
    if by_rm:
        out["usage_by_role_model"] = by_rm
        out["usage_log_delta"] = log_total - sum(tok.values())  # usage log total minus session-jsonl total
    if traces:
        out["triage"] = {"tier": tiers["recorded"] or tiers["tier"] or "untriaged", "launches": roles,
                         "revisions": revisions, "gate_blocks": gate_blocks, "asks_reviewed": reviewed,
                         "pollBash": poll_bash, "ceremony_incomplete": ceremony_incomplete,
                         "foreman_edit_refused": foreman_edit_refused, "pr_refused": pr_refused,
                         "checkpoint_auto": checkpoint_auto,
                         "read_blocks": read_blocks, "recheck_blocks": recheck_blocks, "finish_refused": finish_refused,
                         "launch_waits": launch_waits, "wait_turns": wait_turns, "text_only_turns": text_only_turns,
                         "codemode_turns": codemode_turns, "rereviews": rereviews, "orient_lines": orient_lines}
    return out


def trace_files(logs):
    """Trace files of a cell: state/trace-*.jsonl (the copied state dir) and trace/trace-*.jsonl, one per name."""
    seen = {}
    for sub in ("state", "trace"):
        d = Path(logs) / sub
        for f in sorted(d.glob("trace-*.jsonl")) if d.is_dir() else []:
            seen.setdefault(f.name, f)
    return [seen[k] for k in sorted(seen)]


def usage_by_role_model(logs):
    """state/usage/*.jsonl (one line per assistant message_end, foreman and children) as
    {role: {model: {input, cacheRead, cacheWrite, output, n}}}. Role "child" stays its own bucket."""
    out = {}
    d = Path(logs) / "state" / "usage"
    for f in sorted(d.glob("*.jsonl")) if d.is_dir() else []:
        for line in f.read_text("utf-8", "replace").splitlines():
            try:
                rec = json.loads(line)
            except ValueError:
                continue
            if not isinstance(rec, dict):
                continue
            u = out.setdefault(str(rec.get("role") or "unknown"), {}).setdefault(
                str(rec.get("model") or "unknown"), {"input": 0, "cacheRead": 0, "cacheWrite": 0, "output": 0, "n": 0})
            for k in ("input", "cacheRead", "cacheWrite", "output"):
                u[k] += int(rec.get(k) or 0)
            u["n"] += 1
    return out


def usage_log_cost(logs):
    """Sum of cost.total over state/usage/*.jsonl (0.0 for subscription runs, which report no cost)."""
    total = 0.0
    d = Path(logs) / "state" / "usage"
    for f in sorted(d.glob("*.jsonl")) if d.is_dir() else []:
        for line in f.read_text("utf-8", "replace").splitlines():
            try:
                rec = json.loads(line)
            except ValueError:
                continue
            if isinstance(rec, dict) and isinstance(rec.get("cost"), dict):
                total += float(rec["cost"].get("total") or 0)
    return total


def settled_cost(logs, counters):
    """cost_usd for result.json: the usage log's cost.total sum (else the session files' sum); when that is 0 and
    tokens exist, the tokens priced with bench/prices.json through foreman_bench.cost_of (the formatter's lookup)."""
    cost = usage_log_cost(logs) or counters.get("cost_usd") or 0.0
    if cost or not (counters.get("tokens") or {}).get("total"):
        return cost
    sys.path.insert(0, str(REPO / "scripts"))
    try:
        import foreman_bench
        usage = {}
        for model, t in (counters.get("tokens_by_model") or {}).items():
            u = usage.setdefault(str(model).rsplit("/", 1)[-1], {k: 0 for k in foreman_bench.TOKEN_KINDS})
            for k in u:
                u[k] += int(t.get(k) or 0)
        return foreman_bench.cost_of({"usage_by_model": usage}, foreman_bench.load_prices())["usd"] if usage else 0.0
    finally:
        sys.path.remove(str(REPO / "scripts"))


REFUSAL = re.compile(r"safeguards flagged|flagged this message", re.I)


def _assistant_messages(path):
    for line in Path(path).read_text("utf-8", "replace").splitlines():
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        msg = rec.get("message") if isinstance(rec, dict) else None
        if isinstance(msg, dict) and msg.get("role") == "assistant" and rec.get("type") in ("message", "message_end"):
            yield msg


def classify_infra(logs, status, tokens_total):
    """metadata.bench.infra: {"flag", "reason", "detail"}. Reasons known here: usage_limit and provider_refusal
    (waiter status, or a refusal text on an assistant message with stopReason error in the session or rpc files),
    no_model_turn / assistant_error (rpc.jsonl), zero_tokens. interrupted and exception are the harness's
    (foreman_bench.read_trial); a missing flag never overrides them."""
    logs = Path(logs)
    status = status or {}
    if status.get("infra_error") in ("usage_limit", "provider_refusal"):
        return {"flag": True, "reason": status["infra_error"], "detail": str(status.get("error") or "")[:300]}
    files = sorted((logs / "sessions").rglob("*.jsonl")) if (logs / "sessions").is_dir() else []
    rpc = logs / "rpc.jsonl"
    for f in files + ([rpc] if rpc.is_file() else []):
        if "subagent-artifacts" in f.parts:
            continue
        for msg in _assistant_messages(f):
            text = "%s %s" % (msg.get("errorMessage") or "", json.dumps(msg.get("content") or ""))
            if msg.get("stopReason") == "error" and REFUSAL.search(text):
                return {"flag": True, "reason": "provider_refusal", "detail": text.strip()[:300]}
    if rpc.is_file():
        first = next(_assistant_messages(rpc), None)
        if first is None:
            return {"flag": True, "reason": "no_model_turn", "detail": "no assistant message in rpc.jsonl"}
        if first.get("stopReason") == "error":
            return {"flag": True, "reason": "assistant_error", "detail": str(first.get("errorMessage") or "")[:300]}
    if tokens_total is not None and int(tokens_total) == 0:
        return {"flag": True, "reason": "zero_tokens", "detail": "the run used zero model tokens"}
    return {"flag": False, "reason": None, "detail": ""}


class _BenchPi(BaseInstalledAgent):
    KIND = "foreman"

    def __init__(self, *args, preset=None, row=None, driver=None, setup_only=None, cap_seconds=None, **kwargs):
        super().__init__(*args, **kwargs)
        if not preset or not row:
            raise ValueError("bench agents need --ak preset=<file> --ak row=<id>")
        self.row = load_row(str(preset), str(row))
        self.row["agent"] = self.KIND
        if cap_seconds not in (None, ""):
            cap = int(float(cap_seconds))
            if cap > 0:
                self.row["cap_seconds"] = cap
        self.driver = str(driver or self.row.get("driver") or "rpc")
        if self.driver not in ("rpc", "print"):
            raise ValueError("driver must be rpc or print")
        provider = self.row.setdefault("provider", "foreman-fake")
        self.fake = provider in FAKE_PROVIDERS
        self.row.setdefault("model", "%s/foreman" % provider)
        if self.KIND == "foreman":
            self.row.setdefault("roles", {r: {"model": "%s/%s" % (provider, r)} for r in ROLES})
        self.setup_only = str(setup_only or "").lower() in ("1", "true", "yes")
        self.commit, self.dirty = repo_state()

    def version(self):
        return PI_VERSION

    def get_version_command(self):
        return NVM + "pi --version"

    def packages(self):
        pkgs = []
        if self.KIND == "foreman":
            pkgs += [R_NPM + "/node_modules/pi-subagents", R_REPO, R_NPM + "/node_modules/" + PERMISSION_SYSTEM]
        if not self.fake:
            pkgs.append(R_NPM + "/node_modules/pi-claude-bridge")
        return pkgs

    async def install(self, environment: BaseEnvironment) -> None:
        await self.ensure_system_dependencies(environment, ("curl", "git", "python3", "ca_certificates"))
        await self.exec_as_root(environment, command="set -e; " + NODE_INSTALL + "; " + NVM +
                                "npm install -g --no-audit --no-fund --ignore-scripts %s@%s && pi --version" % (PI_PACKAGE, PI_VERSION))
        # Python 3.9+ runs the core, the guards and the waiter; fail the install, not the cell.
        await self.exec_as_root(environment, command="python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)'")
        npm = ([SUBAGENTS, "%s@%s" % (PERMISSION_SYSTEM, locked_version(PERMISSION_SYSTEM))] if self.KIND == "foreman" else []) + ([] if self.fake else [BRIDGE, AGENT_SDK])
        if npm:
            await self.exec_as_root(environment, command=NVM + "mkdir -p %s && npm install --no-audit --no-fund --prefix %s %s"
                                    % (R_NPM, R_NPM, " ".join(npm)))
        if not self.fake:  # fail the install, not the cell, when the native binary is missing
            await self.exec_as_root(environment, command="set -e; b=$(ls %s 2>/dev/null | head -n 1); test -x \"$b\"; "
                                    "\"$b\" --version" % CLAUDE_BIN_GLOB)
        with tempfile.TemporaryDirectory(prefix="pf-bench-repo-") as tmp:
            tracked_copy(tmp)
            await environment.upload_dir(tmp, R_REPO)
        await self.exec_as_root(environment, command=AGENT_USER_SETUP)
        logs = shlex.quote(str(self.environment_logs_dir))
        await self.exec_as_root(environment, command="chmod -R a+rX %s; for d in %s %s; do [ ! -d $d ] || chmod -R a+rX $d; done; "
                                "mkdir -p %s && chmod 777 %s; mkdir -p %s && chown %s: %s"
                                % (R_REPO, R_NPM, R_NVM, R_WORK, R_WORK, logs, AGENT_USER, logs))

    def _token(self):
        path = os.environ.get("FOREMAN_BENCH_OAUTH_TOKEN_FILE")
        if path:
            return Path(path).expanduser().read_text("utf-8").strip() or None
        return os.environ.get("FOREMAN_BENCH_OAUTH_TOKEN") or None

    async def _upload_json(self, environment, data, remote):
        with tempfile.TemporaryDirectory(prefix="pf-bench-") as tmp:
            p = Path(tmp) / "f"
            p.write_text(data if isinstance(data, str) else json.dumps(data, indent=1), "utf-8")
            await environment.upload_file(p, remote)

    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        row = dict(self.row)
        row["_packages"] = self.packages()
        row["_fake"] = self.fake
        row["_permission_system"] = self.KIND == "foreman"
        if not self.fake:
            row["_version_packages"] = [R_NPM + "/node_modules/@anthropic-ai/claude-agent-sdk"]
            row["_claude_bin_glob"] = CLAUDE_BIN_GLOB
        fake_ext = R_REPO + "/tests/replay/fake_provider.ts"
        row["_extensions"] = [fake_ext] if self.fake else []
        row["_required_child_extensions"] = [fake_ext] if self.fake and self.KIND == "foreman" else []
        await self._upload_json(environment, row, R_WORK + "/row.json")
        text = self.render_instruction(instruction)
        if self.fake and row.get("replay_tag"):
            text += "\n\n<!-- [[replay:%s]] -->\n" % row["replay_tag"]
        await self._upload_json(environment, text, R_WORK + "/instruction.md")
        secret_arg = ""
        token = self._token()
        if token:
            with tempfile.TemporaryDirectory(prefix="pf-bench-s-") as tmp:
                p = Path(tmp) / "token"
                fd = os.open(str(p), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(fd, "w") as fh:
                    fh.write(token)
                await self.exec_as_root(environment, command="mkdir -p /tmp/pf-secret")
                await environment.upload_file(p, R_SECRET)
            # Owned by the agent user, 0600, in a 0700 dir: only the waiter (run as that user) can read it.
            await self.exec_as_root(environment, command="chown -R %s: /tmp/pf-secret && chmod 700 /tmp/pf-secret && chmod 600 %s"
                                    % (AGENT_USER, R_SECRET))
            secret_arg = " --secret-file " + R_SECRET
        cap = float(row.get("cap_seconds") or 1800)
        quiet = float(row.get("quiet_seconds") or (3 if self.fake else 10))
        out = str(self.environment_logs_dir)
        cmd = ("export HOME=%s USER=%s LOGNAME=%s; " % (AGENT_HOME, AGENT_USER, AGENT_USER) + NVM +
               "python3 %s/bench/wait_session.py --row %s/row.json --instruction-file %s/instruction.md "
               '--cwd "$PWD" --work %s/w --out %s --driver %s --cap-seconds %s --quiet-seconds %s%s%s%s'
               % (R_REPO, R_WORK, R_WORK, R_WORK, shlex.quote(out), self.driver, cap, quiet,
                  " --fake-script %s/bench/fake_script.json" % R_REPO if self.fake else "", secret_arg,
                  " --setup-check" if self.setup_only else ""))
        await self._exec(environment, cmd, user=AGENT_USER, timeout_sec=int(cap + 300))
        status = self._status()
        if status.get("infra_error") == "usage_limit":
            raise ApiUsageLimitError("provider usage limit reached: %s" % status.get("error", "")[:300])

    def _status(self):
        f = Path(self.logs_dir) / "bench-run.json"
        try:
            return json.loads(f.read_text("utf-8"))
        except (OSError, ValueError):
            return {}

    def populate_context_post_run(self, context: AgentContext) -> None:
        status = self._status()
        c = summarize_logs(self.logs_dir, "foreman" if self.KIND == "foreman" else "main")
        t = c["tokens"]
        context.n_input_tokens = t["input"] + t["cacheRead"] + t["cacheWrite"]
        context.n_cache_tokens = t["cacheRead"]
        context.n_output_tokens = t["output"]
        context.cost_usd = settled_cost(self.logs_dir, c) or None
        # Configured levels; None = unset, i.e. the shipped role default (no level, so Pi's
        # default applies). The levels the sessions actually ran with are in counters.
        thinking = {"main": self.row.get("thinking")}
        thinking.update({r: v.get("thinking") for r, v in (self.row.get("roles") or {}).items()})
        context.metadata = dict(context.metadata or {}, bench={
            "row": self.row.get("id"), "agent": self.KIND, "driver": self.driver,
            "status": status.get("status"), "infra_error": status.get("infra_error"),
            "counters": c,
            "pi_foreman_commit": self.commit, "pi_foreman_dirty": self.dirty,
            "versions": status.get("versions"),
            "model_main": self.row.get("model"),
            "models_by_role": {r: v.get("model") for r, v in (self.row.get("roles") or {}).items()},
            "thinking": thinking,
            "claude_config_dir": status.get("claude_config_dir"),
            "oauth_token_present": status.get("oauth_token_present"),
            "pi_seconds": status.get("pi_seconds"),
            "waiter_start_ms": status.get("waiter_start_ms"), "waiter_end_ms": status.get("waiter_end_ms"),
            "async_runs_at_end": status.get("async_runs_at_end"),
            "setup_check": status.get("setup_check"),
            "asks_denied": status.get("asks_denied") or [],
            "infra": classify_infra(self.logs_dir, status, t["total"]),
        })


class ForemanPi(_BenchPi):
    KIND = "foreman"

    @staticmethod
    def name() -> str:
        return "foreman-pi"


class PlainPi(_BenchPi):
    KIND = "plain"

    @staticmethod
    def name() -> str:
        return "plain-pi"
