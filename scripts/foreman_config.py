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

Keys outside safety that the project and session layers cannot loosen either
(IGNORED_KEYS, LAYER_TIGHTEN, ROLE_RULES, TRACE_DIR_IN_WORKSPACE; "*" = any key):

    key                              project / session value
    -------------------------------  -----------------------------------------
    bridge.isolateClaudeConfig       ignored (switching it off loosens the host config isolation)
    providers.*.review               ignored (a review model approves asks)
    providers.*.roles.*.strong       ignored (picks a stronger, costlier model; L1/L3/L2 only)
    providers.*.strongOnRevision     only false is accepted (true relaunches on the strong model)
    ceremony.revisionRounds.<tier>   lower only (a higher limit loosens the review loop)
    ceremony.requireTriage           only true is accepted (false lets the foreman edit untriaged)
    ceremony                         not an object: ignored (null would drop every escalation)
    ceremony.revisionRounds          not an object: ignored
    ceremony.heavySignals            union only (a project can add signals, not remove one)
    ceremony.heavyFileCount          lower only, minimum 1 (a higher count escalates later)
    ceremony.default                 raise only, trivial < standard < heavy
    ceremony.foremanEdits            tighten only, readonly < scratchpad < bounded
    ceremony.scratchDir              narrow only (a subfolder of the earlier value); every layer:
                                     workspace-relative, no '..', not the root, resolves inside,
                                     no symlink below the root. Both keys: a malformed value in
                                     any layer is a config error, replaced by the L1 default
    ceremony.reviewBeforePr          only true is accepted (false lets a PR open unreviewed)
    ceremony.trivialBound.<field>    lower only, minimum 0 (a higher bound lets the foreman edit more)
    ceremony.trivialBound            not an object: ignored
    ceremony.required.<tier>         union only (a project can add required steps, not remove one)
    ceremony.required                not an object: ignored; unknown steps dropped
    sync.repos, retro.proposalMinReviews, compaction.priceTiers   ignored (L1/L3/L2 only)
    intercom.allowRemote, intercom.allowOpenPane, wait.ci         only false is accepted
    close.from                       intersect (a project can only narrow the allowed sources)
    compaction.threshold.<tier>      lower only, minimum 0.3 (a higher threshold compacts later)
    wait.maxSeconds, wait.maxActive  lower only, minimum 1
    roles.*.timeoutMinutes           lower only (a higher limit lets a child run longer)
    python.path                      ignored (it chooses the executable that runs every guard)
    python.*                         ignored
    roles.*.launch                   ignored
    roles.*.file                     ignored (a role file replaces the prompt)
    roles.<id>.tools                 narrow only (intersection with the L1 -> L3 -> L2 list)
    roles.*.codemode                 only false is accepted (true adds the codemode tool)
    providers.*.roles.*.codemode     only false is accepted
    roles.<new id>                   ignored (only ids present after L1 -> L3 -> L2)
    providers.*.roles.<new id>       ignored
    trace.dir                        only inside the workspace (the nearest directory holding
                                     .git at or above the project dir, symlinks resolved),
                                     never inside a .git or .pi directory

providers.*.roles.*.model and providers.*.fallback stay settable from the project (a
project picks its models). roles.*.promptAppend stays settable: repository text reaches
the model anyway and is untrusted input either way. Every other key in the project file
is plain last-wins.
Documented limit: maxThinking is plain last-wins, so a project can raise the thinking
ceiling (it costs money, it grants no access).

Validation uses a supported subset of foreman.schema.json: type (also a list
of types), enum, properties, additionalProperties (false = unknown-key warning,
object = value schema), items, required, minimum, maximum. An unknown key is a
warning. Every layer above L1 is validated on its own before it is merged: an
invalid value under `safety` is dropped from that layer only (list items one by
one), with a warning. An invalid `safety` value left after the merge (an L1 bug)
reverts the whole `safety` subtree to the L1 values (safetyFallback). Any other
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
# Tools a child never gets, whatever roles.<id>.tools says: children reach the foreman through
# contact_supervisor, never through pi-intercom (the adapter also refuses the tool in children).
CHILD_DENIED_TOOLS = ("intercom",)
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


