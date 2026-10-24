#!/usr/bin/env python3
"""Session friction metrics and permission-allow proposals (stdlib, 3.13+).

    python scripts/foreman_retro.py [--session F] [--trace F ...] [--usage F] [--review-log F]
                                    [--proposals-out F] [--min-reviews N] [--agent-dir D] [--json]
    python scripts/foreman_retro.py --selftest
    python scripts/foreman_retro.py models [--since 30d] [--source live|panel|bench] [--json] [--agent-dir D] [--cwd REPO]

Every input is optional; a missing or unreadable file makes its section say "no data". Only counts,
command families (first two words, three for sudo/ssh, digits -> N, hex -> HASH), tool names and
guard names are printed: never prompts, command text, file bodies or tool output.

Proposals look at the whole review log: a bash command family approved (by the user or the review
model) at least --min-reviews times in at least two sessions and never denied becomes the candidate
`"<family> *"`, unless the baseline or merged config deny/ask rules already match it, the family runs
code (interpreters, wrappers, runners, git config/remote/submodule) or an argv word names a baseline
write-protected path. The script
writes a JSON file for the user to read; it never edits any config.
"""
from __future__ import annotations

import argparse
import collections
import datetime
import json
import os
import re
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import review_log_stats as rls  # noqa: E402
import permissions_gen as pg  # noqa: E402

DEFAULT_MIN_REVIEWS = 5
APPLY_HINT = (
    "Review each pattern, then add the ones you want by hand under safety.permissions.bash.allow "
    "in <agentDir>/foreman.json. Nothing was changed."
)


# ------------------------------------------------------------------ reading

def read_jsonl(path):
    """List of dict records; None when the file is missing/unreadable. A torn line is skipped."""
    if not path:
        return None
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            return list(rls.read_records(fh))
    except OSError:
        return None


def read_traces(paths):
    """Records of one or more trace files (the foreman's and its children's) joined; None when none is readable."""
    if isinstance(paths, str):
        paths = [paths]
    out = None
    for p in paths or []:
        recs = read_jsonl(p)
        if recs is not None:
            out = (out or []) + recs
    return out


def bash_family(cmd):
    """Collapse a command to a comparable family (port of the hub's retro_stats)."""
    cmd = str(cmd).strip().split("<<", 1)[0]
    if cmd.startswith("cd "):
        parts = cmd.split("&&", 1)
        cmd = parts[1].strip() if len(parts) > 1 else cmd
    toks = cmd.split()
    if not toks:
        return "(empty)"
    head = toks[:2]
    if head[0] in ("ssh", "sudo") and len(toks) > 2:
        head = toks[:3]
    fam = " ".join(head)
    fam = re.sub(r"\b\d{3,}\b", "N", fam)
    fam = re.sub(r"\b[0-9a-f]{7,}\b", "HASH", fam)
    return fam[:60]


# ------------------------------------------------------------------ review log

def collect_asks(records):
    """One dict per requestId: session, family, outcome, decider, verdict, ts (terminal event)."""
    asks = {}
    for rec in records:
        rid = rec.get("requestId")
        if not isinstance(rid, str) or not rid:
            continue
        a = asks.setdefault(rid, {"session": None, "fallback": None, "family": None, "outcome": None,
                                  "human": False, "review": None, "ts": "", "ask": False})
        ev = str(rec.get("event", ""))
        if ev.startswith("permission_request.") or ev.startswith("forwarded_permission."):
            a["ask"] = True
        if ev.startswith("forwarded_permission.") and isinstance(rec.get("targetSessionId"), str):
            a["fallback"] = rec["targetSessionId"]
        if str(rec.get("toolName", "")).lower() in ("bash", "powershell") and isinstance(rec.get("command"), str) and a["family"] is None:
            a["family"] = bash_family(rec["command"])
        if ev == "foreman_review.decision":
            if isinstance(rec.get("sessionId"), str):
                a["session"] = rec["sessionId"]
            if rec.get("model") and rec.get("verdict") in ("allow", "deny", "defer"):
                a["review"] = rec["verdict"]
        elif ev == "ai_guard.decision" and rec.get("verdict") in ("allow", "deny", "defer"):
            a["review"] = rec["verdict"]
        if ev in ("permission_request.approved", "permission_request.denied"):
            ts = str(rec.get("timestamp", ""))
            if ts >= a["ts"]:
                a["ts"] = ts
            a["outcome"] = "approved" if ev.endswith("approved") else "denied"
            if rls.human_kind(rec.get("decidedBy")) == "user":
                a["human"] = True
    return [a for a in asks.values() if a["ask"]]


def ask_session(a):
    return a["session"] or a["fallback"]


def review_metrics(asks, sid):
    """Counts for one session (asks of unknown session are counted separately)."""
    mine = [a for a in asks if (sid is None) or ask_session(a) == sid or ask_session(a) is None]
    unknown = sum(1 for a in mine if sid is not None and ask_session(a) is None)
    m = {"human_approved": 0, "human_denied": 0, "review_allow": 0, "review_deny": 0, "review_defer": 0,
         "unknown_session": unknown}
    for a in mine:
        if a["human"] and a["outcome"]:
            m["human_" + a["outcome"]] += 1
        if a["review"]:
            m["review_" + a["review"]] += 1
    seen = {}
    overridden = 0
    for a in sorted((x for x in mine if x["outcome"] and x["family"]), key=lambda x: x["ts"]):
        if a["outcome"] == "denied":
            seen[a["family"]] = True
        elif seen.pop(a["family"], False):
            overridden += 1
    m["denials_overridden"] = overridden
    return m


def load_deny_ask_rules(agent_dir):
    """Baseline bash deny/ask patterns, plus the merged config's when it loads."""
    rules = []
    try:
        base = pg.load_baseline()
        perms = {}
        try:
            res = pg.fc.load_config(agent_dir)
            perms = (res["config"].get("safety") or {}).get("permissions") or {}
        except Exception:
            perms = {}
        rules = [p for p, s in pg.bash_rules(base, perms) if s in ("deny", "ask")]
    except Exception:
        pass
    return rules


def wildcard_match(pattern, text):
    """pi-permission-system wildcards: * any chars, ? one char, trailing ' *' also matches the bare command."""
    def conv(pat):
        return "".join(".*" if c == "*" else "." if c == "?" else re.escape(c) for c in pat)
    rx = conv(pattern[:-2]) + "(?: .*)?" if pattern.endswith(" *") else conv(pattern)
    return re.match("^(?:" + rx + ")$", text, re.S | re.I) is not None


