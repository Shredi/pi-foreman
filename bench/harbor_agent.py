"""Harbor agents for the pi-foreman benchmark rig (`foreman bench`).

This is the only module in the repository that imports `harbor`. It lives under bench/, is not
installed by setup.mjs and is not imported by core/ or extensions/. It runs inside Harbor's own
interpreter (`harbor run -a bench.harbor_agent:ForemanPi`, with the repository root on
PYTHONPATH).

  ForemanPi  Pi + pi-subagents + this pi-foreman checkout, driven over RPC by
             bench/wait_session.py until the foreman session and every detached child are done.
  PlainPi    Pi alone (plus the provider package), same waiter.

Agent kwargs (`--ak key=value`): preset=<path to a bench preset JSON>, row=<row id>,
driver=rpc|print (print = Harbor's stock adapter style, `pi --print --mode json`).

Rows on the replay fake provider (`foreman-fake`) load tests/replay/fake_provider.ts and
bench/fake_script.json; every other row installs pi-claude-bridge.

Token for real rows: read on the host from FOREMAN_BENCH_OAUTH_TOKEN_FILE (a path outside the
repository) or FOREMAN_BENCH_OAUTH_TOKEN, uploaded as a 0600 file to /tmp/pf-secret in the
container, read and deleted by the waiter and handed to Pi only as CLAUDE_CODE_OAUTH_TOKEN in
its process env. It is never passed via `--ae`, a kwarg or a command line, because Harbor
persists those (see the bench token-persistence notes).
"""
from __future__ import annotations

import json
import os
import shlex
import shutil
import subprocess
import tempfile
from pathlib import Path

from harbor.agents.installed.base import ApiUsageLimitError, BaseInstalledAgent
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

REPO = Path(__file__).resolve().parents[1]
PI_PACKAGE = "@earendil-works/pi-coding-agent"
PI_VERSION = "1.0.0"
SUBAGENTS = "pi-subagents@0.75.0"
BRIDGE = "pi-claude-bridge@0.9.1"
FAKE_PROVIDERS = ("foreman-fake", "foreman-fake-b")
ROLES = ["foreman", "explorer", "builder", "reviewer", "senior-reviewer", "finalizer"]

R_REPO = "/opt/pi-foreman"
R_NPM = "/opt/pf-npm"
R_WORK = "/tmp/pf-bench"
R_SECRET = "/tmp/pf-secret/token"
NVM = '[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh"; '
NODE_INSTALL = (
    "command -v node >/dev/null 2>&1 || { curl -fsSL -o /tmp/nvm-install.sh "
    "https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.2/install.sh && env -u NODE_VERSION bash /tmp/nvm-install.sh "
    '&& . "$HOME/.nvm/nvm.sh" && nvm install 22 && nvm alias default 22; }'
)


def load_row(preset, row_id):
    data = json.loads(Path(preset).read_text("utf-8"))
    for row in data.get("rows") or []:
        if row.get("id") == row_id:
            return dict(row)
    raise ValueError("row %r not found in preset %s" % (row_id, preset))


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


def summarize_logs(logs_dir):
    """Counters only, from the synced /logs/agent: tokens over the foreman and every child
    session, tool calls, approvals and guard blocks from the pi-foreman traces."""
    logs = Path(logs_dir)
    tok = {"input": 0, "cacheRead": 0, "cacheWrite": 0, "output": 0}
    cost = 0.0
    tool_calls = 0
    sessions = 0
    by_model = {}
    for f in sorted((logs / "sessions").rglob("*.jsonl")) if (logs / "sessions").is_dir() else []:
        if "subagent-artifacts" in f.parts:
            continue  # transcripts duplicate the child session file
        sessions += 1
        for line in f.read_text("utf-8", "replace").splitlines():
            try:
                rec = json.loads(line)
            except ValueError:
                continue
            msg = rec.get("message") if rec.get("type") == "message" else None
            if not isinstance(msg, dict) or msg.get("role") != "assistant":
                continue
            usage = msg.get("usage") or {}
            model = "%s/%s" % (msg.get("provider"), msg.get("model"))
            m = by_model.setdefault(model, {"input": 0, "cacheRead": 0, "cacheWrite": 0, "output": 0})
            for k in tok:
                v = int(usage.get(k) or 0)
                tok[k] += v
                m[k] += v
            cost += float((usage.get("cost") or {}).get("total") or 0)
            tool_calls += sum(1 for c in msg.get("content") or [] if isinstance(c, dict) and c.get("type") == "toolCall")
    approvals = guard_blocks = 0
    roles = {}
    for f in sorted((logs / "trace").glob("trace-*.jsonl")) if (logs / "trace").is_dir() else []:
        for line in f.read_text("utf-8", "replace").splitlines():
            try:
                rec = json.loads(line)
            except ValueError:
                continue
            ev = rec.get("event")
            if ev == "ask":
                approvals += 1
            elif ev == "guard" and rec.get("decision") == "deny":
                guard_blocks += 1
            elif ev == "role_launch":
                roles[rec.get("role")] = roles.get(rec.get("role"), 0) + 1
    return {"tokens": dict(tok, total=sum(tok.values())), "tokens_by_model": by_model, "cost_usd": cost,
            "tool_calls": tool_calls, "approvals": approvals, "guard_blocks": guard_blocks, "sessions": sessions,
            "role_launches": roles}


