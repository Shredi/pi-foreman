#!/usr/bin/env python3
"""pi-foreman config loader, validator and settings generator (stdlib, 3.9+).

Layers, in merge order (plain last-wins for every key, objects deep-merge,
scalars and lists are replaced):

    L1       <pi-foreman>/config/foreman.defaults.json
    L3       every installed package whose package.json has `pi.foreman.config`
             (under <agent dir>/npm/node_modules, scoped too), plus --l3 PATH
    L2       <agent dir>/foreman.json   (agent dir: --agent-dir, else
             $PI_CODING_AGENT_DIR, else ~/.pi/agent)
    project  <project dir>/.pi/foreman.json, only with --trusted-project
    session  --session-json '<json>'

The project layer is not trusted: for `safety.*` it can only tighten. So is the session
layer: it goes through the same rules. Neither can set a key that is not in the table.

    key                              direction (project value)
    -------------------------------  -----------------------------------------
    safety.children.mayPush          true = permissive; only false is accepted
    safety.review.required           true = strict; only true is accepted
    safety.permissions.deny/ask      union (entries are added, never removed)
    safety.permissions.paths.deny/ask  union
    safety.permissions.projectCommands  ignored with a warning (it loosens: allows commands)
    safety.requiredChildExtensions   union
    safety.git.protectedBranches     union
    safety.git.commit.requiredTrailers / forbiddenTrailers   union
    safety.git.commit.messagePattern ignored (a pattern can loosen the lint)
    safety.git.commit.checkCommand   ignored (it executes a program; L3/L2 only)
    safety.permissions.allow         cannot be extended (result = intersection)
    safety.ops.copyMaxBytes          lower = tighter; only a lower value is accepted
    safety.ops.worktreeDisposable    loosens: ignored with a warning
    safety.ops.baseBranch            loosens: ignored with a warning
    safety.subagents.allowWorkflow   loosening key: ignored with a warning
    any other safety.* key           ignored with a warning

Loosening keys (LOOSEN_ONLY) are set by L1, L3 and L2 only: the project layer
ignores them (above) and the session layer drops them with a warning.

bridge.isolateClaudeConfig (not under safety) is ignored in the project file: switching
it off loosens the isolation of the host's Claude Code config.
Every other key in the project file is plain last-wins.

Validation uses a supported subset of foreman.schema.json: type (also a list
of types), enum, properties, additionalProperties (false = unknown-key warning,
object = value schema), items, required, minimum, maximum. An unknown key is a
warning. An invalid value under `safety` after the merge reverts the whole
`safety` subtree to the L1 values (safetyFallback) with a warning. Any other
invalid value is an error.

Role resolution never falls back silently: a role needs a model in
providers.<p>.roles.<id>, or the provider names `fallback.provider` whose map
resolves it; otherwise it is an error.

Display presets live in the defaults under `displayPresets` (classic, plain).
"""
from __future__ import annotations

import argparse
import copy
import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULTS_PATH = ROOT / "config" / "foreman.defaults.json"
SCHEMA_PATH = ROOT / "config" / "foreman.schema.json"
CHILD_ROLES = ["explorer", "builder", "reviewer", "senior-reviewer", "finalizer"]
THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"]

# project-layer tightening of safety.* (see module docstring)
TIGHTEN = {
    ("children", "mayPush"): "false_only",
    ("review", "required"): "true_only",
    ("permissions", "deny"): "union",
    ("permissions", "ask"): "union",
    ("permissions", "paths", "deny"): "union",
    ("permissions", "paths", "ask"): "union",
    ("requiredChildExtensions",): "union",
    ("git", "protectedBranches"): "union",
    ("git", "commit", "requiredTrailers"): "union",
    ("git", "commit", "forbiddenTrailers"): "union",
    ("permissions", "allow"): "intersect",
    ("ops", "copyMaxBytes"): "lower_only",
}

# safety.* keys that only loosen: never from the project or session layer
LOOSEN_ONLY = [("subagents", "allowWorkflow")]