RUNS_CODE_HEADS = {"node", "deno", "bun", "ruby", "perl", "php", "bash", "sh", "zsh", "pwsh", "powershell", "cmd",
                   "osascript", "eval", "exec", "xargs", "env", "sudo", "ssh", "npx",
                   # wrappers that run their argument, and more interpreters (S9 re-review)
                   "nohup", "nice", "time", "timeout", "command", "stdbuf", "busybox", "uvx", "bunx",
                   "awk", "gawk", "mawk", "lua", "luajit", "rscript", "tclsh", "dash", "ksh", "fish", "csh", "tcsh",
                   # S9 residual (re-review 2)
                   "doas", "setsid", "watch", "parallel", "flock", "script", "strace", "ltrace", "chroot", "runuser",
                   "su", "wsl"}
RUNS_CODE_SUBS = {"npm": ("exec", "x"), "uv": ("run",), "pipx": ("run",), "poetry": ("run",), "pnpm": ("dlx", "exec"),
                  "yarn": ("dlx", "exec"), "go": ("run",), "cargo": ("run",), "git": ("config", "remote", "submodule",
                  # a family has two words: `git hook *` covers `hook run`, `git bisect *` covers `bisect run`,
                  # `git rebase *` covers `--exec`; filter-branch runs its filters
                  "hook", "bisect", "rebase", "filter-branch")}


# A git global option as the second word: `git -C *` etc. would cover every git subcommand.
GIT_GLOBAL_OPT = re.compile(r"^(?:-C|-c.*|-p|--paginate|--(?:git-dir|work-tree|exec-path|config-env|namespace)(?:=.*)?)$")


def runs_code(family):
    """True for a family whose command runs arbitrary code or rewrites config (never proposed, S9)."""
    toks = family.split()
    if not toks:
        return False
    head = re.sub(r"\.(exe|cmd|bat|com)$", "", re.split(r"[\\/]", toks[0])[-1].lower())
    if "=" in head or head in RUNS_CODE_HEADS or re.match(r"^python[\d.]*$", head) or re.match(r"^py(thon)?w?$", head):
        return True
    rest = toks[1:]
    if rest and (rest[0] in RUNS_CODE_SUBS.get(head, ()) or (head == "git" and GIT_GLOBAL_OPT.match(rest[0]))):
        return True
    return any(t in ("-exec", "-execdir", "-ok", "-okdir", "-delete") for t in rest)


def load_protect_patterns(agent_dir):
    """The baseline write-protection patterns (all lists), placeholders filled for matching argv words:
    {cwd} -> any prefix, agent dir, its parent, package root, $XDG_CONFIG_HOME (dropped when unset), ~."""
    try:
        prot = pg.load_baseline().get("protect") or {}
    except Exception:
        return []
    ad = Path(agent_dir).expanduser().as_posix()
    xdg = os.environ.get("XDG_CONFIG_HOME", "")
    subs = {"{cwd}": "*", "{agentDirParent}": ad.rsplit("/", 1)[0] or "/", "{agentDir}": ad,
            "{pkgRoot}": Path(pg.fc.ROOT).as_posix(), "{xdgConfigHome}": Path(xdg).as_posix() if os.path.isabs(xdg) else None}
    out = []
    for key in ("deny", "ask", "childDeny", "removeAsk", "writeAsk"):
        for pat in pg.strings(prot.get(key)):
            if any(val is None and ph in pat for ph, val in subs.items()):
                continue
            for ph, val in subs.items():
                pat = pat.replace(ph, val or "")
            out.append(norm_word(pat))
    return out


def norm_word(text):
    """One form for a pattern and an argv word on every OS: `~` expanded, `/` separators, casefolded
    (Windows expanduser yields backslashes, and Windows paths are case-insensitive)."""
    text = os.path.expanduser(text) if text.startswith("~") else text
    return text.replace("\\", "/").casefold()


def touches_protected(family, patterns):
    """True when an argv word of the family (after the command) names a protected path."""
    for tok in family.split()[1:]:
        t = norm_word(tok.strip("'\"")).rstrip("/")
        if not t or t.startswith("-"):
            continue
        cands = [t] if t.startswith("/") or re.match(r"^[A-Za-z]:/", t) else [t, "/x/" + re.sub(r"^(\./)+", "", t)]
        if any(wildcard_match(p, c) for p in patterns for c in cands):
            return True
    return False


def propose(asks, min_reviews, rules, protect=()):
    """Families approved >= min_reviews times in >= 2 sessions with no deny, minus rule-covered ones and
    ones whose argv touches a write-protected path."""
    fam = {}
    for a in asks:
        if not a["family"] or not a["outcome"]:
            continue
        f = fam.setdefault(a["family"], {"approvals": 0, "denies": 0, "sessions": set()})
        if a["outcome"] == "approved":
            f["approvals"] += 1
            f["sessions"].add(ask_session(a) or "unknown")
        else:
            f["denies"] += 1
    out = []
    for name, f in sorted(fam.items()):
        if f["denies"] or f["approvals"] < min_reviews or len(f["sessions"]) < 2:
            continue
        if name in ("(empty)",) or "N" in name.split() or "HASH" in name.split() or runs_code(name) or touches_protected(name, protect):
            continue
        if any(wildcard_match(r, name) or wildcard_match(r, name + " x") for r in rules):
            continue
        out.append({"pattern": name + " *", "approvals": f["approvals"], "sessions": len(f["sessions"]), "example_family": name})
    out.sort(key=lambda p: (-p["approvals"], p["pattern"]))
    return out


# ------------------------------------------------------------------ trace, usage, session