class _BenchPi(BaseInstalledAgent):
    KIND = "foreman"

    def __init__(self, *args, preset=None, row=None, driver=None, **kwargs):
        super().__init__(*args, **kwargs)
        if not preset or not row:
            raise ValueError("bench agents need --ak preset=<file> --ak row=<id>")
        self.row = load_row(str(preset), str(row))
        self.row["agent"] = self.KIND
        self.driver = str(driver or self.row.get("driver") or "rpc")
        if self.driver not in ("rpc", "print"):
            raise ValueError("driver must be rpc or print")
        provider = self.row.setdefault("provider", "foreman-fake")
        self.fake = provider in FAKE_PROVIDERS
        self.row.setdefault("model", "%s/foreman" % provider)
        if self.KIND == "foreman":
            self.row.setdefault("roles", {r: {"model": "%s/%s" % (provider, r)} for r in ROLES})
        self.commit, self.dirty = repo_state()

    def version(self):
        return PI_VERSION

    def get_version_command(self):
        return NVM + "pi --version"

    def packages(self):
        pkgs = []
        if self.KIND == "foreman":
            pkgs += [R_NPM + "/node_modules/pi-subagents", R_REPO]
        if not self.fake:
            pkgs.append(R_NPM + "/node_modules/pi-claude-bridge")
        return pkgs

    async def install(self, environment: BaseEnvironment) -> None:
        await self.ensure_system_dependencies(environment, ("curl", "git", "python3", "ca_certificates"))
        await self.exec_as_root(environment, command="set -e; " + NODE_INSTALL + "; " + NVM +
                                "npm install -g --no-audit --no-fund --ignore-scripts %s@%s && pi --version" % (PI_PACKAGE, PI_VERSION))
        npm = ([SUBAGENTS] if self.KIND == "foreman" else []) + ([] if self.fake else [BRIDGE])
        if npm:
            await self.exec_as_root(environment, command=NVM + "mkdir -p %s && npm install --no-audit --no-fund --prefix %s %s"
                                    % (R_NPM, R_NPM, " ".join(npm)))
        with tempfile.TemporaryDirectory(prefix="pf-bench-repo-") as tmp:
            tracked_copy(tmp)
            await environment.upload_dir(tmp, R_REPO)
        await self.exec_as_root(environment, command="chmod -R a+rX %s; mkdir -p %s && chmod 777 %s" % (R_REPO, R_WORK, R_WORK))

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
        fake_ext = R_REPO + "/tests/replay/fake_provider.ts"
        row["_extensions"] = [fake_ext] if self.fake else []
        row["_required_child_extensions"] = [fake_ext] if self.fake and self.KIND == "foreman" else []
        await self._upload_json(environment, row, R_WORK + "/row.json")
        await self._upload_json(environment, self.render_instruction(instruction), R_WORK + "/instruction.md")
        secret_arg = ""
        token = self._token()
        if token:
            with tempfile.TemporaryDirectory(prefix="pf-bench-s-") as tmp:
                p = Path(tmp) / "token"
                fd = os.open(str(p), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(fd, "w") as fh:
                    fh.write(token)
                await self.exec_as_root(environment, command="mkdir -p /tmp/pf-secret && chmod 777 /tmp/pf-secret")
                await environment.upload_file(p, R_SECRET)
            await self.exec_as_root(environment, command="chmod 666 " + R_SECRET)
            secret_arg = " --secret-file " + R_SECRET
        cap = float(row.get("cap_seconds") or 1800)
        quiet = float(row.get("quiet_seconds") or (3 if self.fake else 10))
        out = str(self.environment_logs_dir)
        cmd = (NVM + "python3 %s/bench/wait_session.py --row %s/row.json --instruction-file %s/instruction.md "
               '--cwd "$PWD" --work %s/w --out %s --driver %s --cap-seconds %s --quiet-seconds %s%s%s'
               % (R_REPO, R_WORK, R_WORK, R_WORK, shlex.quote(out), self.driver, cap, quiet,
                  " --fake-script %s/bench/fake_script.json" % R_REPO if self.fake else "", secret_arg))
        await self.exec_as_agent(environment, command=cmd, timeout_sec=int(cap + 300))
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
        c = summarize_logs(self.logs_dir)
        t = c["tokens"]
        context.n_input_tokens = t["input"] + t["cacheRead"] + t["cacheWrite"]
        context.n_cache_tokens = t["cacheRead"]
        context.n_output_tokens = t["output"]
        context.cost_usd = c["cost_usd"] or None
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