def drop_loosening(data, layer, warnings):
    """Remove LOOSEN_ONLY keys from a layer dict in place, with a warning each."""
    for keys in LOOSEN_ONLY:
        cur = data.get("safety")
        for k in keys[:-1]:
            cur = cur.get(k) if isinstance(cur, dict) else None
        if isinstance(cur, dict) and keys[-1] in cur:
            del cur[keys[-1]]
            warnings.append("%s safety.%s ignored: a loosening key, set it in the user or overlay config"
                            % (layer, ".".join(keys)))


class ConfigError(Exception):
    pass


def read_json(path):
    with open(str(path), "r", encoding="utf-8") as fh:
        return json.load(fh)


def deep_merge(base, over):
    if isinstance(base, dict) and isinstance(over, dict):
        out = dict(base)
        for k, v in over.items():
            out[k] = deep_merge(base[k], v) if k in base else copy.deepcopy(v)
        return out
    return copy.deepcopy(over)


# ---------------------------------------------------------------- validation

_TYPES = {
    "string": lambda v: isinstance(v, str),
    "integer": lambda v: isinstance(v, int) and not isinstance(v, bool),
    "number": lambda v: isinstance(v, (int, float)) and not isinstance(v, bool),
    "boolean": lambda v: isinstance(v, bool),
    "array": lambda v: isinstance(v, list),
    "object": lambda v: isinstance(v, dict),
    "null": lambda v: v is None,
}


def validate_schema(value, schema, path, issues):
    """Append (kind, path, message) to issues; kind is 'error' or 'warning'."""
    label = path or "<root>"
    t = schema.get("type")
    if t is not None:
        types = t if isinstance(t, list) else [t]
        if not any(_TYPES[x](value) for x in types):
            issues.append(("error", path, "%s: expected %s" % (label, "/".join(types))))
            return
    if "enum" in schema and value not in schema["enum"]:
        issues.append(("error", path, "%s: must be one of %s" % (label, ", ".join(map(str, schema["enum"])))))
        return
    if _TYPES["number"](value):
        if "minimum" in schema and value < schema["minimum"]:
            issues.append(("error", path, "%s: below minimum %s" % (label, schema["minimum"])))
        if "maximum" in schema and value > schema["maximum"]:
            issues.append(("error", path, "%s: above maximum %s" % (label, schema["maximum"])))
    if isinstance(value, dict):
        props = schema.get("properties", {})
        addl = schema.get("additionalProperties", True)
        for req in schema.get("required", []):
            if req not in value:
                issues.append(("error", path, "%s: missing required key %s" % (label, req)))
        for k, v in value.items():
            sub = (path + "." + k) if path else k
            if k in props:
                validate_schema(v, props[k], sub, issues)
            elif addl is False:
                issues.append(("warning", sub, "unknown key %s" % sub))
            elif isinstance(addl, dict):
                validate_schema(v, addl, sub, issues)
    if isinstance(value, list) and isinstance(schema.get("items"), dict):
        for i, v in enumerate(value):
            validate_schema(v, schema["items"], "%s[%d]" % (path, i), issues)


def semantic_issues(cfg):
    """Checks the subset schema cannot express."""
    issues = []
    dn = cfg.get("displayNames")
    presets = cfg.get("displayPresets")
    if isinstance(dn, str) and isinstance(presets, dict) and dn not in presets:
        issues.append(("error", "displayNames", "displayNames: unknown preset %s" % dn))
    commit = ((cfg.get("safety") or {}).get("git") or {}).get("commit") or {}
    if isinstance(commit, dict):
        for key in ("messagePattern", "requiredTrailers", "forbiddenTrailers"):
            val = commit.get(key)
            for pat in (val if isinstance(val, list) else [val]):
                if isinstance(pat, str):
                    try:
                        re.compile(pat)
                    except re.error as exc:
                        path = "safety.git.commit." + key
                        issues.append(("error", path, "%s: invalid regular expression %r (%s)" % (path, pat, exc)))
    return issues


# -------------------------------------------------------------------- layers