def trace_metrics(records):
    guards = collections.Counter()
    m = {"guard_blocks": {}, "overlay_blocks": 0, "triage_gate_blocks": 0, "revisions": 0,
         "safe_op_ran": 0, "safe_op_precondition_failed": 0, "supervisor_requests": 0, "turn_causes": {},
         "rereviews": 0, "budget_hits": 0, "rung_up": 0, "child_read_budget": 0, "review_defer_headless": 0, "turns": 0,
         "launch_deferred": 0, "launch_narrowed": 0, "critique_raised": 0, "critique_applied": 0, "critique_rounds": []}
    causes = collections.Counter()
    pack = collections.Counter()
    prpack = collections.Counter()
    for r in records:
        ev, dec = r.get("event"), r.get("decision")
        if ev == "tool_pack" and r.get("pack") == "git":
            op = str(r.get("op") or "?")
            (prpack if op.startswith("pr_") else pack)[op] += 1
        if ev == "guard" and dec in ("block", "deny"):
            guards[str(r.get("guard") or "?")] += 1
        elif ev == "overlay" and dec in ("deny", "ask-denied"):
            m["overlay_blocks"] += 1
        elif ev == "triage_gate":
            m["triage_gate_blocks"] += 1
        elif ev == "revision":
            m["revisions"] += 1
        elif ev == "safe_op" and dec == "ran":
            m["safe_op_ran"] += 1
        elif ev == "safe_op" and dec == "precondition_failed":
            m["safe_op_precondition_failed"] += 1
        elif ev == "supervisor_request":
            m["supervisor_requests"] += 1
        elif ev == "rereview":
            m["rereviews"] += 1
        elif ev in ("read_budget", "recheck_budget") and r.get("action") in ("deny", "remind"):
            m["budget_hits"] += 1
        elif ev == "rung_up":
            m["rung_up"] += 1
        elif ev == "child_read_budget" and r.get("action") in ("warn", "deny"):
            m["child_read_budget"] += 1
        elif ev == "review_defer_headless":
            m["review_defer_headless"] += 1
        elif ev in ("launch_deferred", "launch_narrowed"):
            m[ev] += 1
        elif ev == "critique" and r.get("kind") in ("raised", "applied"):  # rounds.ts CritiqueCounter
            m["critique_" + r["kind"]] += num(r.get("count"))
            if r["kind"] == "raised":
                m["critique_rounds"].append({"raised": num(r.get("count")), "lines": r.get("lines")})
        if ev == "turn":
            m["turns"] += 1
            if r.get("cause"):
                causes[str(r["cause"])] += 1
    m["guard_blocks"] = dict(guards)
    m["turn_causes"] = dict(causes)
    ran, bad = m["safe_op_ran"], m["safe_op_precondition_failed"]
    m["precondition_hit_rate"] = round(bad / (ran + bad), 3) if ran + bad else None
    m["git_pack"] = dict(pack)
    m["pr_pack"] = dict(prpack)
    return m


def num(v):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) else 0


def usage_metrics(records, sid, rates=None):
    """rates: {"provider/model": {input, output, cacheRead, cacheWrite}} in USD per million tokens; used for a
    record whose logged cost total is 0 (the Claude bridge reports none)."""
    roles = {}
    for r in records:
        if sid and r.get("foremanSession") not in (None, sid):
            continue
        if r.get("kind") == "keepalive":  # cache keep-alive spend has its own line (cache_metrics)
            continue
        row = roles.setdefault(str(r.get("role", "?")), {"children": set(), "launches": collections.Counter(),
                                                         "in": 0, "out": 0, "cacheRead": 0, "cacheWrite": 0, "cost": 0.0})
        if r.get("launchId"):
            row["children"].add(r["launchId"])
        row["launches"][str(r.get("kind", "?"))] += 1
        row["in"] += num(r.get("input"))
        row["out"] += num(r.get("output"))
        row["cacheRead"] += num(r.get("cacheRead"))
        row["cacheWrite"] += num(r.get("cacheWrite"))
        logged = num((r.get("cost") or {}).get("total")) if isinstance(r.get("cost"), dict) else 0
        rate = (rates or {}).get("%s/%s" % (r.get("provider"), r.get("model")))
        if not logged and isinstance(rate, dict):
            logged = sum(num(r.get(k)) * num(rate.get(k)) for k in ("input", "output", "cacheRead", "cacheWrite")) / 1e6
        row["cost"] += logged
    return {k: {"children": len(v["children"]), "launches": dict(v["launches"]), "tokensIn": v["in"],
                "tokensOut": v["out"], "cacheRead": v["cacheRead"], "cacheWrite": v["cacheWrite"],
                "cost": round(v["cost"], 4)} for k, v in sorted(roles.items())}


def _ts(r):
    """Epoch seconds of a usage line's `ts` (ISO 8601), or None."""
    v = r.get("ts", r.get("timestamp"))
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return v / 1000.0 if v > 1e11 else float(v)
    if isinstance(v, str):
        try:
            d = datetime.datetime.fromisoformat(v.strip().replace("Z", "+00:00"))
        except ValueError:
            return None
        if d.tzinfo is None:
            d = d.replace(tzinfo=datetime.timezone.utc)
        return d.timestamp()
    return None


def _line_cost(r):
    return num((r.get("cost") or {}).get("total")) if isinstance(r.get("cost"), dict) else 0


def _line_provider(r):
    prov = r.get("provider")
    if isinstance(prov, str) and prov:
        return prov
    model = r.get("model")
    if isinstance(model, str) and "/" in model:
        return model.split("/", 1)[0]
    return None


def cache_metrics(trace, usage, sid, config=None):
    """Keep-alive count and cost, warm-idle compactions and (approximate) cold resumes.
    A cold resume is a non-keep-alive foreman line after a gap above the provider TTL whose cacheRead is below half
    of the previous foreman line's prompt (input + cacheRead + cacheWrite). Without a TTL the count is 0.
    Returns None when there is no usage or trace, or nothing to report (no policy and all counts 0)."""
    if trace is None and usage is None:
        return None
    lines = [r for r in usage or [] if isinstance(r, dict) and not (sid and r.get("foremanSession") not in (None, sid))]
    ka = [r for r in lines if r.get("kind") == "keepalive"]
    warm = sum(1 for e in trace or [] if isinstance(e, dict) and e.get("event") == "compaction"
               and e.get("reason") == "warm_idle")
    down = sum(1 for e in trace or [] if isinstance(e, dict) and e.get("event") == "foreman_model"
               and e.get("reason") == "idle_cold")
    fore = [(t, r) for r in lines if str(r.get("role", "?")) == "foreman" for t in [_ts(r)] if t is not None]
    fore.sort(key=lambda x: x[0])
    session_prov = next((p for p in (_line_provider(r) for _t, r in fore) if p), None)

    def policy(r):
        try:
            return pg.fc.cache_policy(config or {}, _line_provider(r) or session_prov)
        except Exception:  # noqa: BLE001 - the line is optional
            return None
    cold, ttl = 0, None
    for (t0, a), (t1, b) in zip(fore, fore[1:]):
        pol = policy(b)
        if pol and pol.get("ttlSeconds"):
            ttl = pol["ttlSeconds"]
        if b.get("kind") == "keepalive" or not pol or not pol.get("ttlSeconds"):
            continue
        prompt = num(a.get("input")) + num(a.get("cacheRead")) + num(a.get("cacheWrite"))
        if t1 - t0 > pol["ttlSeconds"] and num(b.get("cacheRead")) < 0.5 * prompt:
            cold += 1
    pol = policy(fore[0][1]) if fore else (pg.fc.cache_policy(config or {}, session_prov) if session_prov else None)
    if ttl is None and pol:
        ttl = pol.get("ttlSeconds")
    if not (pol or ka or warm or cold or down):
        return None
    out = {"keepalives": len(ka), "keepaliveCost": round(sum(_line_cost(r) for r in ka), 4),
           "warmCompactions": warm, "coldResumes": cold, "ttlSeconds": ttl}
    if down:
        out["downshiftedTurns"] = down
    return out