# Keys outside safety that the project and session layers may not set (module docstring).
# One row per rule so a rule can be reverted on its own.
IGNORED_KEYS = [
    (("bridge", "isolateClaudeConfig"), "it loosens the host config isolation"),
    (("providers", "*", "review"), "it loosens: a review model approves asks"),
    (("python", "path"), "it chooses the executable that runs every guard"),
    (("python", "*"), "interpreter settings come from the user or overlay config"),
    (("roles", "*", "launch"), "the launch mode comes from the user or overlay config"),
    (("roles", "*", "file"), "a role file replaces the prompt: user or overlay config only"),
    (("providers", "*", "roles", "*", "strong"), "the strong model is picked in the user or overlay config"),
    (("sync", "repos"), "the repository list comes from the user or overlay config"),
    (("retro", "proposalMinReviews"), "the proposal threshold comes from the user or overlay config"),
    (("compaction", "priceTiers"), "the price tiers come from the user or overlay config"),
]
# Keys outside safety that the project and session layers may only tighten (module docstring),
# compared with the value after the earlier layers. Same rule names as TIGHTEN; a lower_only
# value below LAYER_MINIMUM (the schema minimum) is dropped with a warning too, so a too-low
# project value does not turn into a whole-config schema error.
FOREMAN_EDITS = ("readonly", "scratchpad", "bounded")
LAYER_TIGHTEN = [
    (("providers", "*", "strongOnRevision"), "false_only"),
    (("ceremony", "revisionRounds", "*"), "lower_only"),
    (("ceremony", "requireTriage"), "true_only"),
    (("ceremony", "reviewBeforePr"), "true_only"),
    (("ceremony", "foremanEdits"), ("ordered", FOREMAN_EDITS)),
    (("ceremony", "heavyFileCount"), "lower_only"),
    (("ceremony", "trivialBound", "*"), "lower_only"),
    (("ceremony", "required", "*"), "union"),
    (("roles", "*", "timeoutMinutes"), "lower_only"),
    (("intercom", "allowRemote"), "false_only"),
    (("intercom", "allowOpenPane"), "false_only"),
    (("wait", "ci"), "false_only"),
    (("close", "from"), "intersect"),
    (("compaction", "threshold", "*"), "lower_only_number"),
    (("wait", "maxSeconds"), "lower_only"),
    (("wait", "maxActive"), "lower_only"),
]
LAYER_MINIMUM = {"timeoutMinutes": 1, "revisionRounds": 0, "heavyFileCount": 1,
                 "threshold": 0.3, "maxSeconds": 1, "maxActive": 1}
TIERS = ["trivial", "standard", "heavy"]
# Steps ceremony.required.<tier> may name (the adapter counts each per session).
REQUIRED_STEPS = ["builder", "reviewer", "finalizer"]
# codemode adds a tool, so the project and session layers may only switch it off.
CODEMODE_FALSE_ONLY = True
# roles.<id> in the project and session layers: "intersect" = narrow only. NEW_ROLE_IDS
# "ignore" drops role ids not present after L1 -> L3 -> L2.
ROLE_RULES = {"tools": "intersect"}
NEW_ROLE_IDS = "ignore"
# trace.dir from the project or session layer must resolve inside the workspace.
TRACE_DIR_IN_WORKSPACE = True


def _drop_pattern(node, keys, done, who, why, warnings):
    if not isinstance(node, dict):
        return
    for name in (list(node) if keys[0] == "*" else [keys[0]]):
        if name not in node:
            continue
        path = done + (name,)
        if len(keys) == 1:
            del node[name]
            warnings.append("%s %s ignored: the %s may not set this key (%s)" % (who, ".".join(path), who, why))
        else:
            _drop_pattern(node[name], keys[1:], path, who, why, warnings)


