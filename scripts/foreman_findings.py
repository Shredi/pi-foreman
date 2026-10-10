#!/usr/bin/env python3
"""Findings extraction shared by the review bench and the live reviewer climb (stdlib, 3.9+).

Pure text parsing of a reviewer report: verdict, per-item lines, FAIL evidence units, which repo file a unit names,
line spans, class words. `located_findings` needs no ground truth: it lists the defects a report names in the diff's
files. The scorer (judge, score) stays in foreman_review_bench.py.

    python scripts/foreman_findings.py extract (--files-from FILE | --diff PATCH) < report.txt
    python scripts/foreman_findings.py record --session S --gate item|plan-review|pre-pr|second-opinion --model M --rung N
        --primary 0|1 --role R --run-id ID --source live|panel|bench [--head SHA] [--base SHA] [--item N ...]
        [--verdict PASS|FAIL] [--secs F] [--started-ts ISO] [--cwd REPO] [--agent-dir D] (--files-from F | --diff P) < report
    python scripts/foreman_findings.py list [--since 7d|ISO] [--only-model SUBSTR] [--unique] [--session S] [--json]
    python scripts/foreman_findings.py dismiss ID REASON
    python scripts/foreman_findings.py export ID --to DIR [--repo PATH]

Records live in `<agentDir>/pi-foreman/state/findings/<session>.jsonl` (repo-relative paths only). `outcomes` and
`models_table` (used by `foreman retro models`) are pure functions over those records.
"""
from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import math
import os
import re
import subprocess
import sys
import time
from pathlib import Path

CLASSES = ("auth", "shell-injection", "path-traversal", "secret-log", "off-by-one", "resource-leak", "race",
           "swallowed-error", "insecure-default")

LINE_SLACK = 3

# Class words (regex, case-insensitive, matched at a word start): a FAIL unit naming the defect's file and one of
# its class's words locates it, and diagnoses it when the word is not negated (see judge).
CLASS_SYNONYMS = {
    "auth": [r"auth", r"permission", r"access control", r"privilege", r"bypass", r"unauthori[sz]ed",
             r"pass(?:es|ed)? (?:the )?(?:validation|check)", r"accepts? (?:\w+ ){0,2}characters?"],
    "shell-injection": [r"shell", r"inject", r"unquoted", r"unescaped", r"quot(?:e|ing)", r"metachar",
                        r"execsync", r"sh -c", r"command line"],
    "path-traversal": [r"travers", r"\.\./", r"\.\.\\", r"escape", r"outside (?:the|of)(?! ledger)", r"symlink",
                       r"canonical", r"absolute path", r"sanitiz"],
    "secret-log": [r"secret", r"token", r"credential", r"password", r"bearer", r"authorization header",
                   r"api key", r"leak", r"redact", r"sensitive"],
    "off-by-one": [r"off[- ]by[- ]one", r"fencepost", r"boundar", r"inclusive", r"exclusive", r"one too",
                   r"out of (?:range|bounds)", r"last (?:element|item|byte|line)", r"first (?:element|item)",
                   r"one (?:\w+ )?too (?:far|short|early|late|many|few|high|low)", r"one[- ]\w+ (?:gap|short)",
                   r"one \w+ short", r"[a-z_]\w*\)? ?[-+] ?1(?![\w.])"],
    "resource-leak": [r"leak", r"not closed", r"never closed", r"unclosed", r"close", r"defer", r"handle",
                      r"descriptor", r"not released", r"dispose", r"unbounded", r"grows? without (?:bound|limit)",
                      r"never (?:freed|cleared|drained|trimmed|stop)",
                      r"stale(?! (?:comments?|docs?|documentation|readme|todos?|links?|branch(?:es)?)\b)",
                      r"(?:never|not) (?:\w+ )?(?:clear(?:s|ed)?|reset)\b", r"keeps? its (?:old|last|previous)"],
    "race": [r"race", r"racy", r"lock", r"mutex", r"concurren", r"thread[- ]safe", r"atomic", r"synchroni",
             r"toctou", r"goroutine", r"simultaneous"],
    "swallowed-error": [r"swallow", r"ignor", r"discard", r"silent", r"unchecked", r"not checked",
                        r"error handling", r"lost error", r"unwrap_or", r"except(?:ion)?: pass", r"suppress",
                        r"nothing (?:is |gets )?logged", r"(?:deletes?|removes?|drops?) the (?:\w+ ){0,2}error log",
                        r"error log (?:\w+ ){0,2}(?:was |is )?(?:removed|deleted|dropped|gone)"],
    "insecure-default": [r"insecure", r"default", r"tls", r"verif", r"permissive", r"world[- ]", r"0o?777",
                         r"0o?666", r"plaintext", r"debug"],
}
_SYN = {c: re.compile(r"(?<![\w])(?:%s)" % "|".join(v), re.I) for c, v in CLASS_SYNONYMS.items()}