def cache_line(c):
    text = "cache: keepalives %d ($%s), warm compactions %d, cold resumes %d" % (
        c["keepalives"], "%.2f" % c["keepaliveCost"], c["warmCompactions"], c["coldResumes"])
    if c.get("downshiftedTurns"):
        text += ", downshifted turns %d" % c["downshiftedTurns"]
    return text


def _rank_tier(ranks, model):
    """Tier of "provider/id" by providers.<p>.ranks (same matching as ranks.ts tierOf), or None."""
    provider, _, ident = model.rpartition("/")
    order = ([provider] if provider in ranks else []) + [p for p in ranks if p != provider]
    for p in order:
        for r in ranks[p]:
            glob = r["match"]
            rx = "".join(".*" if c == "*" else "." if c == "?" else re.escape(c) for c in glob)
            if re.fullmatch(rx, model if "/" in glob else ident):
                return r["tier"]
    return None


def ranks_of(cfg):
    out = {}
    for p, entry in ((cfg or {}).get("providers") or {}).items():
        lst = [r for r in (entry.get("ranks") if isinstance(entry, dict) else None) or []
               if isinstance(r, dict) and isinstance(r.get("match"), str) and r["match"]
               and isinstance(r.get("tier"), int) and not isinstance(r.get("tier"), bool) and r["tier"] >= 0]
        if lst:
            out[p] = lst
    return out


def explorer_metrics(trace, usage, sid, ranks=None):
    """Explorer launches by model. Single launches come from usage lines of role "explorer" (one per launchId);
    tasks/chain entries log role "child" there, so they come from research_rung trace events of kind "entry".
    A single marked launch is therefore counted once (its usage line), never again through its event.
    Fact-critical = research_rung events with that marker. Top-rank share = launches on the models of the
    best tier in providers.<p>.ranks (None without ranks). Unmarked tasks/chain explorer entries come from
    launch_entry events; marked ones emit only research_rung, so nothing is counted twice."""
    by_model = collections.Counter()
    seen = set()
    for r in usage or []:
        if r.get("role") != "explorer" or (sid and r.get("foremanSession") not in (None, sid)):
            continue
        lid = r.get("launchId")
        if lid:
            if lid in seen:
                continue
            seen.add(lid)
        by_model["%s/%s" % (r.get("provider"), r.get("model")) if r.get("provider") else str(r.get("model") or "?")] += 1
    fact = 0
    for r in trace or []:
        if r.get("event") == "launch_entry" and r.get("role") == "explorer":
            by_model[str(r.get("model") or "?")] += 1
            continue
        if r.get("event") != "research_rung" or r.get("role") != "explorer":
            continue
        if r.get("marker") == "fact-critical":
            fact += 1
        if r.get("kind") == "entry":
            by_model[str(r.get("model") or "?")] += 1
    total = sum(by_model.values())
    if not total:
        return None
    ranks = ranks or {}
    tiers = {m: _rank_tier(ranks, m) for m in by_model} if ranks else {}
    best = min(t["tier"] for lst in ranks.values() for t in lst) if ranks else None
    top = sum(n for m, n in by_model.items() if best is not None and tiers[m] == best)
    return {"launches": total, "models": dict(by_model), "factCritical": fact,
            "topShare": round(100.0 * top / total) if best is not None else None,
            "topModels": sorted(m for m in by_model if best is not None and tiers[m] == best),
            "tiers": {m: t for m, t in tiers.items()}}


def render_explorer(e):
    short = lambda m: m.rsplit("/", 1)[-1]
    order = sorted(e["models"], key=lambda m: (e["tiers"].get(m) is None, e["tiers"].get(m) or 0, m))
    items, inline = [], False
    for m in order:
        s = "%s %d" % (short(m), e["models"][m])
        if m in e["topModels"]:
            extra = ["%d %%" % round(100.0 * e["models"][m] / e["launches"])]
            if e["factCritical"] and not inline:
                extra.append("fact-critical %d" % e["factCritical"])
                inline = True
            s += " (%s)" % ", ".join(extra)
        items.append(s)
    line = "explorer: %d launches, %s" % (e["launches"], "; ".join(items))
    if e["factCritical"] and not inline:
        line += "; fact-critical %d" % e["factCritical"]
    return line


SIZING_CLIMBS = ("context", "turns", "stuck", "checks_failed", "review_fail")


def sizing_metrics(trace):
    """Per sizing rule: launches, final-rung counts, later climbs and FAILs. Heuristic join: a launch_sizing owns the
    trace records up to the next launch_sizing of the same role; its climb is a builder rung_up/rung_top with a
    climb reason there, its FAIL a review_done with decision fail. None without launch_sizing events."""
    recs = list(trace or [])
    idx = [i for i, r in enumerate(recs) if r.get("event") == "launch_sizing"]
    out = {}
    for n, i in enumerate(idx):
        r = recs[i]
        m = out.setdefault(str(r.get("rule") or "?"), {"launches": 0, "rungs": collections.Counter(), "climbs": 0, "fails": 0})
        m["launches"] += 1
        m["rungs"][str(r.get("rung") or "?")] += 1
        nxt = next((j for j in idx[n + 1:] if recs[j].get("role") == r.get("role")), len(recs))
        window = recs[i + 1:nxt]
        if any(w.get("event") in ("rung_up", "rung_top") and w.get("role") == "builder" and w.get("reason") in SIZING_CLIMBS for w in window):
            m["climbs"] += 1
        if any(w.get("event") == "review_done" and w.get("decision") == "fail" for w in window):
            m["fails"] += 1
    return {k: {**v, "rungs": dict(v["rungs"])} for k, v in out.items()} or None


