#!/usr/bin/env python3
"""Findings extraction shared by the review bench and the live reviewer climb (stdlib, 3.9+).

Pure text parsing of a reviewer report: verdict, per-item lines, FAIL evidence units, which repo file a unit names,
line spans, class words. `located_findings` needs no ground truth: it lists the defects a report names in the diff's
files. The scorer (judge, score) stays in foreman_review_bench.py.

    python scripts/foreman_findings.py extract (--files-from FILE | --diff PATCH) < report.txt
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys

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


def main(argv=None):
    p = argparse.ArgumentParser(prog="foreman_findings")
    sub = p.add_subparsers(dest="cmd", required=True)
    ex = sub.add_parser("extract", help="report text on stdin -> JSON {verdict, items, findings}")
    g = ex.add_mutually_exclusive_group(required=True)
    g.add_argument("--files-from", help="file with one repo-relative path per line")
    g.add_argument("--diff", help="unified diff whose files are the diff's files")
    try:
        args = p.parse_args(argv)
    except SystemExit as e:
        return 2 if e.code else 0
    try:
        files = _read_files(args)
    except OSError as e:
        print("foreman_findings: %s" % e, file=sys.stderr)
        return 2
    text = sys.stdin.buffer.read().decode("utf-8", "replace")
    found = [dict(f, id=finding_id(f["file"], f["line"], f["class"])) for f in located_findings(text, files)]
    print(json.dumps({"verdict": verdict_of(text), "items": items_of(text), "findings": found}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