def project_apply(base, proj, warnings, who="project"):
    """Merge the project (or session) layer: plain last-wins, except safety only tightens."""
    proj = copy.deepcopy(proj)
    safety = proj.pop("safety", None)
    if isinstance(proj.get("bridge"), dict) and "isolateClaudeConfig" in proj["bridge"]:
        del proj["bridge"]["isolateClaudeConfig"]
        warnings.append(who + " bridge.isolateClaudeConfig ignored: the %s may not set this key" % who)
    merged = deep_merge(base, proj)
    if safety is None:
        return merged
    if not isinstance(safety, dict):
        warnings.append(who + " safety ignored: not an object")
        return merged
    result = copy.deepcopy(base.get("safety", {}))

    def leaves(node, prefix):
        for k, v in node.items():
            if isinstance(v, dict) and (prefix + (k,)) not in TIGHTEN:
                for x in leaves(v, prefix + (k,)):
                    yield x
            else:
                yield prefix + (k,), v

    for keys, val in leaves(safety, ()):
        name = "safety." + ".".join(keys)
        label = who + " " + name
        rule = TIGHTEN.get(keys)
        if rule is None:
            warnings.append("%s ignored: the %s may not set this key" % (label, who))
            continue
        cur = result
        for k in keys[:-1]:
            cur = cur.setdefault(k, {})
            if not isinstance(cur, dict):
                break
        if not isinstance(cur, dict):
            warnings.append("%s ignored: parent is not an object" % label)
            continue
        have = cur.get(keys[-1])
        if rule in ("false_only", "true_only"):
            want = rule == "true_only"
            if not isinstance(val, bool):
                warnings.append("%s ignored: not a boolean" % label)
            elif val == want:
                cur[keys[-1]] = val
            elif have is not val:
                warnings.append("%s ignored: it would loosen the policy" % label)
        elif rule == "lower_only":
            if not isinstance(val, int) or isinstance(val, bool) or val < 0:
                warnings.append("%s ignored: not a non-negative integer" % label)
            elif isinstance(have, int) and not isinstance(have, bool) and val > have:
                warnings.append("%s ignored: it would loosen the policy" % label)
            else:
                cur[keys[-1]] = val
        elif not isinstance(val, list):
            warnings.append("%s ignored: not a list" % label)
        elif rule == "union":
            cur[keys[-1]] = list(have if isinstance(have, list) else []) + [
                x for x in val if x not in (have if isinstance(have, list) else [])]
        elif rule == "intersect":
            if not isinstance(have, list):
                warnings.append("%s ignored: the %s cannot extend allow" % (label, who))
            else:
                dropped = [x for x in val if x not in have]
                if dropped:
                    warnings.append("%s: entries not extended: %s" % (label, ", ".join(map(str, dropped))))
                cur[keys[-1]] = [x for x in have if x in val]
    merged["safety"] = result
    return merged


def resolve_agent_dir(agent_dir=None):
    if agent_dir:
        return Path(agent_dir)
    env = os.environ.get("PI_CODING_AGENT_DIR")
    if env:
        return Path(env)
    return Path.home() / ".pi" / "agent"


def discover_l3(agent_dir):
    """Yield (package name, config path) for installed packages with pi.foreman.config."""
    nm = Path(agent_dir) / "npm" / "node_modules"
    if not nm.is_dir():
        return
    dirs = []
    for entry in sorted(nm.iterdir()):
        if entry.name.startswith("@") and entry.is_dir():
            dirs.extend(sorted(p for p in entry.iterdir() if p.is_dir()))
        elif entry.is_dir():
            dirs.append(entry)
    for d in dirs:
        pj = d / "package.json"
        try:
            data = read_json(pj)
            rel = data["pi"]["foreman"]["config"]
        except (OSError, ValueError, KeyError, TypeError):
            continue
        if isinstance(rel, str):
            yield str(data.get("name") or d.name), d / rel