def render_sizing(s):
    L = ["sizing (heuristic join): per rule launches, final rung, later climbs, FAILs"]
    for rule in sorted(s):
        v = s[rule]
        L.append("  %s: %d launches, rung %s, climbs %d, fails %d" % (rule, v["launches"], kv(dict(sorted(v["rungs"].items()))), v["climbs"], v["fails"]))
    return L


def session_metrics(records):
    tools = collections.Counter()
    fams = collections.Counter()
    reads = collections.Counter()
    nreads = 0
    bash_git = 0
    for r in records:
        msg = r.get("message") if r.get("type") == "message" else None
        if not isinstance(msg, dict) or msg.get("role") != "assistant" or not isinstance(msg.get("content"), list):
            continue
        for b in msg["content"]:
            if isinstance(b, dict) and b.get("type") == "toolCall":
                name = str(b.get("name", "?"))
                tools[name] += 1
                args = b.get("arguments")
                if name in ("bash", "powershell") and isinstance(args, dict) and isinstance(args.get("command"), str):
                    fam = bash_family(args["command"])
                    fams[fam] += 1
                    bash_git += fam == "git" or fam.startswith("git ")
                elif name == "read":
                    nreads += 1
                    f = args.get("path") or args.get("file_path") if isinstance(args, dict) else None
                    if isinstance(f, str) and f.strip():
                        reads[f.replace("\\", "/").rstrip("/").rsplit("/", 1)[-1]] += 1
    return {"top_tools": dict(tools.most_common(10)),
            "repeated_bash_families": {k: v for k, v in fams.most_common(6) if v >= 3},
            "bash_git_calls": bash_git,
            "read_calls": nreads,
            "repeated_reads": {k: v for k, v in reads.most_common(6) if v >= 3}}


def session_id_of(records):
    for r in records or []:
        if r.get("type") == "session" and isinstance(r.get("id"), str):
            return r["id"]
    return None


# ------------------------------------------------------------------ report

def flagged_counts(trace):
    """{family: count} of the owner's `ask_flag` trace events (None without a trace)."""
    if trace is None:
        return None
    out = {}
    for r in trace:
        if isinstance(r, dict) and r.get("event") == "ask_flag":
            fam = str(r.get("family") or "other")
            out[fam] = out.get(fam, 0) + 1
    return out


def build(session, trace, usage, review, min_reviews, agent_dir, rates=None):
    sid = session_id_of(session)
    ranks = config = None
    if trace is not None or usage is not None:
        try:
            config = pg.fc.load_config(agent_dir)["config"]
            ranks = ranks_of(config)
        except Exception:  # noqa: BLE001 - the share is optional
            ranks = None
    asks = collect_asks(review) if review is not None else None
    rules = load_deny_ask_rules(agent_dir) if asks is not None else []
    return {
        "session": sid,
        "review": review_metrics(asks, sid) if asks is not None else None,
        "trace": trace_metrics(trace) if trace is not None else None,
        "usage": usage_metrics(usage, sid, rates) if usage is not None else None,
        "explorer": explorer_metrics(trace, usage, sid, ranks),
        "cache": cache_metrics(trace, usage, sid, config),
        "sizing": sizing_metrics(trace),
        "session_tools": session_metrics(session) if session is not None else None,
        "flagged_asks": flagged_counts(trace),
        "proposals": propose(asks, min_reviews, rules, load_protect_patterns(agent_dir)) if asks is not None else None,
    }


def kv(d):
    return ", ".join("%s=%s" % (k, v) for k, v in d.items()) or "none"


PACK_OPS = ("status", "log", "diff_stat", "branch_state", "move", "copy", "worktree_remove")


def git_pack_line(rep):
    """`git: pack N calls (...) vs bash git M`, or None when there is nothing to compare."""
    t, s = rep.get("trace"), rep.get("session_tools")
    if t is None and s is None:
        return None
    pack = (t or {}).get("git_pack") or {}
    n = sum(pack.values()) if t is not None else None
    m = s.get("bash_git_calls", 0) if s is not None else None
    if not n and not m:
        return None
    ops = [o for o in PACK_OPS if pack.get(o)] + sorted(o for o in pack if o not in PACK_OPS and pack[o])
    detail = " (%s)" % ", ".join("%s %d" % (o, pack[o]) for o in ops) if n else ""
    return "git: pack %s calls%s vs bash git %s" % ("n/a" if n is None else n, detail, "n/a" if m is None else m)


PR_OPS = ("pr_create", "pr_status", "pr_checks", "pr_comments", "pr_watch")


def pr_pack_line(rep):
    """`pr: N calls (create a, status b, ...)`, or None without a trace or without PR calls."""
    pack = (rep.get("trace") or {}).get("pr_pack") or {}
    n = sum(pack.values())
    if not n:
        return None
    ops = [o for o in PR_OPS if pack.get(o)] + sorted(o for o in pack if o not in PR_OPS and pack[o])
    return "pr: %d calls (%s)" % (n, ", ".join("%s %d" % (o[3:] if o.startswith("pr_") else o, pack[o]) for o in ops))