def _tighten_pattern(node, base, keys, rule, done, who, warnings, minimum=0):
    """Apply one LAYER_TIGHTEN rule in place: drop a value that would loosen `base`."""
    if not isinstance(node, dict):
        return
    for name in (list(node) if keys[0] == "*" else [keys[0]]):
        if name not in node:
            continue
        path = done + (name,)
        have = base.get(name) if isinstance(base, dict) else None
        if len(keys) > 1:
            _tighten_pattern(node[name], have, keys[1:], rule, path, who, warnings, minimum)
            continue
        val, label = node[name], who + " " + ".".join(path)
        if isinstance(rule, tuple) and rule[0] == "ordered":
            # ordered enum, tightest first: only a value at or before the earlier layers' one
            order = rule[1]
            if val not in order:
                why = "not one of %s" % ", ".join(order)
            elif have in order and order.index(val) > order.index(have):
                why = "it would loosen the policy"
            else:
                continue
        elif rule in ("false_only", "true_only"):
            want = rule == "true_only"
            if not isinstance(val, bool):
                why = "not a boolean"
            elif val != want and have is not val:
                why = "it would loosen the policy"
            else:
                continue
        elif rule == "union":
            if not isinstance(val, list) or not isinstance(have, list):
                del node[name]
                warnings.append("%s ignored: the %s can only add entries" % (label, who))
                return
            removed = [x for x in have if x not in val]
            if removed:
                warnings.append("%s: entries not removed: %s" % (label, ", ".join(map(str, removed))))
            node[name] = have + [x for x in val if x not in have]
            continue
        elif rule == "intersect":
            if not isinstance(val, list) or not isinstance(have, list):
                del node[name]
                warnings.append("%s ignored: the %s can only narrow it" % (label, who))
                return
            dropped = [x for x in val if x not in have]
            if dropped:
                warnings.append("%s: entries not extended: %s" % (label, ", ".join(map(str, dropped))))
            node[name] = [x for x in have if x in val]
            continue
        else:  # lower_only, lower_only_number
            num = rule == "lower_only_number"
            isnum = lambda v: isinstance(v, (int, float) if num else int) and not isinstance(v, bool)  # noqa: E731
            if not isnum(val):
                why = "not a number" if num else "not an integer"
            elif val < minimum:
                why = "below the minimum %g" % minimum
            elif isnum(have) and val > have:
                why = "it would loosen the policy"
            else:
                continue
        del node[name]
        warnings.append("%s ignored: %s" % (label, why))


def workspace_root(project_dir):
    """The nearest directory at or above project_dir holding `.git` (symlinks resolved), else project_dir."""
    start = Path(os.path.realpath(str(project_dir)))
    for d in [start] + list(start.parents):
        if os.path.lexists(str(d / ".git")):
            return d
    return start


def scratch_dir_parts(val):
    """ceremony.scratchDir -> its path parts, or a string naming why it is invalid."""
    if not isinstance(val, str) or not val.strip():
        return "not a non-empty string"
    if val.startswith(("/", "\\")) or re.match(r"^[A-Za-z]:", val) or os.path.isabs(val):
        return "absolute paths are not allowed"
    parts = [p for p in re.split(r"[\\/]+", val) if p not in ("", ".")]
    if ".." in parts:
        return "'..' is not allowed"
    if not parts:
        return "it must not be the workspace root"
    return parts


def scratch_dir_escape(val, project_dir):
    """Why ceremony.scratchDir resolves outside the workspace (symlinks), or None."""
    parts = scratch_dir_parts(val)
    if isinstance(parts, str):
        return parts
    root = workspace_root(project_dir)
    target = Path(os.path.realpath(os.path.join(str(root), *parts)))
    if target == root or root not in target.parents:
        return "it must resolve inside the workspace and not to its root"
    # no symlink in any component below the workspace root: the real path is the lexical one
    fold = (lambda s: s.lower()) if sys.platform in ("darwin", "win32") else (lambda s: s)
    if fold(str(target)) != fold(str(root.joinpath(*parts))):
        return "it must not pass through a symlink"
    return None


