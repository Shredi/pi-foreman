#!/usr/bin/env python3
"""pi-foreman config loader, validator and settings generator (stdlib, 3.13+).

Layers, in merge order (plain last-wins for every key, objects deep-merge,
scalars and lists are replaced):

    L1       <pi-foreman>/config/foreman.defaults.json
    L3       every installed package whose package.json has `pi.foreman.config`
             (under <agent dir>/npm/node_modules, scoped too), plus --l3 PATH
    L2       <agent dir>/foreman.json   (agent dir: --agent-dir, else
             $PI_CODING_AGENT_DIR, else ~/.pi/agent; `merged` and `validate` take
             --user-file PATH to read another file in this place)
    project  <project dir>/.pi/foreman.json, only with --trusted-project
    session  --session-json '<json>'

The project layer is not trusted: for `safety.*` it can only tighten. So is the session
layer: it goes through the same rules. Neither can set a key that is not in the table.

    key                              direction (project value)
    -------------------------------  -----------------------------------------
    safety.children.mayPush          true = permissive; only false is accepted
    safety.review.required           true = strict; only true is accepted
    safety.requiredChildExtensions   union
    safety.git.protectedBranches     union
    safety.git.commit.requiredTrailers / forbiddenTrailers   union
    safety.git.commit.messagePattern ignored (a pattern can loosen the lint)
    safety.git.commit.checkCommand   ignored (it executes a program; L3/L2 only)
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
    paths.hubWorkflow                ignored (it loosens: dirs outside the worktree become readable)
    bridge.isolateClaudeConfig       ignored (switching it off loosens the host config isolation)
    providers.*.review               ignored (a review model approves asks)
    providers.*.roles.*.strong       ignored (picks a stronger, costlier model; L1/L3/L2 only)
    providers.*.strongOnRevision     only false is accepted (true relaunches on the strong model)
    providers.*.cache.ttlSeconds / billing / warmCompact / byModel   ignored (the cache policy: L1/L3/L2 only)
    providers.*.cache.keepalive.intervalSeconds   ignored (L1/L3/L2 only)
    providers.*.cache.keepalive.enabled   only false is accepted (true keeps the session warm at a cost)
    providers.*.cache.keepalive.windowMinutes   lower only, minimum 1; without an earlier value at most 45
    providers.*.cache.keepalive.budgetShare   lower only (at most 0.5 without an earlier value)
    providers.*.cache.keepalive.awayTicks   lower only (at most 0 without an earlier value)
    providers.*.cache.keepalive.selfWarmWindowMinutes   lower only, minimum 1 (at most 180 without an earlier value)
    providers.*.cache.keepalive.compactMinTokens   higher only (at least 100000 without an earlier value)
    ladder.idleDownshift.enabled     only false is accepted; .causes: intersect (a project can only remove causes)
    providers.*.cache.keepalive.whileWaiting / beyondPiCap   only false is accepted
    providers.*.roles.*.idle         ignored (picks the model of a cold idle turn; L1/L3/L2 only)
    presence.enabled                 only true is accepted (more gating is the tightening direction)
    presence.awayAfterMinutes        lower only, minimum 1; without an earlier value at most 11
    presence.command                 ignored (SECURITY: it runs a program)
    providers.*.cache (or .keepalive)   not an object: ignored
    ladder.strongOnRevision, roles.*.strongOnRevision   only false is accepted (true climbs after a FAIL)
    tools.git                        only false is accepted (true adds tools)
    tools.pr                         only false is accepted (true adds tools)
    tools.prHost                     ignored (it picks the program the PR tools run)
    tools.prShared                   ignored (it starts a machine-wide poller of the PR host: user or overlay only)
    tools.prInteractions             ignored (patterns that register PRs from commands: user or overlay only)
    sidebar.statusCommand / statusSeconds   ignored (the command runs a program: L1/L3/L2 only)
    childMaxThinking                 lower only (off < ... < max)
    ladder.* (but strongOnRevision), providers.*.ranks   ignored (the ladder and the child rank policy: L1/L3/L2 only)
    providers.*.modelDataFrom        ignored (it decides the reserve setup writes: L1/L3/L2 only)
    providers.*.strongAbove / childMaxTurns, roles.*.strongAbove / childMaxTurns   ignored (ladder)
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
    ceremony.foremanReads.<phase>.<warn|every>  lower only, minimum 1 (a higher value lets the foreman read more before a reminder)
    ceremony.recheckBudget           lower only, minimum 0
    ceremony.launchWait              tighten only, detach < block (may only move to block)
    ceremony.dedupeNotify            only true is accepted
    ceremony.reviewGate              tighten only, verdict < pass (may only move to pass)
    ceremony.orientation.<enabled|maxLines>   free per layer (no tighten rule)
    ceremony.ledgerHelper            tighten only, off < bash < tool (may only move toward off)
    ceremony.reviewPerRevision       only true is accepted (false lifts the one-review-per-revision refusal)
    ceremony.checkpoint              ignored (who approves the plan checkpoint: L1/L3/L2 only)
    ceremony.reviewModel             ignored (the fallback reviewer model: L1/L3/L2 only)
    ceremony.reviewByOccasion        ignored (per-occasion reviewer thinking/model: L1/L3/L2 only)
    ceremony.planReview.<tier>       only true is accepted (false skips the plan review)
    ceremony.planReviewRounds        free per layer (no tighten rule)
    ceremony.planner                 free per layer (self | role; no tighten rule)
    ceremony.reviewRuns              lower only, minimum 1 (a higher cap allows more review runs per user prompt)
    ceremony.budgetUsd               lower only, minimum 0.01 (a higher cap, or none, lets a session spend more); unset = no cap
    ceremony.childTimeoutSeconds     lower only, minimum 1 (a higher limit lets a child tool call run longer)
    ceremony.launchTimeoutCapMinutes lower only, minimum 1 (a higher cap lets a child run longer)
    ceremony.heavyThreshold          tighten only, eee843d < strict (may only move toward eee843d, which escalates more)
    ceremony.trivialBound.<field>    lower only, minimum 0 (a higher bound lets the foreman edit more)
    ceremony.trivialBound            not an object: ignored
    ceremony.foremanReads[.<phase>]  not an object: ignored
    ceremony.required.<tier>         union only (a project can add required steps, not remove one)
    ceremony.required                not an object: ignored; unknown steps dropped
    sync.repos, retro.proposalMinReviews, retro.panelThreshold   ignored (L1/L3/L2 only)
    intercom.allowRemote, intercom.allowOpenPane, wait.ci         only false is accepted
    close.from                       intersect (a project can only narrow the allowed sources)
    close.autoClean                  only false is accepted (true removes worktrees and scratch at close)
    close.worktreeDir                ignored (the worktree convention: L1/L3/L2 only)
    close.childWaitMs                ignored (how long a close waits for child sessions: L1/L3/L2 only)
    sessions.machines                ignored (the machines a session may open on over SSH: user or overlay config only)
    sessions.pull, sessions.ssh      ignored (the pull poll periods and SSH multiplexing: user or overlay config only)
    sessions.backend, sessions.hc    ignored (where a local session opens and the herdr-core options: user or overlay config only)
    sessions.remoteInlineMaxBytes    lower only, minimum 1024 (a higher cap sends more of a remote result inline)
    compaction.maxTokens             lower only, minimum 50000 (a higher cap compacts later); a null is dropped;
                                     the session layer is ignored with a warning (setup applies it)
    compaction.priceTiers, compaction.threshold   removed in r52: a warning, the keys are dropped (see REMOVED_COMPACTION_KEYS)
    wait.maxSeconds, wait.maxActive  lower only, minimum 1
    roles.*.timeoutMinutes           lower only (a higher limit lets a child run longer)
    python.path                      ignored (it chooses the executable that runs every guard)
    python.*                         ignored
    roles.*.launch                   ignored
    roles.*.file                     ignored (a role file replaces the prompt)
    roles.*.mcp                      ignored (an MCP server runs a command: user or overlay config only)
    roles.*.skills                   ignored (the skill list comes from the user or overlay config)
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
object = value schema), items, required, minimum, maximum, pattern (strings; re.search). An unknown key is a
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
import datetime
import fnmatch
import json
import os
import re
import shlex
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULTS_PATH = ROOT / "config" / "foreman.defaults.json"
SCHEMA_PATH = ROOT / "config" / "foreman.schema.json"
CHILD_ROLES = ["planner", "explorer", "builder", "reviewer", "senior-reviewer", "finalizer"]
# Role whose mapped model is the model of sessions opened by `foreman session open`; never a launchable child.
SESSION_FOREMAN = "session-foreman"
# Tools a child never gets, whatever roles.<id>.tools says: children reach the foreman through
# contact_supervisor, never through pi-intercom (the adapter also refuses the tool in children).
CHILD_DENIED_TOOLS = ("intercom", "pr_create", "pr_watch", "pr_track", "pr_untrack")
THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"]

# project-layer tightening of safety.* (see module docstring)
TIGHTEN = {
    ("children", "mayPush"): "false_only",
    ("review", "required"): "true_only",
    ("requiredChildExtensions",): "union",
    ("git", "protectedBranches"): "union",
    ("git", "commit", "requiredTrailers"): "union",
    ("git", "commit", "forbiddenTrailers"): "union",
    ("ops", "copyMaxBytes"): "lower_only",
}

# safety.* keys that only loosen: never from the project or session layer
LOOSEN_ONLY = [("subagents", "allowWorkflow")]


# Keys outside safety that the project and session layers may not set (module docstring).
# One row per rule so a rule can be reverted on its own.
IGNORED_KEYS = [
    (("profile",), "the setup profile is recorded in the user or overlay config"),
    (("paths", "hubWorkflow"), "it loosens: it makes dirs outside the worktree readable; user or overlay config only"),
    (("bridge", "isolateClaudeConfig"), "it loosens the host config isolation"),
    (("bridge", "promptCacheTtl"), "the bridge cache TTL comes from the user or overlay config"),
    (("providers", "*", "review"), "it loosens: a review model approves asks"),
    (("providers", "*", "roles", "review"), "it loosens: the gate's review model approves asks; user or overlay config only"),
    (("roles", "review"), "it loosens: the gate's review model approves asks; user or overlay config only"),
    (("providers", "*", "cache", "ttlSeconds"), "the cache policy comes from the user or overlay config"),
    (("providers", "*", "cache", "billing"), "the cache policy comes from the user or overlay config"),
    (("providers", "*", "cache", "keepalive", "intervalSeconds"), "the cache policy comes from the user or overlay config"),
    (("providers", "*", "cache", "warmCompact"), "the cache policy comes from the user or overlay config"),
    (("providers", "*", "cache", "byModel"), "the cache policy comes from the user or overlay config"),
    (("providers", "*", "roles", "*", "idle"), "the idle model is picked in the user or overlay config"),
    (("presence", "command"), "SECURITY: it runs a program; user or overlay config only"),
    (("python", "path"), "it chooses the executable that runs every guard"),
    (("python", "*"), "interpreter settings come from the user or overlay config"),
    (("roles", "*", "launch"), "the launch mode comes from the user or overlay config"),
    (("roles", "*", "file"), "a role file replaces the prompt: user or overlay config only"),
    (("roles", "*", "mcp"), "an MCP server runs a command: user or overlay config only"),
    (("mcp", "directProviders"), "the providers that get MCP tools declared up front come from the user or overlay config"),
    (("roles", "*", "skills"), "the skills a role gets come from the user or overlay config"),
    (("providers", "*", "roles", "*", "strong"), "the strong model is picked in the user or overlay config"),
    (("tools", "prHost"), "the PR host program comes from the user or overlay config"),
    (("tools", "prShared"), "the shared PR watch comes from the user or overlay config"),
    (("tools", "prInteractions"), "the PR interaction patterns come from the user or overlay config"),
    (("sidebar", "statusCommand"), "the sidebar status command runs a program: user or overlay config only"),
    (("sidebar", "statusSeconds"), "the sidebar status interval comes from the user or overlay config"),
    (("sync", "repos"), "the repository list comes from the user or overlay config"),
    (("retro", "proposalMinReviews"), "the proposal threshold comes from the user or overlay config"),
    (("retro", "backlogDir"), "the backlog location comes from the user or overlay config"),
    (("retro", "repoBacklog"), "repository backlogs come from the user or overlay config"),
    (("retro", "workspaceKey"), "the backlog key comes from the user or overlay config"),
    (("retro", "panelThreshold"), "the panel threshold comes from the user or overlay config"),
    (("close", "worktreeDir"), "the worktree convention comes from the user or overlay config"),
    (("close", "childWaitMs"), "the child close wait comes from the user or overlay config"),
    (("sessions", "machines"), "the machines a session may open on over SSH come from the user or overlay config"),
    (("sessions", "pull"), "the remote pull poll periods come from the user or overlay config"),
    (("sessions", "ssh"), "the SSH multiplexing switch comes from the user or overlay config"),
    (("sessions", "backend"), "where a local session opens comes from the user or overlay config"),
    (("sessions", "hc"), "the herdr-core session options come from the user or overlay config"),
    (("ceremony", "checkpoint"), "who approves the plan checkpoint comes from the user or overlay config"),
    (("ceremony", "reviewModel"), "the fallback reviewer model comes from the user or overlay config"),
    (("ceremony", "reviewByOccasion"), "the per-occasion reviewer overrides come from the user or overlay config"),
    (("resources", "sampleSeconds"), "the sampling interval comes from the user or overlay config"),
    (("ladder", "strongAbove"), "the ladder and the child rank policy come from the user or overlay config"),
    (("ladder", "childMaxTurns"), "the ladder and the child rank policy come from the user or overlay config"),
    (("ladder", "childPolicy"), "the ladder and the child rank policy come from the user or overlay config"),
    (("ladder", "rolePolicy"), "the ladder and the child rank policy come from the user or overlay config"),
    (("ladder", "maxTurns"), "the ladder and the child rank policy come from the user or overlay config"),
    (("ladder", "reviewerClimb"), "the ladder and the child rank policy come from the user or overlay config"),
    (("ladder", "research"), "the fact-critical research rung comes from the user or overlay config"),
    (("ladder", "reviewPanel"), "the review panel's models come from the user or overlay config"),
    (("ladder", "sizing"), "the launch sizing rules come from the user or overlay config"),
    (("providers", "*", "ranks"), "model ranks decide which children may launch: user or overlay config only"),
    (("providers", "*", "modelDataFrom"), "it decides the reserve setup writes: user or overlay config only"),
    (("providers", "*", "strongAbove"), "the ladder comes from the user or overlay config"),
    (("providers", "*", "childMaxTurns"), "the ladder comes from the user or overlay config"),
    (("roles", "*", "strongAbove"), "the ladder comes from the user or overlay config"),
    (("roles", "*", "childMaxTurns"), "the ladder comes from the user or overlay config"),
]
# Keys outside safety that the project and session layers may only tighten (module docstring),
# compared with the value after the earlier layers. Same rule names as TIGHTEN; a lower_only
# value below LAYER_MINIMUM (the schema minimum) is dropped with a warning too, so a too-low
# project value does not turn into a whole-config schema error.
FOREMAN_EDITS = ("readonly", "scratchpad", "bounded")
LAYER_TIGHTEN = [
    (("providers", "*", "strongOnRevision"), "false_only"),
    (("providers", "*", "cache", "keepalive", "enabled"), "false_only"),
    (("providers", "*", "cache", "keepalive", "windowMinutes"), "lower_only"),
    (("providers", "*", "cache", "keepalive", "budgetShare"), "lower_only_number"),
    (("providers", "*", "cache", "keepalive", "awayTicks"), "lower_only"),
    (("providers", "*", "cache", "keepalive", "selfWarmWindowMinutes"), "lower_only"),
    (("providers", "*", "cache", "keepalive", "compactMinTokens"), "higher_only"),
    (("providers", "*", "cache", "keepalive", "whileWaiting"), "false_only"),
    (("providers", "*", "cache", "keepalive", "beyondPiCap"), "false_only"),
    (("presence", "enabled"), "true_only"),
    (("presence", "awayAfterMinutes"), "lower_only"),
    (("ladder", "strongOnRevision"), "false_only"),
    (("ladder", "idleDownshift", "enabled"), "false_only"),
    (("ladder", "idleDownshift", "causes"), "intersect"),
    (("roles", "*", "strongOnRevision"), "false_only"),
    (("ceremony", "revisionRounds", "*"), "lower_only"),
    (("ceremony", "requireTriage"), "true_only"),
    (("ceremony", "reviewBeforePr"), "true_only"),
    (("ceremony", "foremanEdits"), ("ordered", FOREMAN_EDITS)),
    (("ceremony", "heavyFileCount"), "lower_only"),
    (("ceremony", "trivialBound", "*"), "lower_only"),
    (("ceremony", "foremanReads", "*", "*"), "lower_only"),
    (("ceremony", "childReads", "*", "*"), "lower_only"),
    # ceremony.childScratch.keep has no rule: any layer may set it, it only retains temp data.
    (("ceremony", "recheckBudget"), "lower_only"),
    (("ceremony", "childTimeoutSeconds"), "lower_only"),
    (("ceremony", "launchTimeoutCapMinutes"), "lower_only"),
    (("ceremony", "reviewRuns"), "lower_only"),
    (("ceremony", "budgetUsd"), "lower_only_number"),
    (("ceremony", "launchWait"), ("ordered", ("block", "detach"))),
    (("ceremony", "dedupeNotify"), "true_only"),
    (("ceremony", "reviewGate"), ("ordered", ("pass", "verdict"))),
    (("ceremony", "ledgerHelper"), ("ordered", ("off", "bash", "tool"))),
    (("ceremony", "reviewPerRevision"), "true_only"),
    (("ceremony", "heavyThreshold"), ("ordered", ("eee843d", "strict"))),
    (("ceremony", "required", "*"), "union"),
    (("ceremony", "planReview", "*"), "true_only"),
    (("roles", "*", "timeoutMinutes"), "lower_only"),
    (("intercom", "allowRemote"), "false_only"),
    (("intercom", "allowOpenPane"), "false_only"),
    (("wait", "ci"), "false_only"),
    (("close", "from"), "intersect"),
    (("close", "autoClean"), "false_only"),
    (("sessions", "remoteInlineMaxBytes"), "lower_only"),
    (("compaction", "maxTokens"), "lower_only"),
    (("wait", "maxSeconds"), "lower_only"),
    (("wait", "maxActive"), "lower_only"),
    (("resources", "maxLoadPerCore"), "lower_only_number"),
    (("resources", "minFreeMemMB"), "higher_only"),
    (("resources", "minFreeDiskGB"), "higher_only_number"),
    (("childMaxThinking",), ("ordered", tuple(THINKING))),
    (("tools", "git"), "false_only"),
    (("tools", "pr"), "false_only"),
    (("gate", "tmpAccess"), "false_only"),
    (("gate", "askTimeoutMs"), "lower_only"),
    (("gate", "reviewTimeoutMs"), "lower_only"),
    (("gate", "childAsk"), ("ordered", ("deny", "parent"))),
]
# gate keys the project and session layers may set (the LAYER_TIGHTEN rows above); every other gate key is user or overlay only
GATE_LAYER_KEYS = ("tmpAccess", "askTimeoutMs", "reviewTimeoutMs", "childAsk")
LAYER_MINIMUM = {"reviewTimeoutMs": 100, "timeoutMinutes": 1, "revisionRounds": 0, "heavyFileCount": 1,
                 "maxTokens": 50000, "maxSeconds": 1, "maxActive": 1, "foremanReads": 1, "recheckBudget": 0,
                 "windowMinutes": 1, "childTimeoutSeconds": 1, "launchTimeoutCapMinutes": 1, "reviewRuns": 1, "budgetUsd": 0.01,
                 "maxLoadPerCore": 0.01, "selfWarmWindowMinutes": 1, "awayAfterMinutes": 1,
                 "remoteInlineMaxBytes": 1024}
# lower_only values with no earlier layer value may not exceed this (the built-in default).
LAYER_CAP = {"windowMinutes": 45, "launchTimeoutCapMinutes": 120, "budgetShare": 0.5, "awayTicks": 0,
             "selfWarmWindowMinutes": 180, "awayAfterMinutes": 11}
# higher_only values with no earlier layer value may not fall below this (the built-in default).
LAYER_FLOOR = {"compactMinTokens": 100000}
# Built-in cache policy per provider (mirrors BUILTIN_CACHE in extensions/core-adapter/cachepolicy.ts).
BUILTIN_CACHE = {
    "claude-bridge": {"ttlSeconds": 300, "billing": "token"},
    "github-copilot": {"ttlSeconds": None, "billing": "request"},
}
# Smallest TTL whose 0.9 x tick lies beyond Pi's 30-minute idle cap (mirrors SELF_WARM_MIN_TTL_SECONDS in cachepolicy.ts).
SELF_WARM_MIN_TTL_SECONDS = 2001
# Built-in per-model TTLs (mirrors BUILTIN_BY_MODEL in cachepolicy.ts); the first matching row wins.
BUILTIN_BY_MODEL = {
    "github-copilot": [("claude-*", 300), ("gpt-*", 1800), ("o1*", 1800), ("o3*", 1800), ("o4*", 1800)],
}
# bridge.promptCacheTtl (mirrors bridgettl.ts): the Claude Code prompt-cache TTL per Pi process kind.
BRIDGE_TTL_VALUES = ("1h", "5m", "inherit")
BRIDGE_TTL_DEFAULTS = {"main": "1h", "subagent": "5m"}
BRIDGE_TTL_SECONDS = {"1h": 3600, "5m": 300}
TIERS = ["trivial", "standard", "heavy"]
# Steps ceremony.required.<tier> may name (the adapter counts each per session).
REQUIRED_STEPS = ["planner", "builder", "reviewer", "finalizer"]
# codemode adds a tool, so the project and session layers may only switch it off.
CODEMODE_FALSE_ONLY = True
# roles.<id> in the project and session layers: "intersect" = narrow only. NEW_ROLE_IDS
# "ignore" drops role ids not present after L1 -> L3 -> L2.
ROLE_RULES = {"tools": "intersect"}
NEW_ROLE_IDS = "ignore"
# trace.dir from the project or session layer must resolve inside the workspace.
TRACE_DIR_IN_WORKSPACE = True


def _non_dict_cache(node, name, path, who, warnings):
    """True (and the node dropped with a warning) when a providers.*.cache rule path crosses a non-object."""
    if isinstance(node[name], dict) or len(path) < 3 or path[0] != "providers" or path[2] != "cache":
        return False
    del node[name]
    warnings.append("%s %s ignored: expected an object" % (who, ".".join(path)))
    return True


REMOVED_COMPACTION_KEYS = ("priceTiers", "threshold")


def warn_removed_compaction(name, data, warnings):
    """One migration warning per config layer that still has compaction.priceTiers or compaction.threshold; the keys are dropped."""
    comp = data.get("compaction") if isinstance(data, dict) else None
    found = [k for k in REMOVED_COMPACTION_KEYS if isinstance(comp, dict) and k in comp]
    for k in found:
        del comp[k]
    if found:
        warnings.append("%s config: %s removed in r52; `foreman setup` writes Pi's compaction.modelOverrides; see docs/cache.md"
                        % (name, ", ".join("compaction." + k for k in found)))


def fix_bridge_ttl(name, data, warnings):
    """Remove a malformed bridge.promptCacheTtl (or one of its kinds) from one layer, with a warning; the default fills it."""
    bridge = data.get("bridge") if isinstance(data, dict) else None
    if not isinstance(bridge, dict) or "promptCacheTtl" not in bridge:
        return
    val = bridge["promptCacheTtl"]
    if not isinstance(val, dict):
        del bridge["promptCacheTtl"]
        warnings.append("%s bridge.promptCacheTtl ignored: not an object with main and subagent; using the defaults" % name)
        return
    for kind in ("main", "subagent"):
        if kind in val and not (isinstance(val[kind], str) and val[kind] in BRIDGE_TTL_VALUES):
            del val[kind]
            warnings.append("%s bridge.promptCacheTtl.%s ignored: use 1h, 5m or inherit; using %s"
                            % (name, kind, BRIDGE_TTL_DEFAULTS[kind]))


def _truthy_env(value):
    return value is not None and value.strip().lower() not in ("", "0", "false", "no", "off")


def derived_bridge_ttl(config, is_child, env):
    """TTL in seconds Claude Code gets on the bridge for this process kind (mirrors derivedBridgeTtlS in bridgettl.ts).

    None when FORCE_PROMPT_CACHING_5M is truthy or the kind's setting is "inherit".
    """
    if _truthy_env((env or {}).get("FORCE_PROMPT_CACHING_5M")):
        return None
    bridge = config.get("bridge") if isinstance(config, dict) else None
    setting = bridge.get("promptCacheTtl") if isinstance(bridge, dict) else None
    kind = "subagent" if is_child else "main"
    value = setting.get(kind) if isinstance(setting, dict) else None
    if value not in BRIDGE_TTL_VALUES:
        value = BRIDGE_TTL_DEFAULTS[kind]
    return BRIDGE_TTL_SECONDS.get(value)


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
        elif not _non_dict_cache(node, name, path, who, warnings):
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
            if not _non_dict_cache(node, name, path, who, warnings):
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
        elif rule in ("higher_only", "higher_only_number"):
            num = rule == "higher_only_number"
            isnum = lambda v: isinstance(v, (int, float) if num else int) and not isinstance(v, bool)  # noqa: E731
            if not isnum(val):
                why = "not a number" if num else "not an integer"
            elif val < 0:
                why = "below the minimum 0"
            elif isnum(have) and val < have:
                why = "it would loosen the policy"
            elif not isnum(have) and val < LAYER_FLOOR.get(name, val):
                why = "below the default %g" % LAYER_FLOOR[name]
            else:
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
            elif not isnum(have) and val > LAYER_CAP.get(name, val):
                why = "above the default %g" % LAYER_CAP[name]
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
    for key in ("trivialBound", "required", "foremanReads"):
        if key in cer and not isinstance(cer[key], dict):
            del cer[key]
            warnings.append("%s ceremony.%s ignored: not an object" % (who, key))
    for phase, val in list((cer.get("foremanReads") or {}).items()):
        if not isinstance(val, dict):
            del cer["foremanReads"][phase]
            warnings.append("%s ceremony.foremanReads.%s ignored: not an object" % (who, phase))
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
    gate = proj.get("gate")
    if gate is not None and not isinstance(gate, dict):
        del proj["gate"]
        warnings.append("%s gate ignored: not an object" % who)
    elif isinstance(gate, dict):
        for name in list(gate):
            if name not in GATE_LAYER_KEYS:
                del gate[name]
                warnings.append("%s gate.%s ignored: the %s may only tighten gate.%s (user or overlay config sets the rest)"
                                % (who, name, who, ", gate.".join(GATE_LAYER_KEYS)))
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
            if k == "denyTools" and isinstance(base.get(k), list) and isinstance(v, list):
                # roles.<x>.denyTools only grows across layers; no layer removes an entry
                out[k] = list(base[k]) + [x for x in v if x not in base[k]]
                continue
            out[k] = deep_merge(base[k], v) if k in base else copy.deepcopy(v)
        return out
    return copy.deepcopy(over)


# ---------------------------------------------------------------- validation

def _end_anchored(pattern):
    """`pattern` with a trailing `$` read as end of string (ECMAScript, and the runtime's `\\Z`): Python's `$` also
    matches before a final newline."""
    slashes = len(pattern) - len(pattern[:-1].rstrip("\\")) - 1
    return pattern[:-1] + r"\Z" if pattern.endswith("$") and slashes % 2 == 0 else pattern


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
    if isinstance(value, str) and "pattern" in schema and not re.search(_end_anchored(schema["pattern"]), value):
        issues.append(("error", path, "%s: %r does not match pattern %s" % (label, value, schema["pattern"])))
        return
    if _TYPES["number"](value):
        if "minimum" in schema and value < schema["minimum"]:
            issues.append(("error", path, "%s: below minimum %s" % (label, schema["minimum"])))
        if "exclusiveMinimum" in schema and value <= schema["exclusiveMinimum"]:
            issues.append(("error", path, "%s: must be above %s" % (label, schema["exclusiveMinimum"])))
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
    issues.extend(pr_host_issues((cfg.get("tools") or {}).get("prHost")))
    issues.extend(pr_interaction_issues((cfg.get("tools") or {}).get("prInteractions")))
    issues.extend(pr_shared_issues((cfg.get("tools") or {}).get("prShared")))
    issues.extend(mcp_deny_issues(cfg))
    sessions = cfg.get("sessions")
    issues.extend(machine_issues(sessions.get("machines") if isinstance(sessions, dict) else None))
    return issues


MACHINE_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\Z")


def machine_issues(machines):
    """sessions.machines keys are Herdr saved-machine names (the schema cannot constrain map keys)."""
    return [("error", "sessions.machines." + str(k), "sessions.machines: %r is not a valid machine name (A-Z a-z 0-9 . _ -, at most 64, starting with a letter or digit)" % (k,))
            for k in (machines if isinstance(machines, dict) else {}) if not MACHINE_NAME_RE.match(str(k))]


def mcp_deny_issues(cfg):
    """A role that is given MCP servers while its denyTools deny the mcp__ namespace could never use them."""
    issues = []
    for rid, role in (cfg.get("roles") or {}).items():
        names = role.get("mcp") if isinstance(role, dict) else None
        if not isinstance(names, list) or not names:
            continue
        if rid in ("foreman", SESSION_FOREMAN):
            path = "roles.%s.mcp" % rid
            issues.append(("error", path, "%s: only child roles take mcp; the main session already loads every enabled server in mcp.json" % path))
            continue
        # Pi's createMcpToolName: every char outside [A-Za-z0-9_] becomes `_`; a bare server stands for any tool (`*`).
        samples = [re.sub(r"[^A-Za-z0-9_]", "_", "mcp__%s__%s" % (n.split("/", 1)[0], n.split("/", 1)[1]))
                   if "/" in n else re.sub(r"[^A-Za-z0-9_]", "_", "mcp__" + n) + "__*"
                   for n in names if isinstance(n, str) and n]
        for pat in role.get("denyTools") or []:
            if isinstance(pat, str) and any(fnmatch.fnmatchcase(s, pat) for s in samples):
                path = "roles.%s.mcp" % rid
                issues.append(("error", path, "%s: role %s denies %s (denyTools); remove mcp or the deny" % (path, rid, pat)))
                break
    return issues


PR_HOST_KEYS = ("create", "status", "checks", "comments", "find", "search")
PR_PLACEHOLDERS = ("{repo}", "{number}", "{since}", "{base}", "{head}", "{title}", "{bodyFile}", "{draft}",
                   "{host}", "{mode}", "{author}", "{state}")


def pr_interaction_issues(items):
    """tools.prInteractions: at most 16 patterns of 1 to 200 characters, each with the named group n (JavaScript syntax `(?<n>...)`)."""
    if not isinstance(items, list):
        return []
    issues = []
    if len(items) > 16:
        issues.append(("error", "tools.prInteractions", "tools.prInteractions: at most 16 patterns"))
    for i, item in enumerate(items):
        pat = item.get("pattern") if isinstance(item, dict) else None
        path = "tools.prInteractions.%d" % i
        if not isinstance(pat, str):
            continue
        if not 1 <= len(pat) <= 200:
            issues.append(("error", path, "%s: pattern must be 1 to 200 characters" % path))
        elif "(?<n>" not in pat:
            issues.append(("error", path, "%s: pattern needs the named group (?<n>...) for the PR number" % path))
    return issues


def pr_shared_issues(shared):
    """tools.prShared.authors: at most 8 (the schema checks each name)."""
    authors = shared.get("authors") if isinstance(shared, dict) else None
    if isinstance(authors, list) and len(authors) > 8:
        return [("error", "tools.prShared.authors", "tools.prShared.authors: at most 8 authors")]
    return []


def pr_host_issues(host):
    """tools.prHost checks the schema cannot express (design/pr-ops.md section 1)."""
    issues = []

    def bad(path, why):
        issues.append(("error", path, "%s: %s" % (path, why)))

    if host is None:
        return issues
    if isinstance(host, str):
        if host not in ("auto", "gh", "glab"):
            bad("tools.prHost", "must be auto, gh, glab or an object of command templates")
        return issues
    if not isinstance(host, dict):
        return issues
    for key, val in host.items():
        path = "tools.prHost." + str(key)
        if key not in PR_HOST_KEYS:
            bad(path, "unknown template key (allowed: %s)" % ", ".join(PR_HOST_KEYS))
            continue
        if not isinstance(val, str) or not val.strip() or len(val) > 1024:
            bad(path, "must be a non-empty command line of at most 1024 characters")
            continue
        try:
            words = shlex.split(val, posix=True)
        except ValueError as exc:
            bad(path, "cannot be split into words (%s)" % exc)
            continue
        if not words:
            bad(path, "must be a non-empty command line of at most 1024 characters")
            continue
        for w in words:
            if ("{" in w or "}" in w) and w not in PR_PLACEHOLDERS:
                bad(path, "%r is not a placeholder (allowed: %s, each as a whole word)" % (w, " ".join(PR_PLACEHOLDERS)))
                break
        if words[0] in PR_PLACEHOLDERS:
            bad(path, "the first word must be the program, not a placeholder")
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
                session_json=None, l3_paths=(), user_file=None):
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
        warn_removed_compaction(name, data, warnings)
        fix_bridge_ttl(name, data, warnings)
        drop_invalid_safety(name, data, schema, warnings)
        fix_malformed_ceremony(name, data, l1, errors)
        return data

    l3 = list(discover_l3(agent)) + [(Path(p).name, Path(p)) for p in l3_paths]
    for pkg, path in l3:
        data = load_layer("L3:" + pkg, path)
        if data is not None:
            cfg = deep_merge(cfg, data)
            layers.append("L3:" + pkg)
    l2 = Path(user_file) if user_file else agent / "foreman.json"
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
            warn_removed_compaction("session", data, warnings)
            comp = data.get("compaction")
            if isinstance(comp, dict) and "maxTokens" in comp:
                del comp["maxTokens"]
                warnings.append("session compaction.maxTokens ignored: session layer ignored: setup applies maxTokens")
            fix_bridge_ttl("session", data, warnings)
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


# ceremony.ledgerHelper "tool": reviewer roles get foreman_ledger, which lets them only mark V.
LEDGER_TOOL = "foreman_ledger"
LEDGER_TOOL_ROLES = ("reviewer", "senior-reviewer")


def with_ledger_tool(cfg, role, tools):
    helper = (cfg.get("ceremony") or {}).get("ledgerHelper", "tool")
    if role in LEDGER_TOOL_ROLES and helper not in ("bash", "off") and LEDGER_TOOL not in tools:
        tools.append(LEDGER_TOOL)
    return tools


# tools.git: roles whose tool list has bash also get the git read tools (docs/tools.md).
GIT_PACK_TOOLS = ("git_status", "git_log", "git_diff_stat", "git_branch_state")


def with_git_pack(cfg, role, tools):
    if (cfg.get("tools") or {}).get("git") is True and "bash" in tools:
        tools.extend(t for t in GIT_PACK_TOOLS if t not in tools)
    return tools


# tools.pr (default on): roles whose tool list has bash get the PR read tools (docs/tools.md).
PR_READ_TOOLS = ("pr_status", "pr_checks", "pr_comments")
PR_ROLE_TOOLS = {"reviewer": ("pr_status", "pr_comments"), "senior-reviewer": ("pr_status", "pr_comments")}


def with_pr_pack(cfg, role, tools):
    if (cfg.get("tools") or {}).get("pr") is True and "bash" in tools:
        tools.extend(t for t in PR_ROLE_TOOLS.get(role, PR_READ_TOOLS) if t not in tools)
    return tools


def with_tool_search(tools):
    """Add `tool_search` to a child role's tools, at the index of `codemode` (else appended).

    MCP tools load on demand through it; core-adapter scopes them per role (`roles.<id>.mcp`),
    so no `mcp:` entry is emitted.
    """
    out = list(tools)
    if "tool_search" not in out:
        out.insert(out.index("codemode") if "codemode" in out else len(out), "tool_search")
    return out


def resolve_role(cfg, role, provider):
    """Return {model, thinking, codemode, tools[, strong][, idle]}; raise ConfigError if unresolvable.

    `idle` ({model, thinking}) is the foreman's idle-downshift model, resolved like `strong`.
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
        tools = with_tool_search(with_pr_pack(cfg, role, with_git_pack(cfg, role, with_ledger_tool(cfg, role, [t for t in tools if t not in CHILD_DENIED_TOOLS]))))
    if codemode and "codemode" not in tools:
        tools.append("codemode")
    out = {"model": model, "thinking": cap_thinking(thinking, cfg.get("maxThinking")),
           "codemode": codemode, "tools": tools}
    for rung in ("strong", "idle"):
        ref = source.get(rung)
        if isinstance(ref, dict) and isinstance(ref.get("model"), str) and ref["model"]:
            out[rung] = {"model": ref["model"], "thinking": cap_thinking(ref.get("thinking"), cfg.get("maxThinking"))}
    return out


def child_roles(cfg):
    """The built-in child roles, then every other role id of the merged `roles` (not foreman)."""
    extra = sorted(r for r in (cfg.get("roles") or {}) if r not in ("foreman", SESSION_FOREMAN) and r not in CHILD_ROLES)
    return list(CHILD_ROLES) + extra


def resolve_session_foreman(cfg, provider):
    """{model, thinking} mapped for session-foreman (own provider, then its fallback), or None: the session uses its own model."""
    providers = cfg.get("providers") or {}
    fb = ((providers.get(provider) or {}).get("fallback") or {}).get("provider")
    for p in (provider, fb):
        entry = ((providers.get(p) or {}).get("roles") or {}).get(SESSION_FOREMAN) if p else None
        if isinstance(entry, dict) and entry.get("model"):
            return {"model": entry["model"], "thinking": cap_thinking(entry.get("thinking"), cfg.get("maxThinking"))}
    return None


def resolve_all(cfg, provider):
    out = {}
    for role in ["foreman"] + child_roles(cfg):
        try:
            out[role] = resolve_role(cfg, role, provider)
        except ConfigError as exc:
            out[role] = {"error": str(exc)}
    return out


def generate_subagents(cfg):
    """pi-subagents settings block for the child roles.

    pi-subagents parses agentOverridesByProvider entries with the same parser as
    agentOverrides, so `tools` is accepted per provider. A per-provider `tools`
    array is therefore written only where the provider's codemode switch differs
    from the role default. `forceTopLevelAsync` makes every depth-0 launch detached even
    when a call passes `async: false` (design section 9).
    """
    by_provider, overrides, errors = {}, {}, []
    for role in CHILD_ROLES:
        tools = with_pr_pack(cfg, role, with_git_pack(cfg, role, with_ledger_tool(cfg, role, [t for t in (cfg.get("roles") or {}).get(role, {}).get("tools", []) if t not in CHILD_DENIED_TOOLS])))
        if cfg.get("roles", {}).get(role, {}).get("codemode") and "codemode" not in tools:
            tools.append("codemode")
        overrides[role] = {"tools": with_tool_search(tools)}
        skills = cfg.get("roles", {}).get(role, {}).get("skills")
        if skills:
            overrides[role]["skills"] = list(skills)
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
        s.add_argument("--user-file", help="read this file as the user layer (L2) instead of <agent dir>/foreman.json")
        s.add_argument("--provider")
    s = sub.add_parser("resolve", parents=[common])
    s.add_argument("--role", required=True)
    s.add_argument("--provider", required=True)
    sub.add_parser("generate-subagents", parents=[common])
    s = sub.add_parser("display-name", parents=[common])
    s.add_argument("--role", required=True)
    s = sub.add_parser("apply-preset")
    s.add_argument("name")
    s.add_argument("--foreman", metavar="MODEL_ID")
    s.add_argument("--dry-run", action="store_true")
    s.add_argument("--agent-dir")
    return p


def emit(args, obj, human):
    if args.json:
        print(json.dumps(obj, indent=2, sort_keys=False))
    else:
        print(human)


PRESETS_DIR = ROOT / "config" / "presets"


def preset_names():
    return sorted(p.stem for p in PRESETS_DIR.glob("*.json"))


def backup_path(target, now):
    bak = target.with_name("foreman.json.bak-" + now.strftime("%Y%m%d"))
    if bak.exists():
        bak = target.with_name(bak.name + now.strftime("-%H%M%S"))
    base, n = bak, 1
    while bak.exists():
        n += 1
        bak = target.with_name("%s.%d" % (base.name, n))
    return bak


class PresetError(Exception):
    pass


def rank_tier_of(ranks, model_id):
    """Tier of a bare model id from providers.<p>.ranks (first matching row), or None."""
    for r in ranks:
        if isinstance(r, dict) and isinstance(r.get("match"), str) and isinstance(r.get("tier"), int):
            if re.fullmatch(re.escape(r["match"]).replace(r"\*", ".*").replace(r"\?", "."), model_id):
                return r["tier"]
    return None


def _candidate_models(entry):
    """Bare model ids known for one provider: literal ranks matches, then role, strong and review models."""
    out = []
    for r in entry.get("ranks") or []:
        if isinstance(r, dict) and isinstance(r.get("match"), str) and not re.search(r"[*?]", r["match"]):
            out.append(r["match"])
    refs = []
    for role in (entry.get("roles") or {}).values():
        if isinstance(role, dict):
            refs.append(role.get("model"))
            refs.append((role.get("strong") or {}).get("model") if isinstance(role.get("strong"), dict) else None)
            refs.append((role.get("idle") or {}).get("model") if isinstance(role.get("idle"), dict) else None)
    refs.append((entry.get("review") or {}).get("model"))
    for ref in refs:
        if isinstance(ref, str) and ref:
            out.append(ref.split("/", 1)[1] if "/" in ref else ref)
    return list(dict.fromkeys(out))


def resolve_rank_tiers(template, existing, foreman_model=None):
    """Resolve a preset's `rankTiers` against providers.<p>.ranks of the active provider.

    Tier numbers are ordinals over the distinct ranked tiers (0 = best). With a foreman model the
    foreman sits at that model's own tier and a child tier counts from it; otherwise the foreman is at
    ordinal 1. Returns (provider, {role: (model ref, thinking, ordinal)}); raises PresetError.
    """
    merged = deep_merge(read_json(DEFAULTS_PATH), existing)
    provs = merged.get("providers") or {}
    if foreman_model:
        provider = foreman_model.split("/", 1)[0] if "/" in foreman_model else None
        if provider is None:
            raise PresetError("--foreman needs <provider>/<model id>")
    else:
        ranked = [p for p, e in provs.items() if isinstance(e, dict) and e.get("ranks")]
        if len(ranked) != 1:
            raise PresetError("cannot pick the active provider (%s ranks); pass --foreman <provider>/<model id>"
                              % ("no provider has" if not ranked else "several providers have"))
        provider = ranked[0]
    entry = provs.get(provider)
    ranks = entry.get("ranks") if isinstance(entry, dict) else None
    if not isinstance(ranks, list) or not ranks:
        raise PresetError("providers.%s.ranks is missing: the inexpensive preset resolves roles by rank tier, "
                          "add ranks (see docs/presets.md)" % provider)
    tiers = sorted({r["tier"] for r in ranks if isinstance(r, dict) and isinstance(r.get("tier"), int)})
    if not tiers:
        raise PresetError("providers.%s.ranks has no valid {match, tier} row" % provider)
    cands = _candidate_models(entry)
    base = 1
    if foreman_model:
        ftier = rank_tier_of(ranks, foreman_model.split("/", 1)[1])
        if ftier is None:
            raise PresetError("%s matches no providers.%s.ranks row" % (foreman_model, provider))
        base = tiers.index(ftier)

    def model_at(ordinal):
        idx = min(ordinal, len(tiers) - 1)
        for c in cands:
            if rank_tier_of(ranks, c) == tiers[idx]:
                return provider + "/" + c, idx
        raise PresetError("no model id known for tier %d of providers.%s.ranks; add a literal ranks match "
                          "(no wildcard) for that tier" % (tiers[idx], provider))

    out = {}
    foreman_ref = None
    for role, spec in template.items():
        if spec.get("sameAs"):
            continue
        t = spec.get("tier")
        if t == "lowest":
            ref, idx = model_at(len(tiers) - 1)
        elif role in ("foreman", "session-foreman") and foreman_model:
            ref, idx = foreman_model, base
        else:
            ref, idx = model_at(base + t - 1 if foreman_model else t)
        out[role] = (ref, spec.get("thinking"), idx)
    for role, spec in template.items():
        if spec.get("sameAs"):
            ref, _t, idx = out[spec["sameAs"]]
            out[role] = (ref, spec.get("thinking"), idx)
    return provider, out


def expand_rank_tiers(preset, existing, foreman_model):
    """preset without `rankTiers`, plus the resolved provider roles and review model; also the role map."""
    preset = copy.deepcopy(preset)
    template = preset.pop("rankTiers")
    provider, resolved = resolve_rank_tiers(template, existing, foreman_model)
    entry = preset.setdefault("providers", {}).setdefault(provider, {})
    for role, (ref, thinking, _i) in resolved.items():
        if role == "auto-review":
            entry["review"] = {"model": ref}
        else:
            entry.setdefault("roles", {})[role] = {"model": ref, **({"thinking": thinking} if thinking else {})}
    return preset, resolved


def apply_preset(args):
    """Merge config/presets/<name>.json into <agent dir>/foreman.json (preset wins)."""
    name = args.name
    path = PRESETS_DIR / (name + ".json")
    if not re.match(r"^[A-Za-z0-9][A-Za-z0-9._-]*$", name) or not path.is_file():
        print("unknown preset %r; available: %s" % (name, ", ".join(preset_names())), file=sys.stderr)
        return 2
    target = resolve_agent_dir(args.agent_dir) / "foreman.json"
    try:
        preset = read_json(path)
        existing = read_json(target) if target.is_file() else {}
        if not isinstance(existing, dict):
            raise ValueError("not a JSON object")
    except (OSError, ValueError) as exc:
        print("cannot read %s: %s" % (target, exc), file=sys.stderr)
        return 1
    resolved = None
    if "rankTiers" in preset:
        try:
            preset, resolved = expand_rank_tiers(preset, existing, args.foreman)
        except PresetError as exc:
            print("error: %s" % exc, file=sys.stderr)
            print("nothing written", file=sys.stderr)
            return 1
    merged = deep_merge(existing, preset)
    if args.foreman:
        for prov in (preset.get("providers") or {}):
            merged["providers"][prov].setdefault("roles", {}).setdefault("foreman", {})["model"] = args.foreman
    full = deep_merge(read_json(DEFAULTS_PATH), merged)
    issues = []
    validate_schema(full, read_json(SCHEMA_PATH), "", issues)
    issues.extend(semantic_issues(full))
    errs = [m for kind, _p, m in issues if kind == "error"]
    if errs:
        for m in errs:
            print("error: " + m, file=sys.stderr)
        print("nothing written", file=sys.stderr)
        return 1
    text = json.dumps(merged, indent=2) + "\n"
    if args.dry_run:
        if resolved is not None:
            for role, (ref, _th, idx) in resolved.items():
                print("%s -> %s (tier %d)" % (role, ref, idx))
            print("dry run: nothing written")
        else:
            sys.stdout.write(text)
        return 0
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.is_file():
        bak = backup_path(target, datetime.datetime.now())
        bak.write_bytes(target.read_bytes())
        print("backed up the old config to %s" % bak)
    # Write beside the target and swap it in, so a failed write never leaves the config missing.
    tmp = target.with_name(target.name + ".tmp")
    with open(str(tmp), "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)
    tmp.replace(target)
    print("applied preset %s to %s" % (name, target))
    return 0


def main(argv=None):
    args = build_parser().parse_args(argv)
    if args.cmd == "apply-preset":
        return apply_preset(args)
    try:
        res = load_config(args.agent_dir, args.project_dir, args.trusted_project,
                          args.session_json, args.l3, getattr(args, "user_file", None))
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
        rs = cfg.get("resources") or {}
        human += "\neffective resources: " + " ".join(
            "%s=%s" % (k, rs.get(k)) for k in ("maxLoadPerCore", "minFreeMemMB", "minFreeDiskGB", "sampleSeconds"))
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


def _model_matches(pattern, model):
    if not re.search(r"[*?]", pattern):
        return pattern in model
    return re.fullmatch(re.escape(pattern).replace(r"\*", ".*").replace(r"\?", "."), model) is not None


def cache_policy(config, provider, model=None, bridge_ttl=None):
    """Resolved cache policy of one provider (mirrors resolveCachePolicy in cachepolicy.ts).

    bridge_ttl: derived_bridge_ttl seconds; on claude-bridge it sits after a byModel row and an explicit ttlSeconds.

    -> {"ttlSeconds", "billing", "enabled"} or None when neither the config nor BUILTIN_CACHE has an entry.
    """
    provs = config.get("providers") if isinstance(config, dict) else None
    raw = provs.get(provider) if isinstance(provs, dict) else None
    cfg = raw.get("cache") if isinstance(raw, dict) else None
    cfg = cfg if isinstance(cfg, dict) else {}
    built = BUILTIN_CACHE.get(provider) or {}
    if not cfg and not built:
        return None
    hit = {}
    mid = (model[len(provider) + 1:] if model.startswith(str(provider) + "/") else model) if model else ""
    if mid and isinstance(cfg.get("byModel"), list):
        for row in cfg["byModel"]:
            if isinstance(row, dict) and isinstance(row.get("match"), str) and row["match"] \
                    and _model_matches(row["match"], mid):
                hit = row
                break
    derived = False
    if isinstance(hit.get("ttlSeconds"), int):
        ttl = hit["ttlSeconds"]
    elif "ttlSeconds" in cfg:
        ttl = cfg["ttlSeconds"]
    elif provider == "claude-bridge" and bridge_ttl is not None:
        ttl, derived = bridge_ttl, True
    else:
        ttl = next((t for pat, t in BUILTIN_BY_MODEL.get(provider, []) if mid and _model_matches(pat, mid)),
                   built.get("ttlSeconds"))
    ttl = ttl if isinstance(ttl, int) and not isinstance(ttl, bool) and ttl >= 1 else None
    braw = hit.get("billing") if hit.get("billing") in ("token", "request") else cfg.get("billing")
    billing = braw if braw in ("token", "request") else built.get("billing")
    ka = cfg.get("keepalive") if isinstance(cfg.get("keepalive"), dict) else {}
    enabled = ka.get("enabled")
    if not isinstance(enabled, bool):
        enabled = billing == "token" and ttl is not None and (ttl < 3600 or derived)
    if billing == "request":
        enabled = False
    return {"ttlSeconds": ttl, "billing": billing, "enabled": enabled}


def warm_policy(config, provider, model=None, bridge_ttl=None):
    """cache_policy plus the warm-policy fields (mirrors resolveWarmPolicy in cachepolicy.ts).

    -> cache_policy's keys and budgetShare, awayTicks, whileWaiting, selfWarm, selfWarmWindowMinutes, compactMinTokens, or None.
    """
    base = cache_policy(config, provider, model, bridge_ttl)
    if base is None:
        return None
    provs = config.get("providers") if isinstance(config, dict) else None
    raw = provs.get(provider) if isinstance(provs, dict) else None
    cfg = raw.get("cache") if isinstance(raw, dict) and isinstance(raw.get("cache"), dict) else {}
    ka = cfg.get("keepalive") if isinstance(cfg.get("keepalive"), dict) else {}

    def clamp(v, lo, hi, default):
        return min(hi, max(lo, v)) if isinstance(v, (int, float)) and not isinstance(v, bool) else default

    ttl = base["ttlSeconds"]
    self_warm = bool(base["enabled"] and base["billing"] == "token" and ttl is not None
                     and ka.get("beyondPiCap") is not False and ttl >= SELF_WARM_MIN_TTL_SECONDS)
    default_window = min(1440, max(45, 3 * -(-(ttl or 0) // 60)))
    out = dict(base)
    out.update({
        "budgetShare": clamp(ka.get("budgetShare"), 0, 1, 0.5),
        "awayTicks": int(clamp(ka.get("awayTicks"), 0, 20, 0)),
        "whileWaiting": ka.get("whileWaiting") if isinstance(ka.get("whileWaiting"), bool) else True,
        "selfWarm": self_warm,
        "selfWarmWindowMinutes": int(clamp(ka.get("selfWarmWindowMinutes"), 1, 1440, default_window)),
        "compactMinTokens": int(clamp(ka.get("compactMinTokens"), 0, 2 ** 53 - 1, 100000)),
    })
    return out


if __name__ == "__main__":
    sys.exit(main())