VERDICT_RE = re.compile(r"\b(?:overall\s+)?verdict\s*\**\s*:\s*\**\s*(pass|fail|approve|block)\b", re.I)
ITEM_RE = re.compile(r"^\s*(?:[-*]\s+)?\**\s*(\d+)\.\s*(?:\d+\.\s*)?\**\s*(PASS|FAIL)\b\**[.:]?\s*(.*)", re.M)
MISSING_RE = re.compile(r"^\W*(?:\d+\.\s*)?\W*missing\s*\**\s*:\s*(.*)", re.I)
DEFECTS_RE = re.compile(r"^\W*(?:\d+\.\s*)?\W*(?:other\s+)?defects\b([^:`/]*?)(?::\s*(.*)|\**\s*)$", re.I)
OVERALL_RE = re.compile(r"^\W*(?:\d+\.\s*)?\W*(?:overall|summary|verdict)\b", re.I)
BULLET_RE = re.compile(r"^\s*(?:[-*+]|\d+[.)]|[a-z][.)])\s")
NONE_RE = re.compile(r"^\W*(?:none|n/a|nothing|no (?:other |further |additional |new )?(?:\w+[ -])?"
                     r"(?:defects?|issues?|problems?)\b)", re.I)
PATHTOKEN_RE = re.compile(r"[\w./\\-]*\w\.[A-Za-z][A-Za-z0-9]{0,5}(?![\w])")
# Line references: `file:N`, `file:~N`, `file:LN`, `file ~N`, `file line(s) N-M`; on a line naming the file but
# not attaching a number to it, `line(s) N`, `~N`, `~LN` or `LN` anywhere on that line.
_NUM = r"~?L?(\d+)(?:\s*[-–]\s*~?L?(\d+))?"
GENERIC_LINE_RE = re.compile(r"(?:\blines?\s+~?L?|~L?|\bL)(\d+)(?:\s*[-–]\s*~?L?(\d+))?", re.I)
NEGATION = ("not", "no", "isn't", "without", "never")
# A FAIL item that locates no plant and only concerns tests not added or not run is a process item, not an FA.
PROCESS_RE = re.compile(
    r"\b(?:no|missing|without|lacks?|adds? no|did not add|does not add|doesn't add)\s+(?:new\s+|regression\s+|unit\s+"
    r"|the\s+|a\s+|any\s+|required\s+)*tests?\b|\btests?\b[^.]{0,40}\b(?:not|never)\s+(?:been\s+)?(?:added|run|written)"
    r"|\b(?:did not|didn't|could not|couldn't|cannot|can't|not)\s+run\s+(?:the\s+|any\s+)?(?:tests?|`?(?:go|cargo|npm)"
    r" test)|\b(?:requires?|required|asks? for|asked for|needs?)\s+(?:an?\s+|any\s+)?(?:new\s+|regression\s+|unit\s+)*"
    r"tests?\b|\btests?\b[^.]{0,40}\b(?:is|are) missing\b|\bha(?:s|ve) no tests?\b"
    r"|\bneither\b[^.]{0,40}\bha(?:s|ve) an? tests?\b", re.I)
# A FAIL unit that marks itself as a note (not blocking, harmless, no signature changed) is a note, not an FA.
NOTE_RE = re.compile(r"\b(?:not blocking|non-?blocking|harmless|informational|no (?:\w+ ){0,2}signatures? (?:is |was |were )?"
                     r"changed|signatures? (?:is |are )?unchanged|surface is unchanged)", re.I)
# ... and so is a unit that only points at another finding (`see the defect below`) without naming a file, and one
# that reports callers or signatures, or rules on the diff-scan facts (agents/reviewer.md).
XREF_RE = re.compile(r"\bsee (?:the )?(?:(?:defects?|items?|findings?) (?:below|above|\d)|below|above)\b", re.I)
NOTE_HEAD_RE = re.compile(r"^\W*(?:facts? (?:to rule on|\d)|callers?\b|(?:changed |exported )*signatures?\b)", re.I)
# Code-like names in a defect description (snake_case, camelCase, Name()), matched as the defect's symbol.
SYMBOL_RE = re.compile(r"\b(?:[A-Za-z]\w*_\w+|[a-z]+[A-Z]\w*|[A-Z][a-z0-9]+[A-Z]\w*|[A-Z]{2,}[a-z]\w*)\b|\b[A-Za-z_]\w*(?=\(\))")


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


def _indent(raw):
    return len(raw) - len(raw.lstrip())


def fail_units(text):
    """The review's FAIL evidence as units, each a list of lines: a `N. FAIL` item with its sub-bullets, one bullet
    group (a top-level bullet with its deeper lines) of a defects section (`Defects ...:` or `N. FAIL. Defects ...`),
    or a `Missing:` line that cites a path. PASS items and their sub-bullets, context and summary prose are never
    evidence."""
    units, cur, mode, top = [], None, None, None
    for raw in (text or "").splitlines():
        line = raw.strip()
        if not line:
            continue
        m = ITEM_RE.match(raw)
        if m:
            cur, top = None, None
            rest = m.group(3)
            if m.group(2).upper() == "PASS":
                mode = "pass"
            elif DEFECTS_RE.match(rest):
                mode = "defects"
                inline = DEFECTS_RE.match(rest).group(2) or ""
                if re.search(r"\w", inline) and not NONE_RE.match(inline):
                    cur = [line]
                    units.append(cur)
            else:
                mode, cur = "fail", [line]
                units.append(cur)
            continue
        m = MISSING_RE.match(line)
        if m:
            mode, cur = None, None
            if PATHTOKEN_RE.search(m.group(1)) and not NONE_RE.match(m.group(1)):
                units.append([line])
            continue
        m = DEFECTS_RE.match(line)
        if m:
            mode, cur, top = "defects", None, None
            if re.search(r"\w", m.group(2) or "") and not NONE_RE.match(m.group(2)):
                cur = [line]
                units.append(cur)
            continue
        if OVERALL_RE.match(line) or VERDICT_RE.search(line):
            mode, cur = None, None
            continue
        nested = _indent(raw) > 0 or BULLET_RE.match(raw)
        if not nested:
            mode, cur = None, None  # unindented prose ends an item or section
        elif mode == "fail":
            cur.append(line)
        elif mode == "defects":
            if BULLET_RE.match(raw) and (top is None or _indent(raw) <= top):
                top = _indent(raw) if top is None else top
                if NONE_RE.match(BULLET_RE.sub("", raw)):
                    cur = None
                    continue
                cur = [line]
                units.append(cur)
            elif cur is not None:
                cur.append(line)
    return units