def fix_malformed_ceremony(name, data, l1, errors):
    """A malformed ceremony.foremanEdits / scratchDir in one layer -> config error, L1 default (in place).

    Runs before the layer is merged, so the tighten comparison of later layers sees a valid value."""
    cer = data.get("ceremony")
    if not isinstance(cer, dict):
        return
    defaults = l1.get("ceremony") or {}
    if "foremanEdits" in cer and cer["foremanEdits"] not in FOREMAN_EDITS:
        errors.append("%s ceremony.foremanEdits %r invalid: not one of %s; using %s"
                      % (name, cer["foremanEdits"], ", ".join(FOREMAN_EDITS), defaults.get("foremanEdits")))
        cer["foremanEdits"] = defaults.get("foremanEdits")
    if "scratchDir" in cer:
        why = scratch_dir_parts(cer["scratchDir"])
        if isinstance(why, str):
            errors.append("%s ceremony.scratchDir %r invalid: %s; using %s"
                          % (name, cer["scratchDir"], why, defaults.get("scratchDir")))
            cer["scratchDir"] = defaults.get("scratchDir")


def _restrict_ceremony(base, proj, who, warnings):
    """ceremony from the project or session layer: objects only, signals union, default raise only."""
    if "ceremony" not in proj:
        return
    cer = proj["ceremony"]
    if not isinstance(cer, dict):
        del proj["ceremony"]
        warnings.append("%s ceremony ignored: not an object" % who)
        return
    have = base.get("ceremony") if isinstance(base.get("ceremony"), dict) else {}
    if "revisionRounds" in cer and not isinstance(cer["revisionRounds"], dict):
        del cer["revisionRounds"]
        warnings.append("%s ceremony.revisionRounds ignored: not an object" % who)
    for key in ("trivialBound", "required"):
        if key in cer and not isinstance(cer[key], dict):
            del cer[key]
            warnings.append("%s ceremony.%s ignored: not an object" % (who, key))
    for tier, steps in list((cer.get("required") or {}).items()):
        if not isinstance(steps, list):
            continue
        bad = [x for x in steps if x not in REQUIRED_STEPS]
        if bad:
            warnings.append("%s ceremony.required.%s: unknown steps dropped: %s" % (who, tier, ", ".join(map(str, bad))))
            cer["required"][tier] = [x for x in steps if x in REQUIRED_STEPS]
    if "heavySignals" in cer:
        want, kept = cer["heavySignals"], have.get("heavySignals")
        kept = [x for x in kept if isinstance(x, str)] if isinstance(kept, list) else []
        if not isinstance(want, list) or not all(isinstance(x, str) for x in want):
            del cer["heavySignals"]
            warnings.append("%s ceremony.heavySignals ignored: not a list of strings" % who)
        else:
            removed = [x for x in kept if x not in want]
            if removed:
                warnings.append("%s ceremony.heavySignals: entries not removed: %s" % (who, ", ".join(removed)))
            cer["heavySignals"] = kept + [x for x in want if x not in kept]
    if "default" in cer:
        val, prev = cer["default"], have.get("default")
        if val not in TIERS:
            why = "not a tier"
        elif prev in TIERS and TIERS.index(val) < TIERS.index(prev):
            why = "it would lower the tier"
        else:
            why = None
        if why:
            del cer["default"]
            warnings.append("%s ceremony.default ignored: %s" % (who, why))
    if "scratchDir" in cer:
        # narrow only: the same folder or a subfolder of the earlier layers' value
        val, prev = scratch_dir_parts(cer["scratchDir"]), scratch_dir_parts(have.get("scratchDir"))
        if isinstance(val, str):
            why = val
        elif not isinstance(prev, str) and val[:len(prev)] != prev:
            why = "it may only narrow the folder to a subfolder of %s" % have.get("scratchDir")
        else:
            why = None
        if why:
            del cer["scratchDir"]
            warnings.append("%s ceremony.scratchDir ignored: %s" % (who, why))