def load_config(agent_dir=None, project_dir=None, trusted_project=False,
                session_json=None, l3_paths=()):
    """Return the merged-result dict: config, warnings, errors, safetyFallback, layers."""
    warnings, errors, layers = [], [], ["L1"]
    try:
        l1 = read_json(DEFAULTS_PATH)
        schema = read_json(SCHEMA_PATH)
    except (OSError, ValueError) as exc:
        raise ConfigError("cannot read L1 defaults or schema: %s" % exc)
    agent = resolve_agent_dir(agent_dir)
    cfg = copy.deepcopy(l1)

    def load_layer(name, path):
        try:
            data = read_json(path)
        except (OSError, ValueError) as exc:
            errors.append("%s config unreadable (%s): %s" % (name, path, exc))
            return None
        if not isinstance(data, dict):
            errors.append("%s config is not a JSON object (%s)" % (name, path))
            return None
        return data

    l3 = list(discover_l3(agent)) + [(Path(p).name, Path(p)) for p in l3_paths]
    for pkg, path in l3:
        data = load_layer("L3:" + pkg, path)
        if data is not None:
            cfg = deep_merge(cfg, data)
            layers.append("L3:" + pkg)
    l2 = agent / "foreman.json"
    if l2.is_file():
        data = load_layer("L2", l2)
        if data is not None:
            cfg = deep_merge(cfg, data)
            layers.append("L2")
    base_permissions = copy.deepcopy((cfg.get("safety") or {}).get("permissions"))
    if trusted_project:
        pf = Path(project_dir or os.getcwd()) / ".pi" / "foreman.json"
        if pf.is_file():
            data = load_layer("project", pf)
            if data is not None:
                cfg = project_apply(cfg, data, warnings)
                layers.append("project")
    if session_json:
        try:
            data = json.loads(session_json)
            if not isinstance(data, dict):
                raise ValueError("not an object")
            drop_loosening(data, "session", warnings)
            cfg = project_apply(cfg, data, warnings, "session")
            layers.append("session")
        except ValueError as exc:
            errors.append("session config invalid: %s" % exc)

    issues = []
    validate_schema(cfg, schema, "", issues)
    issues.extend(semantic_issues(cfg))
    fallback = False
    for kind, path, msg in issues:
        if kind == "error" and (path == "safety" or path.startswith("safety.")):
            fallback = True
    for kind, path, msg in issues:
        in_safety = path == "safety" or path.startswith("safety.")
        if kind == "warning":
            warnings.append(msg)
        elif in_safety:
            warnings.append("invalid safety value: " + msg)
        else:
            errors.append(msg)
    if fallback:
        cfg["safety"] = copy.deepcopy(l1["safety"])
        base_permissions = copy.deepcopy(l1["safety"].get("permissions"))
        warnings.append("safety config invalid: reverted to L1 safety values")
    # basePermissions: safety.permissions after L1 -> L3 -> L2, before the project and session
    # layers. The adapter overlay enforces what those two added on top of it.
    return {"config": cfg, "warnings": warnings, "errors": errors,
            "safetyFallback": fallback, "layers": layers, "basePermissions": base_permissions}


# ---------------------------------------------------------------- resolution

def effective_codemode(cfg, provider, role):
    pr = ((cfg.get("providers") or {}).get(provider) or {}).get("roles", {}).get(role, {})
    if isinstance(pr.get("codemode"), bool):
        return pr["codemode"]
    return bool((cfg.get("roles") or {}).get(role, {}).get("codemode", False))


def cap_thinking(level, ceiling):
    if level is None or ceiling not in THINKING or level not in THINKING:
        return level
    return level if THINKING.index(level) <= THINKING.index(ceiling) else ceiling


def resolve_role(cfg, role, provider):
    """Return {model, thinking, codemode, tools}; raise ConfigError if unresolvable."""
    providers = cfg.get("providers") or {}
    entry = (providers.get(provider) or {}).get("roles", {}).get(role) or {}
    model, thinking, via = entry.get("model"), entry.get("thinking"), provider
    if not model:
        fb = ((providers.get(provider) or {}).get("fallback") or {}).get("provider")
        fentry = (providers.get(fb) or {}).get("roles", {}).get(role) if fb else None
        if not fb or not fentry or not fentry.get("model"):
            raise ConfigError("role %s has no model for provider %s and no fallback" % (role, provider))
        model, thinking, via = fentry["model"], fentry.get("thinking"), fb
    codemode = effective_codemode(cfg, provider, role)
    tools = list((cfg.get("roles") or {}).get(role, {}).get("tools", []))
    if codemode and "codemode" not in tools:
        tools.append("codemode")
    return {"model": model, "thinking": cap_thinking(thinking, cfg.get("maxThinking")),
            "codemode": codemode, "tools": tools}


def resolve_all(cfg, provider):
    out = {}
    for role in ["foreman"] + CHILD_ROLES:
        try:
            out[role] = resolve_role(cfg, role, provider)
        except ConfigError as exc:
            out[role] = {"error": str(exc)}
    return out