def fail_evidence(text):
    """FAIL evidence units as text (one string per unit, lines joined)."""
    return ["\n".join(u) for u in fail_units(text)]


def _norm(p):
    return p.replace("\\", "/")


def _unique(files, pred):
    return sum(1 for f in files if pred(_norm(f))) <= 1


def names_file(text, rel, files=()):
    """True when `text` names repo file `rel`. A token with a directory must be the path (or a path ending in it, or
    a directory-bounded tail of it that is unique among `files`); a bare basename counts only when it is unique among
    `files` (the diff's files)."""
    rel = _norm(rel)
    base = rel.rsplit("/", 1)[-1]
    for tok in PATHTOKEN_RE.findall(_norm(text)):
        tok = re.sub(r"^(?:\./)+", "", tok)
        if "/" in tok:
            if tok == rel or tok.endswith("/" + rel):
                return True
            if rel.endswith("/" + tok) and _unique(files, lambda f: f == tok or f.endswith("/" + tok)):
                return True
        elif tok == base and _unique(files, lambda f: f.rsplit("/", 1)[-1] == base):
            return True
    return False


def _line_spans(line, rel):
    """Line spans `line` gives for `rel`: numbers attached to its basename, else the line's generic references."""
    text = _norm(line)
    base = re.escape(_norm(rel).rsplit("/", 1)[-1])
    att = re.findall(base + r"`?(?::\s*|\s+(?=~|L\d|lines?\s)(?:lines?\s+)?)" + _NUM, text)
    found = att or GENERIC_LINE_RE.findall(text)
    return [(int(a), int(b or a)) for a, b in found]


def _negated(text, start):
    clause = re.split(r"[.;:!?]\s", text[:start])[-1]
    words = re.findall(r"[\w']+", clause.lower())[-3:]
    return any(w in NEGATION or w.endswith("n't") for w in words)


def symbols_of(defect):
    return sorted(set(m.group(0) for m in SYMBOL_RE.finditer(defect.get("description") or "")))

def _has_symbol(text, defect):
    return any(re.search(r"(?<![\w])" + re.escape(s) + r"(?![\w])", text) for s in symbols_of(defect))



def patch_files(patch_text):
    """Repo-relative paths a unified diff touches."""
    out = set()
    for m in re.finditer(r"^(?:\+\+\+|---) (?:[ab]/)?(\S+)", patch_text or "", re.M):
        if m.group(1) != "/dev/null":
            out.add(_norm(m.group(1)))
    return sorted(out)




# ------------------------------------------------------------------ located findings (no ground truth)

def _class_of(text):
    """First canonical class (CLASSES order) with a non-negated class word in `text`, else None."""
    for c in CLASSES:
        if any(not _negated(text, m.start()) for m in _SYN[c].finditer(text)):
            return c
    return None


def _loose_units(text, taken):
    """Bullet lines of a report that sit outside any FAIL unit and any PASS item (a PASS can still list defects)."""
    out, in_pass = [], False
    for raw in (text or "").splitlines():
        line = raw.strip()
        if not line:
            continue
        m = ITEM_RE.match(raw)
        if m:
            in_pass = m.group(2).upper() == "PASS"
            continue
        if OVERALL_RE.match(line) or VERDICT_RE.search(line):
            in_pass = False
            continue
        nested = _indent(raw) > 0 or BULLET_RE.match(raw)
        if not nested:
            in_pass = False
        elif BULLET_RE.match(raw) and not in_pass and line not in taken and not NONE_RE.match(BULLET_RE.sub("", raw)):
            out.append([line])
    return out