def restrict_layer(base, proj, who, warnings, project_dir):
    """Drop or narrow, in place, the non-safety keys the project or session layer may not loosen."""
    _restrict_ceremony(base, proj, who, warnings)
    for keys, why in IGNORED_KEYS:
        _drop_pattern(proj, keys, (), who, why, warnings)
    for keys, rule in LAYER_TIGHTEN:
        minimum = next((LAYER_MINIMUM[k] for k in keys if k in LAYER_MINIMUM), 0)
        _tighten_pattern(proj, base, keys, rule, (), who, warnings, minimum)
    roles = proj.get("roles")
    base_roles = base.get("roles") if isinstance(base.get("roles"), dict) else {}
    if isinstance(roles, dict):
        for rid in list(roles):
            if NEW_ROLE_IDS == "ignore" and rid not in base_roles:
                del roles[rid]
                warnings.append("%s roles.%s ignored: the %s may not add a role" % (who, rid, who))
                continue
            entry = roles[rid]
            for key, rule in ROLE_RULES.items():
                if rule != "intersect" or not isinstance(entry, dict) or key not in entry:
                    continue
                have, want = (base_roles.get(rid) or {}).get(key), entry[key]
                if not isinstance(want, list) or not isinstance(have, list):
                    del entry[key]
                    warnings.append("%s roles.%s.%s ignored: the %s can only narrow it" % (who, rid, key, who))
                    continue
                dropped = [x for x in want if x not in have]
                if dropped:
                    warnings.append("%s roles.%s.%s: entries not extended: %s" % (who, rid, key, ", ".join(map(str, dropped))))
                entry[key] = [x for x in have if x in want]
    def codemode_off_only(entry, label):
        if CODEMODE_FALSE_ONLY and isinstance(entry, dict) and "codemode" in entry and entry["codemode"] is not False:
            del entry["codemode"]
            warnings.append("%s %s.codemode ignored: the %s may only set false (it adds a tool)" % (who, label, who))

    if isinstance(roles, dict):
        for rid, entry in roles.items():
            codemode_off_only(entry, "roles." + rid)
    if isinstance(proj.get("providers"), dict):
        for pname, pentry in proj["providers"].items():
            proles = pentry.get("roles") if isinstance(pentry, dict) else None
            if not isinstance(proles, dict):
                continue
            for rid in list(proles):
                label = "providers.%s.roles.%s" % (pname, rid)
                if NEW_ROLE_IDS == "ignore" and rid not in base_roles:
                    del proles[rid]
                    warnings.append("%s %s ignored: no such role after the user and overlay config" % (who, label))
                else:
                    codemode_off_only(proles[rid], label)
    trace = proj.get("trace")
    if TRACE_DIR_IN_WORKSPACE and isinstance(trace, dict) and isinstance(trace.get("dir"), str):
        root = workspace_root(project_dir)
        target = Path(os.path.realpath(os.path.join(str(project_dir), trace["dir"])))
        if target != root and root not in target.parents:
            del trace["dir"]
            warnings.append("%s trace.dir ignored: it must resolve inside the workspace" % who)
        elif any(part.lower() in (".git", ".pi") for part in target.relative_to(root).parts):
            del trace["dir"]
            warnings.append("%s trace.dir ignored: it must not be inside a .git or .pi directory" % who)


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

def project_apply(base, proj, warnings, who="project", project_dir=None):
    """Merge the project (or session) layer: plain last-wins, except safety only tightens."""
    proj = copy.deepcopy(proj)
    safety = proj.pop("safety", None)
    restrict_layer(base, proj, who, warnings, project_dir or os.getcwd())
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


_SEG = re.compile(r"\.?([^.\[\]]+)|\[(\d+)\]")


