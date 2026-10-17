#!/usr/bin/env python3
"""Render the merged safety.permissions into the config of @gotgenes/pi-permission-system.

    python scripts/permissions_gen.py render [--agent-dir DIR]

Input: the packaged baseline (config/permissions.baseline.json) plus the merged
`safety.permissions` of L1 -> L3 -> L2 (foreman_config.load_config without the project and
session layers: those are enforced by the adapter overlay, never written to a file).
Output (stdout): the JSON the installer writes to
<agent dir>/extensions/pi-permission-system/config.json. The installer owns that file;
rules of your own belong in foreman.json (safety.permissions).

Layer lists only ADD to the baseline; no layer can remove a baseline entry.
Order inside one pattern map matters (the last matching rule wins in the permission
system), so every map is built as: catch-all, allow, ask, deny.
"""
from __future__ import annotations

import argparse
import json
import ntpath
import os
import posixpath
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path, PurePosixPath, PureWindowsPath

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import foreman_config as fc  # noqa: E402

BASELINE_PATH = fc.ROOT / "config" / "permissions.baseline.json"
REVIEW_LINK = "foreman-review"
DENY_BASH_REASON = "pi-foreman safety policy: this command is denied (safety.permissions.deny / baseline)"
DENY_PATH_REASON = "pi-foreman safety policy: this path is denied (safety.permissions.paths.deny / baseline)"


def load_baseline():
    return fc.read_json(BASELINE_PATH)


def strings(value):
    return [x for x in value if isinstance(x, str) and x] if isinstance(value, list) else []


def subst(patterns, agent_dir):
    d = Path(agent_dir).as_posix()
    return [p.replace("{agentDir}", d) for p in patterns]


def path_rules(baseline, perms, agent_dir):
    """Ordered [(pattern, state)] for the path surface: ask, baseline deny, exceptions, extra deny."""
    paths = (perms or {}).get("paths") or {}
    base = baseline.get("paths") or {}
    out = [(p, "ask") for p in subst(strings(paths.get("ask")), agent_dir)]
    out += [(p, "deny") for p in subst(strings(base.get("deny")), agent_dir)]
    out += [(p, "allow") for p in subst(strings(base.get("except")), agent_dir)]
    out += [(p, "deny") for p in subst(strings(paths.get("deny")), agent_dir)]
    return out


def bash_rules(baseline, perms):
    """Ordered [(pattern, state)] for the bash surface (catch-all excluded)."""
    perms = perms or {}
    base = baseline.get("bash") or {}
    out = [(p, "allow") for p in strings(base.get("allow"))]
    out += [(p, "allow") for p in strings(perms.get("projectCommands"))]
    out += [(p, "allow") for p in strings(perms.get("allow"))]
    out += [(p, "ask") for p in strings(base.get("ask"))]
    out += [(p, "ask") for p in strings(perms.get("ask"))]
    out += [(p, "deny") for p in strings(base.get("deny"))]
    out += [(p, "deny") for p in strings(perms.get("deny"))]
    return out


def pattern_map(rules, deny_reason, first=None):
    """Dict in rule order; a repeated pattern moves to the position of its last rule."""
    m = {}
    if first:
        m[first[0]] = first[1]
    for pattern, state in rules:
        m.pop(pattern, None)
        m[pattern] = {"action": "deny", "reason": deny_reason} if state == "deny" else state
    return m


# Baseline entries that exist only for ceremony.ledgerHelper tool/bash; "off" renders without them.
LEDGER_HELPER_TOOLS = ("foreman_ledger",)
LEDGER_HELPER_BASH = ("ledger defer *",)


def without_ledger_helper(baseline):
    out = dict(baseline)
    out["tools"] = {k: v for k, v in (baseline.get("tools") or {}).items() if k not in LEDGER_HELPER_TOOLS}
    bash = dict(baseline.get("bash") or {})
    bash["allow"] = [p for p in strings(bash.get("allow")) if p not in LEDGER_HELPER_BASH]
    out["bash"] = bash
    return out


SCRATCH_DIR_NAME = "pi-foreman-scratch"  # childscratch.ts SCRATCH_DIR_NAME
NPM_TIMEOUT_S = 4


def resolve_npm_root(run=None, env=None, platform=None, which=None):
    """`npm root -g` (4 s cap), else <npm_config_prefix>/lib/node_modules, else the prefix of the node
    binary, on Windows %AppData%\\npm\\node_modules. None when nothing resolves. Mirrors owned.ts."""
    run = run or subprocess.run
    env = os.environ if env is None else env
    platform = platform or sys.platform
    which = which or shutil.which
    win = platform.startswith("win")
    # path flavour follows the target platform, not the host (a POSIX path is not absolute on a Windows host)
    isabs = ntpath.isabs if win else posixpath.isabs
    P = PureWindowsPath if win else PurePosixPath
    npm = which("npm")
    if npm:
        try:
            r = run([npm, "root", "-g"], capture_output=True, text=True, timeout=NPM_TIMEOUT_S)
            lines = [x.strip() for x in (r.stdout or "").splitlines() if x.strip()]
            if r.returncode == 0 and lines and isabs(lines[-1]):
                return P(lines[-1]).as_posix()
        except (OSError, subprocess.SubprocessError):
            pass
    prefix = env.get("npm_config_prefix") or env.get("NPM_CONFIG_PREFIX")
    if win:
        if prefix:
            return P(prefix, "node_modules").as_posix()
        appdata = env.get("APPDATA")
        return P(appdata, "npm", "node_modules").as_posix() if appdata else None
    if not prefix:
        node = which("node")
        if node:
            prefix = str(Path(os.path.realpath(node)).parent.parent)
    return P(prefix, "lib", "node_modules").as_posix() if prefix else None