def finding_id(file, line, cls):
    return hashlib.sha1(("%s\0%s\0%s" % (file, line // 5 if line is not None else "", cls or "")).encode()).hexdigest()[:12]


def located_findings(text, files):
    """Defects a report names in the diff's `files`, without a ground truth: [{file, line, class, note}].
    Units are the FAIL evidence (fail_units) and, for a PASS report, any other bullet outside a PASS item. A finding
    is located when its unit names a file of `files` (names_file rules) and gives a line span or a non-negated class
    word. Units that mark themselves as notes (not blocking, harmless) are skipped. Deduped by (file, line//5, class)."""
    files = list(files or ())
    units = fail_units(text)
    if verdict_of(text) == "pass":
        taken = {ln for u in units for ln in u}
        units = units + _loose_units(text, taken)
    out, seen = [], set()
    for unit in units:
        utext = "\n".join(unit)
        if NOTE_RE.search(utext):
            continue
        cls = _class_of(utext)
        for f in files:
            if not names_file(utext, f, files):
                continue
            spans = [s for ln in unit if names_file(ln, f, files) for s in _line_spans(ln, f)]
            line = spans[0][0] if spans else None
            if line is None and cls is None:
                continue
            key = (_norm(f), line // 5 if line is not None else None, cls)
            if key in seen:
                continue
            seen.add(key)
            out.append({"file": _norm(f), "line": line, "class": cls, "note": unit[0].strip()[:120]})
    return out


def _read_files(args):
    if args.files_from:
        with open(args.files_from, encoding="utf-8") as fh:
            return [_norm(ln.strip()) for ln in fh if ln.strip()]
    with open(args.diff, encoding="utf-8", errors="replace") as fh:
        return patch_files(fh.read())


# ------------------------------------------------------------------ live store (records, list, dismiss)

HERE = os.path.dirname(os.path.abspath(__file__))
PKG_ROOT = os.path.dirname(HERE)
MAX_NOTE = 120
OUTCOME_SLACK = 3
LATE_SLACK = 5


def _utc():
    return datetime.timezone.utc


def _now_iso():
    return datetime.datetime.now(_utc()).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_ts(val):
    """Epoch seconds of an ISO string (naive = UTC), else None."""
    try:
        d = datetime.datetime.fromisoformat(str(val).strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return (d if d.tzinfo else d.replace(tzinfo=_utc())).timestamp()


def parse_since(val):
    """Cutoff epoch seconds from `7d`/`12h`/`2w` or an ISO timestamp; ValueError otherwise."""
    m = re.fullmatch(r"(\d+)([hdw])", str(val).strip())
    if m:
        return time.time() - int(m.group(1)) * {"h": 3600, "d": 86400, "w": 604800}[m.group(2)]
    t = parse_ts(val)
    if t is None:
        raise ValueError("bad --since %r (use 7d, 12h, 2w or an ISO timestamp)" % val)
    return t


def findings_dir(agent_dir=None):
    import foreman_config as fc
    return os.path.join(str(fc.resolve_agent_dir(agent_dir)), "pi-foreman", "state", "findings")


def _session_id(session):
    return re.sub(r"[^A-Za-z0-9._-]", "", str(session or ""))[:64] or "session"


def safe_rel(path, cwd=None):
    """A repo-relative forward-slash path, or None for an absolute path outside `cwd` or one with a `..` segment."""
    p = _norm(str(path)).strip()
    if not p:
        return None
    if p.startswith("/") or re.match(r"^[A-Za-z]:", p):
        if not cwd:
            return None
        root = _norm(os.path.realpath(cwd)).rstrip("/") + "/"
        full = _norm(os.path.realpath(p))
        if not full.startswith(root):
            return None
        p = full[len(root):]
    p = re.sub(r"^(?:\./)+", "", p)
    return None if not p or ".." in p.split("/") else p


def _git(cwd, *args):
    r = subprocess.run(["git", "-C", str(cwd)] + list(args), stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    return r.returncode, r.stdout, r.stderr.decode("utf-8", "replace").strip()


def _append_lines(path, lines):
    import foreman_backlog as bl
    with bl.locked(path):
        with open(path, "a", encoding="utf-8", newline="\n") as fh:
            fh.write("".join(json.dumps(ln, sort_keys=True) + "\n" for ln in lines))


def load_records(agent_dir=None, session=None):
    """All records of the findings store in append order; each carries `_src` (the session file's stem)."""
    d = findings_dir(agent_dir)
    out = []
    try:
        names = sorted(n for n in os.listdir(d) if n.endswith(".jsonl"))
    except OSError:
        return out
    for n in names:
        stem = n[:-6]
        if session and stem != _session_id(session):
            continue
        try:
            with open(os.path.join(d, n), encoding="utf-8", errors="replace") as fh:
                for ln in fh:
                    try:
                        r = json.loads(ln)
                    except ValueError:
                        continue
                    if isinstance(r, dict):
                        r["_src"] = stem
                        out.append(r)
        except OSError:
            continue
    return out


def _write_records(args, text, found, verdict, items):
    head = args.head
    if not head and args.cwd:
        rc, out, _err = _git(args.cwd, "rev-parse", "HEAD")
        head = out.decode().strip() if rc == 0 else None
    ts = _now_iso()
    common = {"session": args.session, "gate": args.gate, "model": args.model, "rung": args.rung,
              "primary": bool(args.primary), "role": args.role, "runId": args.run_id, "head": head, "ts": ts,
              "source": args.source}
    nums = sorted(set(args.item or [i["n"] for i in items]))
    v = (args.verdict or (verdict or "")).upper() or None
    lines = [dict(common, type="review", base=args.base, items=nums, verdict=v, secs=args.secs,
                  startedTs=args.started_ts, findings=len(found))]
    for f in found:
        lines.append(dict(common, type="finding", id=f["id"], file=f["file"], line=f["line"], **{"class": f["class"]},
                          note=f["note"][:MAX_NOTE]))
    _append_lines(os.path.join(findings_dir(args.agent_dir), _session_id(args.session) + ".jsonl"), lines)


def cmd_record(args):
    errors, files = [], []
    try:
        files = [f for f in (safe_rel(x, args.cwd) for x in _read_files(args)) if f]
    except OSError as e:
        errors.append(str(e))
    text = sys.stdin.buffer.read().decode("utf-8", "replace")
    found = [dict(f, id=finding_id(f["file"], f["line"], f["class"])) for f in located_findings(text, files)]
    verdict, items = verdict_of(text), items_of(text)
    print(json.dumps({"verdict": verdict, "items": items, "findings": found}))
    sys.stdout.flush()
    try:
        _write_records(args, text, found, verdict, items)
    except Exception as e:  # noqa: BLE001 - recording must never fail the review
        errors.append(str(e))
    for e in errors:
        print("foreman_findings: record: %s" % e, file=sys.stderr)
    return 0


def _finding_rows(recs):
    ids = {}
    for r in recs:
        if r.get("type") == "finding":
            ids.setdefault(r.get("id"), set()).add(r.get("model"))
    dismissed = {r.get("id") for r in recs if r.get("type") == "dismiss"}
    return ids, dismissed


def cmd_list(args):
    recs = load_records(args.agent_dir)
    models_of, dismissed = _finding_rows(recs)
    cutoff = parse_since(args.since) if args.since else None
    rows = []
    for r in recs:
        if r.get("type") != "finding" or (args.session and r["_src"] != _session_id(args.session)):
            continue
        if cutoff is not None and (parse_ts(r.get("ts")) or 0) < cutoff:
            continue
        if args.only_model and args.only_model.lower() not in str(r.get("model", "")).lower():
            continue
        if args.unique and len(models_of[r.get("id")]) != 1:
            continue
        row = {k: r.get(k) for k in ("id", "session", "gate", "model", "rung", "primary", "file", "line", "class",
                                     "note", "head", "ts", "source")}
        row["dismissed"] = r.get("id") in dismissed
        rows.append(row)
    if args.json:
        print(json.dumps(rows))
    else:
        for r in rows:
            print("%s  %s  %s  %s:%s  %s  %s%s" % (r["id"], str(r["ts"])[:19], r["model"], r["file"],
                                                  r["line"] if r["line"] is not None else "?", r["class"] or "-",
                                                  r["note"] or "", "  [dismissed]" if r["dismissed"] else ""))
    return 0


def cmd_dismiss(args):
    for r in load_records(args.agent_dir):
        if r.get("type") == "finding" and r.get("id") == args.id:
            line = {"type": "dismiss", "id": args.id, "reason": re.sub(r"\s+", " ", args.reason).strip()[:200],
                    "session": r.get("session"), "ts": _now_iso()}
            _append_lines(os.path.join(findings_dir(args.agent_dir), r["_src"] + ".jsonl"), [line])
            print("dismissed %s" % args.id)
            return 0
    print("foreman_findings: no finding with id %s" % args.id, file=sys.stderr)
    return 1


# ------------------------------------------------------------------ export (a finding becomes a bench task)

def _inside(path, root):
    p, r = os.path.normcase(os.path.realpath(path)), os.path.normcase(os.path.realpath(root))
    try:
        return os.path.commonpath([p, r]) == r
    except ValueError:  # different drives
        return False


def default_branch_ref(repo):
    rc, out, _e = _git(repo, "symbolic-ref", "--short", "refs/remotes/origin/HEAD")
    if rc == 0 and out.strip():
        return out.decode().strip()
    for name in ("main", "master"):
        if _git(repo, "rev-parse", "--verify", "--quiet", name)[0] == 0:
            return name
    return None


def ledger_items(top, nums):
    """Text of ledger items `nums` from the newest `.workflow/LEDGER*.md` under `top`, or None."""
    try:
        cands = sorted(Path(top, ".workflow").glob("LEDGER*.md"), key=lambda p: p.stat().st_mtime, reverse=True)
        text = cands[0].read_text("utf-8", "replace") if cands else ""
    except OSError:
        return None
    out = []
    for n in nums:
        m = re.search(r"^[ \t]*(?:[-*][ \t]+)?(?:\[.\][ \t]*)?%d[.)][ \t]+(.+)$" % n, text, re.M)
        if m:
            out.append("%d. %s" % (n, m.group(1).strip()))
    return out or None


def cmd_export(args):
    if not args.to:
        print("foreman_findings: export needs --to <dir>", file=sys.stderr)
        return 2
    repo = os.path.abspath(args.repo or os.getcwd())
    target = os.path.realpath(args.to)
    rc, out, err = _git(repo, "rev-parse", "--show-toplevel")
    top = out.decode().strip() if rc == 0 else None
    if _inside(target, PKG_ROOT) or (top and _inside(target, top)):
        print("foreman_findings: refusing to export inside the package tree or the finding's repo: %s" % target,
              file=sys.stderr)
        return 2
    if not top:
        print("foreman_findings: %s is not a git repository (%s)" % (repo, err), file=sys.stderr)
        return 1
    recs = load_records(args.agent_dir)
    f = next((r for r in reversed(recs) if r.get("type") == "finding" and r.get("id") == args.id), None)
    if f is None:
        print("foreman_findings: no finding with id %s" % args.id, file=sys.stderr)
        return 1
    rev = next((r for r in reversed(recs) if r.get("type") == "review" and r.get("session") == f.get("session")
                and r.get("runId") == f.get("runId")), {})
    rel, head, line, cls = safe_rel(f.get("file") or ""), f.get("head"), f.get("line"), f.get("class")
    if not (rel and head and isinstance(line, int) and cls in CLASSES):
        print("foreman_findings: finding %s lacks a file, head, line or class; not exportable" % args.id,
              file=sys.stderr)
        return 1
    base_ref = rev.get("base") or default_branch_ref(top)
    rc, out, err = _git(top, "merge-base", head, base_ref) if base_ref else (1, b"", "no base and no default branch")
    if rc != 0:
        print("foreman_findings: cannot find the merge base: %s" % err, file=sys.stderr)
        return 1
    mb = out.decode().strip()
    rc, patch, err = _git(top, "diff", "-U10", mb, head, "--", rel)
    if rc != 0 or not patch.strip():
        print("foreman_findings: no diff for %s between merge base and head %s" % (rel, err), file=sys.stderr)
        return 1
    task = os.path.join(target, "harvest-" + args.id)
    if os.path.exists(task):
        print("foreman_findings: %s already exists" % task, file=sys.stderr)
        return 1
    os.makedirs(os.path.join(task, "base"))
    rc, blob, _e = _git(top, "show", "%s:%s" % (mb, rel))
    if rc == 0:  # a file new on the branch has no base copy; the diff adds it
        dest = os.path.join(task, "base", *rel.split("/"))
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with open(dest, "wb") as fh:
            fh.write(blob)
    with open(os.path.join(task, "diff.patch"), "wb") as fh:
        fh.write(patch)
    nums = rev.get("items") or []
    body = ledger_items(top, nums) if nums else None
    prompt = ("Make the change described below.\n\n" + "\n".join("- " + b for b in body) + "\n") if body else (
        "Implement the change in `%s` that the attached diff makes; it is a harvested review task.\n" % rel)
    (Path(task) / "prompt.md").write_text(prompt, encoding="utf-8", newline="\n")
    truth = {"clean": False, "defects": [{"id": args.id, "file": rel, "lines": [max(1, line - 3), line + 3],
                                           "class": cls, "description": f.get("note") or "harvested finding"}]}
    (Path(task) / "ground_truth.json").write_text(json.dumps(truth, indent=2) + "\n", encoding="utf-8", newline="\n")
    harvest = {"source": "harvest", "confirmed": False, "findingId": args.id, "model": f.get("model"),
               "session": f.get("session"), "exportedTs": _now_iso()}
    (Path(task) / "harvest.json").write_text(json.dumps(harvest, indent=2) + "\n", encoding="utf-8", newline="\n")
    import foreman_review_bench as rb
    errs = rb.validate_task(task)
    for e in errs:
        print("foreman_findings: exported task invalid: %s" % e, file=sys.stderr)
    print(task)
    return 1 if errs else 0


# ------------------------------------------------------------------ outcomes

def parse_hunks(diff_text):
    """{old path: [(first, last)]} old-side line ranges of a `git diff -U0` text."""
    out, cur = {}, None
    for ln in (diff_text or "").splitlines():
        if ln.startswith("--- "):
            m = re.match(r"--- (?:a/)?(.*?)\t?$", ln)
            cur = None if (not m or m.group(1) == "/dev/null") else m.group(1)
        elif cur and ln.startswith("@@"):
            m = re.match(r"@@ -(\d+)(?:,(\d+))? ", ln)
            if m:
                s = int(m.group(1))
                out.setdefault(cur, []).append((s, s + max(int(m.group(2) or 1), 1) - 1))
    return out


def git_hunks(cwd):
    """Hunk accessor over the repo at `cwd`: hunks(old_head, new_head) -> parse_hunks result, or None on failure."""
    def hunks(a, b):
        rc, out, _e = _git(cwd, "-c", "core.quotepath=off", "diff", "-U0", "--no-color", a, b)
        return parse_hunks(out.decode("utf-8", "replace")) if rc == 0 else None
    return hunks


def _pass(r):
    return r.get("type") == "review" and r.get("primary") and str(r.get("verdict") or "").upper() == "PASS"


def _near(g, f, slack):
    if g.get("file") != f.get("file") or g.get("class") != f.get("class"):
        return False
    a, b = g.get("line"), f.get("line")
    return a is None or b is None or abs(a - b) <= slack


def outcomes(records, hunks=None):
    """Outcome of every distinct finding, keyed (session, model, id) of its first record (a finding re-reported by the
    same model is the same finding). `hunks(old_head, new_head)` returns {file: [(first, last)]} old-side ranges or
    None (unknown). Result value: {"outcome": accepted|rejected|confirmed_late|open, "late": bool, "miss": (model, rung)
    of the primary PASS that lacked it | None, "finding": record}.
    - accepted: a later review of the session at another head, up to the next primary PASS, changed a hunk within
      file:line+-3 of the finding at its own head;
    - rejected: dismissed, or untouched at the next primary PASS review (unknown without a diff: open);
    - confirmed_late: found after a primary PASS review (the nearest one before it) that did not report it;
    - else open. `late` is also set on an accepted finding that qualifies."""
    sess = lambda r: r.get("session") or r.get("_src")  # noqa: E731
    dismissed = {(sess(r), r.get("id")) for r in records if r.get("type") == "dismiss"}
    dismissed_any = {i for s, i in dismissed if s is None}
    by = {}
    for r in records:
        by.setdefault(sess(r), []).append(r)
    cache, out = {}, {}

    def touched(f, other):
        a, b = f.get("head"), other.get("head")
        if not a or not b:
            return None
        if a == b:
            return False
        if hunks is None:
            return None
        if (a, b) not in cache:
            try:
                cache[(a, b)] = hunks(a, b)
            except Exception:  # noqa: BLE001
                cache[(a, b)] = None
        h = cache[(a, b)]
        if h is None:
            return None
        ranges = h.get(f.get("file"), [])
        if f.get("line") is None:
            return bool(ranges)
        lo, hi = f["line"] - OUTCOME_SLACK, f["line"] + OUTCOME_SLACK
        return any(s <= hi and e >= lo for s, e in ranges)

    for s, recs in by.items():
        seen = set()
        for i, f in enumerate(recs):
            key = (s, f.get("model"), f.get("id"))
            if f.get("type") != "finding" or key in seen:
                continue
            seen.add(key)
            later = [r for r in recs[i + 1:] if r.get("type") == "review" and r.get("runId") != f.get("runId")]
            nxt = next((k for k, r in enumerate(later) if _pass(r)), None)
            scope = later if nxt is None else later[:nxt + 1]
            accepted = any(touched(f, r) is True for r in scope)
            miss = None
            for p in reversed(recs[:i]):
                if not _pass(p) or p.get("runId") == f.get("runId"):
                    continue
                concurrent = (f.get("source") == "panel" and f.get("gate") == p.get("gate")
                              and f.get("head") == p.get("head"))
                has = any(g.get("type") == "finding" and g.get("runId") == p.get("runId") and _near(g, f, LATE_SLACK)
                          for g in recs)
                if not concurrent and not has:
                    miss = (p.get("model"), p.get("rung"))
                break
            if (s, f.get("id")) in dismissed or f.get("id") in dismissed_any:
                label = "rejected"
            elif accepted:
                label = "accepted"
            elif miss:
                label = "confirmed_late"
            elif nxt is not None and all(touched(f, r) is not None for r in scope):
                label = "rejected"
            else:
                label = "open"
            out[key] = {"outcome": label, "late": miss is not None, "miss": miss, "finding": f}
    return out


# ------------------------------------------------------------------ models table

def _nearest_rank(vals, p):
    vals = sorted(vals)
    return vals[max(0, math.ceil(p * len(vals)) - 1)] if vals else None


def _median(vals):
    vals = sorted(vals)
    n = len(vals)
    return None if not n else vals[n // 2] if n % 2 else (vals[n // 2 - 1] + vals[n // 2]) / 2


def _bare(model):
    return str(model or "").split("/")[-1].split(":")[0]


def _reviewer_cost(lines, rates):
    import foreman_retro as fr
    return fr.usage_metrics(lines, None, rates).get("reviewer", {}).get("cost", 0.0)


def models_table(records, *, usage=None, rates=None, hunks=None, since=None, source=None):
    """Per model x rung rows over review/finding records. `usage(session) -> [usage lines]`, `rates` as retro's
    usage_metrics. `since`: cutoff epoch seconds. Returns {"rows", "timeToClean", "shadows"}."""
    outs = outcomes(records, hunks)
    models_of, _d = _finding_rows(records)

    def keep(r):
        return (not source or r.get("source") == source) and (since is None or (parse_ts(r.get("ts")) or 0) >= since)

    rows = {}

    def row(m, rung):
        return rows.setdefault((m, rung), {"model": m, "rung": rung, "primary": False, "reviews": 0, "findings": 0,
                                           "accepted": 0, "rejected": 0, "unique": 0, "lateMisses": 0, "_secs": [],
                                           "_lines": []})

    reviews = [r for r in records if r.get("type") == "review" and keep(r)]
    for r in reviews:
        x = row(r.get("model"), r.get("rung"))
        x["reviews"] += 1
        x["primary"] = x["primary"] or bool(r.get("primary"))
        if isinstance(r.get("secs"), (int, float)):
            x["_secs"].append(r["secs"])
    shadow = {}
    for o in outs.values():
        f = o["finding"]
        if keep(f):
            x = row(f.get("model"), f.get("rung"))
            x["findings"] += 1
            x["accepted"] += o["outcome"] == "accepted"
            x["rejected"] += o["outcome"] == "rejected"
            uniq = models_of.get(f.get("id")) == {f.get("model")}
            x["unique"] += uniq
            if uniq and o["outcome"] == "accepted" and not f.get("primary"):
                shadow.setdefault(f.get("model"), []).append(f.get("id"))
            if o["late"]:
                row(*o["miss"])["lateMisses"] += 1
    used = set()
    for r in reviews:
        end = parse_ts(r.get("ts"))
        if end is None or not usage:
            continue
        start = parse_ts(r.get("startedTs"))
        if start is None:
            start = end - (r["secs"] if isinstance(r.get("secs"), (int, float)) else 0)
        for k, u in enumerate(usage(r.get("session")) or []):
            t = parse_ts(u.get("ts"))
            tag = (r.get("session"), k)
            if (u.get("role") == "reviewer" and tag not in used and t is not None and start <= t <= end
                    and _bare(u.get("model")) == _bare(r.get("model"))):
                used.add(tag)
                row(r.get("model"), r.get("rung"))["_lines"].append(u)
    out = []
    for (m, rung), x in sorted(rows.items(), key=lambda kv: (str(kv[0][0]), kv[0][1] if kv[0][1] is not None else -1)):
        usd = round(_reviewer_cost(x.pop("_lines"), rates), 4) if usage else None
        secs = x.pop("_secs")
        x.update(usd=usd, usdPerAccepted=round(usd / x["accepted"], 4) if usd is not None and x["accepted"] else None,
                 medianSecs=_median(secs), p90Secs=_nearest_rank(secs, 0.9))
        out.append(x)
    ttc, first = [], {}
    for r in (r for r in reviews if r.get("primary")):
        end = parse_ts(r.get("ts"))
        start = parse_ts(r.get("startedTs")) or (end - r["secs"] if end is not None and isinstance(r.get("secs"), (int, float)) else end)
        clean = str(r.get("verdict") or "").upper() == "PASS" and not r.get("findings")
        for n in r.get("items") or []:
            k = (r.get("session"), n)
            if k not in first:
                first[k] = start
            if clean and first[k] is not None and end is not None and first[k] != "done":
                ttc.append(end - first[k])
                first[k] = "done"
    return {"rows": out, "timeToClean": {"items": len(ttc), "medianSecs": _median(ttc),
                                         "p90Secs": _nearest_rank(ttc, 0.9)},
            "shadows": {m: {"uniqueAccepted": len(ids), "ids": ids} for m, ids in shadow.items()}}


def shadow_candidates(table, threshold=3):
    """Backlog candidates (kind review-model) for shadows whose unique accepted count reaches `threshold`."""
    return [{"kind": "review-model", "evidence": ", ".join(s["ids"]),
             "candidate": "shadow %s found %d unique accepted findings; consider it as primary or rung" % (m, s["uniqueAccepted"])}
            for m, s in sorted(table["shadows"].items()) if s["uniqueAccepted"] >= threshold]


def render_models(table):
    def f(v, nd=2):
        return "-" if v is None else ("%.*f" % (nd, v) if isinstance(v, float) else str(v))
    head = ("model", "rung", "reviews", "findings", "accepted", "rejected", "unique", "late-miss", "usd", "usd/acc",
            "med s", "p90 s")
    lines = ["  ".join(head)]
    for r in table["rows"]:
        lines.append("  ".join([str(r["model"]), f(r["rung"]), str(r["reviews"]), str(r["findings"]), str(r["accepted"]),
                                str(r["rejected"]), str(r["unique"]), str(r["lateMisses"]), f(r["usd"], 4),
                                f(r["usdPerAccepted"], 4), f(r["medianSecs"], 1), f(r["p90Secs"], 1)]))
    t = table["timeToClean"]
    lines.append("time to clean (primary, per item): n=%d median=%s p90=%s" % (t["items"], f(t["medianSecs"], 1),
                                                                            f(t["p90Secs"], 1)))
    return "\n".join(lines)


# ------------------------------------------------------------------ CLI

def build_parser():
    p = argparse.ArgumentParser(prog="foreman_findings")
    sub = p.add_subparsers(dest="cmd", required=True)
    ex = sub.add_parser("extract", help="report text on stdin -> JSON {verdict, items, findings}")
    g = ex.add_mutually_exclusive_group(required=True)
    g.add_argument("--files-from", help="file with one repo-relative path per line")
    g.add_argument("--diff", help="unified diff whose files are the diff's files")
    rc = sub.add_parser("record", help="extract (report on stdin) and append review + finding records")
    rc.add_argument("--session", required=True)
    rc.add_argument("--gate", required=True, choices=("item", "plan-review", "pre-pr", "second-opinion"))
    rc.add_argument("--model", required=True)
    rc.add_argument("--rung", required=True, type=int)
    rc.add_argument("--primary", required=True, type=int, choices=(0, 1))
    rc.add_argument("--role", required=True)
    rc.add_argument("--run-id", required=True)
    rc.add_argument("--source", required=True, choices=("live", "panel", "bench"))
    rc.add_argument("--head")
    rc.add_argument("--base")
    rc.add_argument("--item", type=int, action="append")
    rc.add_argument("--verdict", choices=("PASS", "FAIL"))
    rc.add_argument("--secs", type=float)
    rc.add_argument("--started-ts")
    rc.add_argument("--cwd")
    rc.add_argument("--agent-dir")
    g = rc.add_mutually_exclusive_group(required=True)
    g.add_argument("--files-from")
    g.add_argument("--diff")
    ls = sub.add_parser("list", help="list located findings")
    ls.add_argument("--since")
    ls.add_argument("--only-model")
    ls.add_argument("--unique", action="store_true", help="only findings found by exactly one model")
    ls.add_argument("--session")
    ls.add_argument("--json", action="store_true")
    ls.add_argument("--agent-dir")
    ds = sub.add_parser("dismiss", help="mark a finding as rejected")
    ds.add_argument("id")
    ds.add_argument("reason")
    ds.add_argument("--agent-dir")
    xp = sub.add_parser("export", help="write a finding as an unconfirmed bench task dir")
    xp.add_argument("id")
    xp.add_argument("--to", help="directory that receives <dir>/harvest-<id>/ (required)")
    xp.add_argument("--repo", help="the finding's repository (default: current directory)")
    xp.add_argument("--agent-dir")
    return p


def main(argv=None):
    p = build_parser()
    try:
        args = p.parse_args(argv)
    except SystemExit as e:
        return 2 if e.code else 0
    if args.cmd == "extract":
        try:
            files = _read_files(args)
        except OSError as e:
            print("foreman_findings: %s" % e, file=sys.stderr)
            return 2
        text = sys.stdin.buffer.read().decode("utf-8", "replace")
        found = [dict(f, id=finding_id(f["file"], f["line"], f["class"])) for f in located_findings(text, files)]
        print(json.dumps({"verdict": verdict_of(text), "items": items_of(text), "findings": found}))
        return 0
    try:
        return {"record": cmd_record, "list": cmd_list, "dismiss": cmd_dismiss, "export": cmd_export}[args.cmd](args)
    except ValueError as e:
        print("foreman_findings: %s" % e, file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