def render_text(rep, proposals_path=None):
    L = ["pi-foreman retro" + (" (session %s)" % rep["session"] if rep["session"] else "")]
    r = rep["review"]
    if r is None:
        L.append("approvals: no data")
    else:
        L.append("approvals: human approved=%d denied=%d; auto-review allow=%d deny=%d defer=%d"
                 % (r["human_approved"], r["human_denied"], r["review_allow"], r["review_deny"], r["review_defer"]))
        L.append("denials later overridden by an approve of the same family: %d" % r["denials_overridden"])
        if r["unknown_session"]:
            L.append("  (includes %d asks whose session is unknown)" % r["unknown_session"])
    t = rep["trace"]
    if t is None:
        L.append("trace: no data")
        gl = git_pack_line(rep)
        if gl:
            L.append(gl)
        pl = pr_pack_line(rep)
        if pl:
            L.append(pl)
    else:
        L.append("guard blocks: " + kv(t["guard_blocks"]) + "; overlay blocks=%d; triage-gate blocks=%d"
                 % (t["overlay_blocks"], t["triage_gate_blocks"]))
        rate = t["precondition_hit_rate"]
        L.append("revisions=%d; safe ops ran=%d precondition_failed=%d (hit rate %s); supervisor requests=%d"
                 % (t["revisions"], t["safe_op_ran"], t["safe_op_precondition_failed"], "n/a" if rate is None else rate,
                    t["supervisor_requests"]))
        L.append("turn causes: " + kv(t["turn_causes"]))
        L.append("friction: rereviews=%d budget_hits=%d rung_up=%d child_read_budget=%d review_defer_headless=%d turns=%d"
                 % (t["rereviews"], t["budget_hits"], t["rung_up"], t["child_read_budget"], t["review_defer_headless"],
                    t["turns"]))
        if t.get("launch_deferred") or t.get("launch_narrowed"):  # omitted when both are 0
            L.append("pressure: deferred %d, narrowed %d" % (t["launch_deferred"], t["launch_narrowed"]))
        if t.get("critique_rounds"):  # omitted without a counted review
            L.append("critique: raised %d, applied %d; per round raised/diff lines: %s" % (t["critique_raised"], t["critique_applied"],
                     ", ".join("%d/%s" % (x["raised"], "?" if x["lines"] is None else x["lines"]) for x in t["critique_rounds"])))
        gl = git_pack_line(rep)
        if gl:
            L.append(gl)
        pl = pr_pack_line(rep)
        if pl:
            L.append(pl)
    if rep.get("explorer"):
        L.append(render_explorer(rep["explorer"]))
    if rep.get("sizing"):
        L.extend(render_sizing(rep["sizing"]))
    u = rep["usage"]
    if u is None:
        L.append("spawn cost: no data")
    elif not u:
        L.append("spawn cost: none recorded")
    else:
        L.append("spawn cost per role:")
        for role, v in u.items():
            L.append("  %s: children=%d launches{%s} in=%d out=%d cacheRead=%d cacheWrite=%d cost=%s"
                     % (role, v["children"], kv(v["launches"]), v["tokensIn"], v["tokensOut"], v["cacheRead"],
                        v["cacheWrite"], v["cost"]))
    if rep.get("cache"):
        L.append(cache_line(rep["cache"]))
    s = rep["session_tools"]
    if s is None:
        L.append("session tools: no data")
    else:
        L.append("top tools: " + kv(s["top_tools"]))
        L.append("repeated bash families: " + kv(s["repeated_bash_families"]))
    fl = rep.get("flagged_asks")
    if fl:
        L.append("Flagged asks: " + kv(fl))
    p = rep["proposals"]
    if p is None:
        L.append("proposals: no data")
    else:
        L.append("proposals: %d candidate(s)%s" % (len(p), " -> " + str(proposals_path) if proposals_path else ""))
        for c in p[:5]:
            L.append("  %s (approvals=%d, sessions=%d)" % (c["pattern"], c["approvals"], c["sessions"]))
    return "\n".join(L[:30])


def write_proposals(path, proposals, min_reviews, source):
    doc = {"generated": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
           "source": source, "minReviews": min_reviews, "proposals": proposals, "apply_hint": APPLY_HINT}
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")


# ------------------------------------------------------------------ backlog candidates

FRICTION_KINDS = ("agent", "routing", "skill", "rule", "permission", "prompt", "harness-bug")
DEFAULT_ASK_THRESHOLD = 2
OUTLIER_FACTOR = 2
OUTLIER_MIN_RUNS = 3
REPEAT_MIN = 3
BULK_READS = 50


def _tag(value, default="session"):
    """A role/reason word safe for a stable candidate string (no ids, paths or spaces)."""
    s = re.sub(r"[^A-Za-z0-9_-]", "", str(value or ""))[:30]
    return s or default