def drop_invalid_safety(name, data, schema, warnings):
    """Validate one layer; remove each invalid safety entry from it (in place), with a warning."""
    issues = []
    validate_schema(data, schema, "", issues)
    issues.extend(semantic_issues(data))
    paths = []
    for kind, path, msg in issues:
        if kind == "error" and (path == "safety" or path.startswith("safety.")):
            warnings.append("%s invalid safety value dropped: %s" % (name, msg))
            paths.append([int(m.group(2)) if m.group(2) else m.group(1) for m in _SEG.finditer(path)])
    # higher list indices first, so one deletion does not shift the next
    for segs in sorted(paths, key=lambda p: [x if isinstance(x, int) else -1 for x in p], reverse=True):
        cur = data
        try:
            for seg in segs[:-1]:
                cur = cur[seg]
            del cur[segs[-1]]
        except (KeyError, IndexError, TypeError):
            pass


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
        drop_invalid_safety(name, data, schema, warnings)
        fix_malformed_ceremony(name, data, l1, errors)
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
                cfg = project_apply(cfg, data, warnings, "project", project_dir or os.getcwd())
                layers.append("project")
    if session_json:
        try:
            data = json.loads(session_json)
            if not isinstance(data, dict):
                raise ValueError("not an object")
            drop_invalid_safety("session", data, schema, warnings)
            fix_malformed_ceremony("session", data, l1, errors)
            drop_loosening(data, "session", warnings)
            cfg = project_apply(cfg, data, warnings, "session", project_dir or os.getcwd())
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
    cer = cfg.get("ceremony")
    if isinstance(cer, dict) and "scratchDir" in cer:
        why = scratch_dir_escape(cer["scratchDir"], project_dir or os.getcwd())
        if why:
            fixed = (l1.get("ceremony") or {}).get("scratchDir")
            errors.append("ceremony.scratchDir %r invalid: %s; using %s" % (cer["scratchDir"], why, fixed))
            cer["scratchDir"] = fixed
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
    """Return {model, thinking, codemode, tools[, strong]}; raise ConfigError if unresolvable.

    `strong` ({model, thinking}) is the role's strong model, from the same provider `model`
    came from: the provider's own, or the fallback provider's only when `model` is the
    fallback's too; absent when that provider maps none.
    """
    providers = cfg.get("providers") or {}
    entry = (providers.get(provider) or {}).get("roles", {}).get(role) or {}
    fb = ((providers.get(provider) or {}).get("fallback") or {}).get("provider")
    fentry = ((providers.get(fb) or {}).get("roles", {}).get(role) if fb else None) or {}
    model, thinking = entry.get("model"), entry.get("thinking")
    source = entry
    if not model:
        if not fb or not fentry.get("model"):
            raise ConfigError("role %s has no model for provider %s and no fallback" % (role, provider))
        model, thinking = fentry["model"], fentry.get("thinking")
        source = fentry
    codemode = effective_codemode(cfg, provider, role)
    tools = list((cfg.get("roles") or {}).get(role, {}).get("tools", []))
    if role != "foreman":
        tools = [t for t in tools if t not in CHILD_DENIED_TOOLS]
    if codemode and "codemode" not in tools:
        tools.append("codemode")
    out = {"model": model, "thinking": cap_thinking(thinking, cfg.get("maxThinking")),
           "codemode": codemode, "tools": tools}
    strong = source.get("strong")
    if isinstance(strong, dict) and isinstance(strong.get("model"), str) and strong["model"]:
        out["strong"] = {"model": strong["model"], "thinking": cap_thinking(strong.get("thinking"), cfg.get("maxThinking"))}
    return out


def child_roles(cfg):
    """The built-in child roles, then every other role id of the merged `roles` (not foreman)."""
    extra = sorted(r for r in (cfg.get("roles") or {}) if r != "foreman" and r not in CHILD_ROLES)
    return list(CHILD_ROLES) + extra


def resolve_all(cfg, provider):
    out = {}
    for role in ["foreman"] + child_roles(cfg):
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
        tools = [t for t in (cfg.get("roles") or {}).get(role, {}).get("tools", []) if t not in CHILD_DENIED_TOOLS]
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