def default_owned():
    """Machine-dependent tokens of the external_directory patterns."""
    tmp = os.path.realpath(tempfile.gettempdir())
    return {"scratchRoot": Path(tmp, SCRATCH_DIR_NAME).as_posix(), "npmRoot": resolve_npm_root()}


def hub_read_patterns(hub):
    """external_directory_read keys of `paths.hubWorkflow` (string or list of absolute dirs): each `<dir>/.workflow` and its subtree."""
    out = []
    for d in strings([hub] if isinstance(hub, str) else hub):
        if not (posixpath.isabs(d) or ntpath.isabs(d)) or ".." in d.replace("\\", "/").split("/"):
            continue
        p = Path(d).as_posix().rstrip("/")
        if not p or p.endswith(":"):
            continue
        out += [p + "/.workflow", p + "/.workflow/*"]
    return out


def probe_read_patterns(probe, home=None, platform=None, env=None):
    """external_directory_read keys of `externalDirectory.probe` (toolchain bin dirs, the npx cache): each dir and its subtree. A leading `~` is the
    home dir, `%APPDATA%` resolves only on Windows (else the entry is dropped), a relative or unresolved entry is dropped. Read keys only."""
    platform = platform or sys.platform
    env = os.environ if env is None else env
    home = Path.home().as_posix() if home is None else home
    win = platform.startswith("win")
    out = []
    for p in strings(probe):
        if p == "~" or p.startswith("~/"):
            if not home:
                continue
            p = home.rstrip("/") + p[1:]
        if "%APPDATA%" in p:
            appdata = env.get("APPDATA") if win else None
            if not appdata or not ntpath.isabs(appdata):
                continue
            p = p.replace("%APPDATA%", PureWindowsPath(appdata).as_posix())
        p = p.rstrip("/")
        if not p or "{" in p or "%" in p or not (posixpath.isabs(p) or ntpath.isabs(p)):
            continue
        out += [p, p + "/*"]
    return out


def external_rules(baseline, agent_dir, owned):
    """(bare map, read map): external_directory and external_directory_read. Last match wins, so the
    catch-all comes first and the asks last; a pattern whose token did not resolve is dropped."""
    ext = baseline.get("externalDirectory")
    if not isinstance(ext, dict):  # older baseline: one state for everything
        return ext or "ask", None
    tokens = {"{agentDir}": Path(agent_dir).as_posix()}
    tokens.update({"{%s}" % k: v for k, v in (owned or {}).items() if v})

    def fill(patterns):
        out = []
        for p in strings(patterns):
            for t, v in tokens.items():
                p = p.replace(t, v)
            if "{" not in p:
                out.append(p)
        return out

    bare = {"*": "ask"}
    for p in fill(ext.get("allow")):
        bare[p] = "allow"
    for p in fill(ext.get("ask")):
        bare[p] = "ask"
    read = {p: "allow" for p in fill(ext.get("read"))}
    read.update({p: "allow" for p in probe_read_patterns(ext.get("probe"))})
    return bare, read or None


def render(perms, agent_dir, ledger_helper="tool", owned=None, hub=None):
    baseline = load_baseline()
    if ledger_helper == "off":
        baseline = without_ledger_helper(baseline)
    permission = {"*": "ask"}
    permission.update(baseline.get("tools") or {})
    permission["bash"] = pattern_map(bash_rules(baseline, perms), DENY_BASH_REASON, ("*", "ask"))
    permission["path"] = pattern_map(path_rules(baseline, perms, agent_dir), DENY_PATH_REASON)
    bare, read = external_rules(baseline, agent_dir, default_owned() if owned is None else owned)
    permission["external_directory"] = bare
    extra = hub_read_patterns(hub)
    if extra:
        read = dict(read or {})
        read.update({p: "allow" for p in extra})
    if read:
        permission["external_directory_read"] = read
    out = {"permission": permission}
    if baseline.get("shellTools"):
        out["shellTools"] = baseline["shellTools"]
    out["permissionReviewLog"] = True
    # model review of asks: pi-foreman's own link (extensions/core-adapter/review.ts)
    out["authorizerChain"] = [REVIEW_LINK]
    return out


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("cmd", choices=["render"])
    p.add_argument("--agent-dir")
    args = p.parse_args(argv)
    try:
        res = fc.load_config(args.agent_dir)
    except fc.ConfigError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    perms = (res["config"].get("safety") or {}).get("permissions") or {}
    agent = fc.resolve_agent_dir(args.agent_dir)
    helper = (res["config"].get("ceremony") or {}).get("ledgerHelper", "tool")
    print(json.dumps({"config": render(perms, agent, helper, hub=(res["config"].get("paths") or {}).get("hubWorkflow")), "warnings": res["warnings"], "errors": res["errors"]}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