def _median(vals):
    vals = sorted(vals)
    n = len(vals)
    return vals[n // 2] if n % 2 else (vals[n // 2 - 1] + vals[n // 2]) / 2


def candidates(report, trace_events, usage_lines, session_tools, ask_threshold=DEFAULT_ASK_THRESHOLD):
    """Backlog candidates [{kind, candidate, evidence}] from the retro inputs (pure).

    `candidate` is stable across sessions (role and family names only; no run ids, times or paths),
    so the same finding in a later session bumps one entry. Trace events used: ask, read_budget,
    recheck_budget, child_read_budget, rereview, rung_up, friction. No source signal today (so
    nothing is derived): bulk reads (the trace and the session file carry no per-call file lists,
    only child_read_budget counts), and the command family behind an ask (the trace `ask` event
    has toolFamily, not the command; families come only from the review log via `proposals`).
    A child's `ask` carries role and runId (its launch id); the foreman's own asks have neither and
    count as one `session` bucket."""
    out = []
    report = report or {}
    threshold = ask_threshold if isinstance(ask_threshold, int) and ask_threshold > 0 else DEFAULT_ASK_THRESHOLD
    events = [e for e in (trace_events or []) if isinstance(e, dict)]

    # per-run asks
    runs = {}
    for e in events:
        if e.get("event") == "ask":
            r = runs.setdefault((_tag(e.get("role")), str(e.get("runId") or "")), collections.Counter())
            r[_tag(e.get("toolFamily"), "?")] += 1
    per_role = collections.defaultdict(lambda: [0, 0, collections.Counter()])  # runs over threshold, max asks, families
    for (role, _rid), fams in runs.items():
        n = sum(fams.values())
        if n >= threshold:
            slot = per_role[role]
            slot[0] += 1
            slot[1] = max(slot[1], n)
            slot[2].update(fams)
    for role, (nruns, mx, fams) in sorted(per_role.items()):
        top = ", ".join("%s=%d" % kv_ for kv_ in fams.most_common(3))
        out.append({"kind": "permission", "candidate": "%s runs hit >=%d permission asks" % (role, threshold),
                    "evidence": "%d run(s) over the threshold, most asks in one run: %d; top tools: %s" % (nruns, mx, top)})

    # denials later overridden by an approve of the same family
    rv = report.get("review") or {}
    if rv.get("denials_overridden"):
        out.append({"kind": "permission", "candidate": "denied permission asks were later approved for the same command family",
                    "evidence": "%d overridden denial(s)" % rv["denials_overridden"]})

    # read budgets (agent), rereviews (agent), rung-ups (routing)
    by = collections.defaultdict(collections.Counter)
    for e in events:
        ev = e.get("event")
        if ev == "child_read_budget" and e.get("action") in ("warn", "deny"):
            by["child_read_budget"][_tag(e.get("role"))] += 1
        elif ev in ("read_budget", "recheck_budget") and e.get("action") in ("deny", "remind"):
            by[ev]["session"] += 1
        elif ev == "rereview":
            by["rereview"][_tag(e.get("role"))] += 1
        elif ev == "rung_up":
            by["rung_up"]["%s|%s" % (_tag(e.get("role")), _tag(e.get("reason"), "unspecified"))] += 1
    for role, n in sorted(by["child_read_budget"].items()):
        out.append({"kind": "agent", "candidate": "%s runs hit the child read budget" % role, "evidence": "%d hit(s)" % n})
    for ev, label in (("read_budget", "read budget"), ("recheck_budget", "recheck budget")):
        if by[ev]["session"]:
            out.append({"kind": "agent", "candidate": "the %s was exceeded and blocked a read" % label,
                        "evidence": "%d denial(s)" % by[ev]["session"]})
    for role, n in sorted(by["rereview"].items()):
        out.append({"kind": "agent", "candidate": "%s needed a rereview after changes" % role, "evidence": "%d rereview(s)" % n})
    for key, n in sorted(by["rung_up"].items()):
        role, reason = key.split("|", 1)
        out.append({"kind": "routing", "candidate": "%s climbed a model rung (%s)" % (role, reason), "evidence": "%d climb(s)" % n})

    # per-role cost outliers (usage lines grouped by launch; retro lines are not spawn cost)
    costs = collections.defaultdict(lambda: collections.defaultdict(float))
    for r in usage_lines or []:
        if not isinstance(r, dict) or r.get("kind") == "retro" or not r.get("launchId"):
            continue
        c = r.get("cost")
        costs[_tag(r.get("role"), "?")][str(r["launchId"])] += num(c.get("total")) if isinstance(c, dict) else 0
    for role, runs_ in sorted(costs.items()):
        vals = list(runs_.values())
        med = _median(vals) if len(vals) >= OUTLIER_MIN_RUNS else 0
        big = [v for v in vals if med > 0 and v > OUTLIER_FACTOR * med]
        if big:
            out.append({"kind": "routing", "candidate": "%s run cost over %dx the role median" % (role, OUTLIER_FACTOR),
                        "evidence": "%d of %d run(s); worst %.1fx the median" % (len(big), len(vals), max(big) / med)})

    # bulk reads: the same file read repeatedly, or very many read calls in one session
    st = session_tools or {}
    for base, n in sorted((st.get("repeated_reads") or {}).items()):
        if n >= REPEAT_MIN:
            out.append({"kind": "agent", "candidate": "repeated reads of %s" % base, "evidence": "read %d times in one session" % n})
    if num(st.get("read_calls")) >= BULK_READS:
        out.append({"kind": "agent", "candidate": "bulk reads: >=%d read calls in one session" % BULK_READS,
                    "evidence": "%d read calls" % st["read_calls"]})

    # repeated bash families and permission proposals
    proposals = report.get("proposals") or []
    proposed = {p.get("example_family") for p in proposals if isinstance(p, dict)}
    for fam, n in sorted(((session_tools or {}).get("repeated_bash_families") or {}).items()):
        if n >= REPEAT_MIN:
            out.append({"kind": "permission" if fam in proposed else "rule", "candidate": "repeated bash family: %s" % fam,
                        "evidence": "ran %d times in one session" % n})
    for p in proposals:
        if isinstance(p, dict) and p.get("pattern"):
            out.append({"kind": "permission", "candidate": "allow bash pattern %s" % p["pattern"],
                        "evidence": "approved %s time(s) in %s session(s), never denied" % (p.get("approvals"), p.get("sessions"))})

    # friction events (the Friction: tail of child reports)
    for e in events:
        if e.get("event") == "friction" and str(e.get("note") or "").strip():
            kind = e.get("kind") if e.get("kind") in FRICTION_KINDS else "prompt"
            role = _tag(e.get("role"), "agent")
            out.append({"kind": kind, "candidate": "%s: %s" % (role, e["note"]), "evidence": "Friction line reported by a %s run" % role})

    # asks the owner flagged with /foreman flag-ask: filed into the global store only (foreman_backlog.store_path_for), complete command as evidence
    for e in events:
        if e.get("event") == "ask_flag" and str(e.get("command") or "").strip():
            fam = _tag(e.get("family"), "other")
            out.append({"kind": "flagged-ask", "family": fam, "candidate": "%s: %s via %s" % (fam, _tag(e.get("class"), "unknown"), str(e.get("rule") or "-")[:80]),
                        "evidence": str(e["command"])})
    return out


def emit_backlog(args, report, trace=None, usage=None):
    """File this session's findings in the retro backlog (scripts/foreman_backlog.py). Never fails
    the retro and never changes the report. Returns [(id, created|bumped|seen)]."""
    if getattr(args, "no_backlog", False):
        return []
    try:
        import foreman_backlog as bl
        cwd = args.backlog_workspace or os.getcwd()
        cfg = pg.fc.load_config(args.agent_dir, cwd)["config"]
        rc = cfg.get("retro") if isinstance(cfg.get("retro"), dict) else {}
        if rc.get("enabled") is False:
            return []
        thr = rc.get("askThreshold")
        cands = candidates(report, trace, usage, report.get("session_tools"),
                           thr if isinstance(thr, int) and not isinstance(thr, bool) else DEFAULT_ASK_THRESHOLD)
        sid = args.backlog_session or report.get("session") or re.sub(r"^trace-|\.jsonl$", "", os.path.basename((args.trace or [""])[0])) or None
        res = bl.record(cands, workspace_root=cwd, key=args.workspace_key, session=sid, cfg=cfg, agent_dir=args.agent_dir)
        if res:
            kind = next((c["kind"] for c in cands if c.get("kind")), "agent")
            args.backlog_origin = os.path.basename(bl.store_path_for(kind, workspace_root=cwd, key=args.workspace_key,
                                                                     cfg=cfg, agent_dir=args.agent_dir)[0])
        return res
    except Exception as exc:  # noqa: BLE001 - the retro report matters more than the backlog
        print("retro backlog: %s" % exc, file=sys.stderr)
        return []


def run(args):
    min_reviews = args.min_reviews
    if min_reviews is None:
        min_reviews = DEFAULT_MIN_REVIEWS
        try:
            v = (pg.fc.load_config(args.agent_dir)["config"].get("retro") or {}).get("proposalMinReviews")
            if isinstance(v, int) and not isinstance(v, bool) and v > 0:
                min_reviews = v
        except Exception:
            pass
    rates = None
    if args.rates:
        try:
            with open(args.rates, "r", encoding="utf-8") as fh:
                rates = json.load(fh)
        except (OSError, ValueError):
            pass
    trace, usage = read_traces(args.trace), read_jsonl(args.usage)
    rep = build(read_jsonl(args.session), trace, usage, read_jsonl(args.review_log), min_reviews, args.agent_dir, rates)
    filed = emit_backlog(args, rep, trace, usage)
    note = None
    if args.proposals_out and rep["proposals"] is not None:
        try:
            write_proposals(args.proposals_out, rep["proposals"], min_reviews, os.path.basename(args.review_log or ""))
            note = args.proposals_out
        except OSError as exc:
            print("cannot write proposals: %s" % (exc.strerror or exc), file=sys.stderr)
    if args.json:
        print(json.dumps(rep, indent=2, sort_keys=True))
    else:
        print(render_text(rep, note))
        if filed:
            print("backlog: %d new, %d bumped (%s)" % (sum(1 for _i, st in filed if st == "created"),
                                                       sum(1 for _i, st in filed if st == "bumped"),
                                                       getattr(args, "backlog_origin", "backlog")))
    return 0


# ------------------------------------------------------------------ selftest

def selftest():
    import shutil
    tmp = tempfile.mkdtemp(prefix="foreman_retro_selftest_")
    try:
        rl = os.path.join(tmp, "r.jsonl")
        lines = []
        for i in range(2):
            for s in ("s1", "s2"):
                rid = "%s-%d" % (s, i)
                lines.append({"event": "permission_request.approved", "requestId": rid, "toolName": "bash",
                              "command": "git fetch origin", "timestamp": "2026-01-01T00:00:0%d" % i,
                              "decidedBy": {"kind": "user"}})
                lines.append({"event": "foreman_review.decision", "requestId": rid, "sessionId": s})
        lines.append({"event": "permission_request.approved", "requestId": "x", "toolName": "bash", "command": "sudo ls"})
        with open(rl, "w", encoding="utf-8") as fh:
            for r in lines:
                fh.write(json.dumps(r) + "\n")
            fh.write('{"torn')
        rep = build(None, None, None, read_jsonl(rl), 2, tmp)
        ok = [p["pattern"] for p in rep["proposals"]] == ["git fetch *"]
        print("selftest: " + ("PASS" if ok else "FAIL"))
        return 0 if ok else 1
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def models_main(argv):
    """`foreman retro models [--since 30d] [--source live|panel|bench] [--json]`: per model x rung review stats from the
    findings store (scripts/foreman_findings.py); files a `review-model` backlog candidate for a shadow model whose
    unique accepted findings reach retro.panelThreshold (default 3)."""
    import foreman_findings as ff
    p = argparse.ArgumentParser(prog="foreman retro models")
    p.add_argument("--since")
    p.add_argument("--source", choices=("live", "panel", "bench"))
    p.add_argument("--json", action="store_true")
    p.add_argument("--agent-dir")
    p.add_argument("--cwd", help="repository whose git history resolves the recorded heads (default: current directory)")
    p.add_argument("--workspace-key")
    p.add_argument("--no-backlog", action="store_true")
    args = p.parse_args(argv)
    try:
        since = ff.parse_since(args.since) if args.since else None
    except ValueError as exc:
        print("retro models: %s" % exc, file=sys.stderr)
        return 2
    agent = str(pg.fc.resolve_agent_dir(args.agent_dir))
    cwd = args.cwd or os.getcwd()
    rates = None
    try:
        with open(os.path.join(agent, "pi-foreman", "state", "retro", "rates.json"), "r", encoding="utf-8") as fh:
            rates = json.load(fh)
    except (OSError, ValueError):
        pass
    cache = {}

    def usage(session):
        if session not in cache:
            cache[session] = read_jsonl(os.path.join(agent, "pi-foreman", "state", "usage",
                                                     ff._session_id(session) + ".jsonl"))
        return cache[session]

    table = ff.models_table(ff.load_records(agent), usage=usage, rates=rates, hunks=ff.git_hunks(cwd), since=since,
                            source=args.source)
    if args.json:
        print(json.dumps(table, indent=2, sort_keys=True))
    else:
        print(ff.render_models(table))
    if not args.no_backlog:
        try:
            import foreman_backlog as bl
            cfg = pg.fc.load_config(agent, cwd)["config"]
            thr = (cfg.get("retro") or {}).get("panelThreshold")
            thr = thr if isinstance(thr, int) and not isinstance(thr, bool) and thr > 0 else 3
            cands = ff.shadow_candidates(table, thr)
            if cands:
                bl.record(cands, workspace_root=cwd, key=args.workspace_key, session=None, cfg=cfg, agent_dir=agent)
        except Exception as exc:  # noqa: BLE001 - the table matters more than the backlog
            print("retro backlog: %s" % exc, file=sys.stderr)
    return 0


def main(argv=None):
    argv = sys.argv[1:] if argv is None else list(argv)
    if argv and argv[0] == "models":
        return models_main(argv[1:])
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("--session")
    p.add_argument("--trace", action="append", help="trace file; repeat for the child runs' trace files")
    p.add_argument("--usage")
    p.add_argument("--review-log")
    p.add_argument("--rates", help="JSON file: {provider/model: {input, output, cacheRead, cacheWrite}} USD per million tokens")
    p.add_argument("--proposals-out")
    p.add_argument("--min-reviews", type=int)
    p.add_argument("--agent-dir")
    p.add_argument("--json", action="store_true")
    p.add_argument("--selftest", action="store_true")
    p.add_argument("--backlog-workspace", help="workspace root whose backlog gets this session's findings")
    p.add_argument("--workspace-key", help="backlog key (default: retro.workspaceKey, else derived from the root)")
    p.add_argument("--backlog-session", help="session id recorded with each finding")
    p.add_argument("--no-backlog", action="store_true", help="do not write the backlog")
    args = p.parse_args(argv)
    if args.selftest:
        return selftest()
    return run(args)


if __name__ == "__main__":
    sys.exit(main())