def generate_subagents(cfg):
    """pi-subagents settings block for the five child roles.

    pi-subagents parses agentOverridesByProvider entries with the same parser as
    agentOverrides, so `tools` is accepted per provider. A per-provider `tools`
    array is therefore written only where the provider's codemode switch differs
    from the role default. `forceTopLevelAsync` makes every depth-0 launch detached even
    when a call passes `async: false` (design section 9).
    """
    by_provider, overrides, errors = {}, {}, []
    for role in CHILD_ROLES:
        tools = list((cfg.get("roles") or {}).get(role, {}).get("tools", []))
        if cfg.get("roles", {}).get(role, {}).get("codemode") and "codemode" not in tools:
            tools.append("codemode")
        overrides[role] = {"tools": tools}
    for provider in sorted(cfg.get("providers") or {}):
        entries = {}
        for role in CHILD_ROLES:
            try:
                r = resolve_role(cfg, role, provider)
            except ConfigError as exc:
                errors.append(str(exc))
                continue
            e = {"model": r["model"]}
            if r["thinking"]:
                e["thinking"] = r["thinking"]
            if r["codemode"] != bool(cfg["roles"].get(role, {}).get("codemode")):
                e["tools"] = r["tools"]
            entries[role] = e
        by_provider[provider] = entries
    return {"subagents": {"agentOverridesByProvider": by_provider, "agentOverrides": overrides,
                          "forceTopLevelAsync": True},
            "errors": errors}


def display_name(cfg, role):
    dn = cfg.get("displayNames")
    if isinstance(dn, dict):
        return str(dn.get(role, role))
    preset = (cfg.get("displayPresets") or {}).get(dn) or {}
    return str(preset.get(role, role))


# ----------------------------------------------------------------------- CLI

def build_parser():
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--agent-dir")
    common.add_argument("--project-dir")
    common.add_argument("--trusted-project", action="store_true")
    common.add_argument("--session-json")
    common.add_argument("--l3", action="append", default=[])
    common.add_argument("--json", action="store_true")
    p = argparse.ArgumentParser(prog="foreman_config")
    sub = p.add_subparsers(dest="cmd", required=True)
    for name in ("merged", "validate"):
        s = sub.add_parser(name, parents=[common])
        s.add_argument("--provider")
    s = sub.add_parser("resolve", parents=[common])
    s.add_argument("--role", required=True)
    s.add_argument("--provider", required=True)
    sub.add_parser("generate-subagents", parents=[common])
    s = sub.add_parser("display-name", parents=[common])
    s.add_argument("--role", required=True)
    return p


def emit(args, obj, human):
    if args.json:
        print(json.dumps(obj, indent=2, sort_keys=False))
    else:
        print(human)


def main(argv=None):
    args = build_parser().parse_args(argv)
    try:
        res = load_config(args.agent_dir, args.project_dir, args.trusted_project,
                          args.session_json, args.l3)
    except ConfigError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    cfg = res["config"]
    if args.cmd in ("merged", "validate"):
        out = dict(res)
        if args.provider:
            out["roles"] = resolve_all(cfg, args.provider)
        human = "layers: %s\nwarnings: %d\nerrors: %d" % (
            ", ".join(res["layers"]), len(res["warnings"]), len(res["errors"]))
        human += "".join("\n  warning: " + w for w in res["warnings"])
        human += "".join("\n  error: " + e for e in res["errors"])
        emit(args, out, human)
        return 1 if args.cmd == "validate" and res["errors"] else 0
    if args.cmd == "resolve":
        try:
            out = resolve_role(cfg, args.role, args.provider)
        except ConfigError as exc:
            print(str(exc), file=sys.stderr)
            return 3
        emit(args, out, "%s thinking=%s codemode=%s tools=%s" % (
            out["model"], out["thinking"], out["codemode"], ",".join(out["tools"])))
        return 0
    if args.cmd == "generate-subagents":
        out = generate_subagents(cfg)
        out["warnings"] = res["warnings"]
        print(json.dumps(out, indent=2))
        return 3 if out["errors"] else 0
    if args.cmd == "display-name":
        emit(args, {"role": args.role, "displayName": display_name(cfg, args.role)},
             display_name(cfg, args.role))
        return 0
    return 2


if __name__ == "__main__":
    sys.exit(main())
