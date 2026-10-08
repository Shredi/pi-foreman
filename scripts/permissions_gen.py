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
import sys
from pathlib import Path

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


def render(perms, agent_dir, ledger_helper="tool"):
    baseline = load_baseline()
    if ledger_helper == "off":
        baseline = without_ledger_helper(baseline)
    permission = {"*": "ask"}
    permission.update(baseline.get("tools") or {})
    permission["bash"] = pattern_map(bash_rules(baseline, perms), DENY_BASH_REASON, ("*", "ask"))
    permission["path"] = pattern_map(path_rules(baseline, perms, agent_dir), DENY_PATH_REASON)
    permission["external_directory"] = baseline.get("externalDirectory", "ask")
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
    print(json.dumps({"config": render(perms, agent, helper), "warnings": res["warnings"], "errors": res["errors"]}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
