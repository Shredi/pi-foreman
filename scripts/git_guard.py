#!/usr/bin/env python3
"""pi-foreman git guard (stdlib, Python 3.9+).

Reads a Claude-hook-shaped PreToolUse payload on stdin and prints the same decision
JSON the core guards print:

    {"hookSpecificOutput": {"hookEventName": "PreToolUse",
                            "permissionDecision": "deny" | "ask",
                            "permissionDecisionReason": "..."}}

No output means "no objection". Exit 0 for every decision; exit 2 (stderr, no stdout)
on an internal error, which the pi-foreman adapter treats as a block.

    git_guard.py --mode child|main [--config FILE]

Input fields: tool_name ("Bash"/"PowerShell"), tool_input.command, cwd, and optionally
`shell` ("bash" | "powershell" | "cmd") and `foreman_git` (the merged `safety.git`
object). `--config FILE` is a JSON file holding either that object or a whole foreman
config; `foreman_git` on stdin wins over it.

Modes
  child  Blocks history- and work-destroying git forms and every push (list in
         CHILD RULES below), including the same forms reached through wrappers
         (bash -c, eval, env, xargs, sudo, pwsh -Command, ...), git aliases and
         `-c alias.*`. A command it cannot read that mentions git is blocked.
  main   Commit lint (message pattern, trailers, explicit staging, check command)
         and push lint (no force, mirror or delete on protected branches).
         A command it cannot read that mentions git is an ask.

The guard reads command strings only. It runs git read-only (`git config`,
`git symbolic-ref`, `git diff --cached`) and the configured check command.
It is not a sandbox: a script or build file can still call git.
"""
from __future__ import annotations

import fnmatch
import json
import os
import re
import shutil
import subprocess
import sys

MAX_DEPTH = 4
MAX_ALIAS_HOPS = 8
GIT_TIMEOUT = 2.0
CHECK_TIMEOUT = 3.0
REASON_MAX = 600

DEFAULT_MESSAGE_PATTERN = (
    r"^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)"
    r"(\([A-Za-z0-9._/-]+\))?!?: \S|^merge: \S"
)
DEFAULT_CONFIG = {
    "protectedBranches": ["main", "master"],
    "commit": {
        "messagePattern": DEFAULT_MESSAGE_PATTERN,
        "requiredTrailers": [],
        "forbiddenTrailers": [],
        "checkCommand": None,
    },
}

ALLOW, ASK, DENY = 0, 1, 2
PREFIX = "pi-foreman git guard: "
USE_M = "use -m or -F <file> so the message can be checked"
GIT_WORD = re.compile(r"(?i)(?<![a-z])git(?![a-z])")


class Decision(object):
    __slots__ = ("level", "reason")

    def __init__(self, level=ALLOW, reason=""):
        self.level = level
        self.reason = reason


OK = Decision()


def worst(a, b):
    return b if b.level > a.level else a


class GuardError(Exception):
    pass


# =========================================================================== lexer

class Word(object):
    """One shell word. `text` is the static value (quotes removed, escapes applied);
    every expansion whose value is unknown leaves a NUL in it and sets `dynamic`."""
    __slots__ = ("text", "dynamic", "glob", "raw")

    def __init__(self, text, dynamic=False, glob=False, raw=None):
        self.text = text
        self.dynamic = dynamic
        self.glob = glob
        self.raw = text if raw is None else raw

    def __repr__(self):  # pragma: no cover - debugging aid
        return "Word(%r%s)" % (self.text, ", dyn" if self.dynamic else "")


class Seg(object):
    __slots__ = ("words", "heredocs", "herestrings", "pipe_in")

    def __init__(self, pipe_in=False):
        self.words = []
        self.heredocs = []
        self.herestrings = []
        self.pipe_in = pipe_in

    def raw(self):
        return " ".join([w.raw for w in self.words] + [w.raw for w in self.herestrings] + self.heredocs)


class LexError(Exception):
    pass


SMART = {0x2018: "'", 0x2019: "'", 0x201A: "'", 0x201B: "'",
         0x201C: '"', 0x201D: '"', 0x201E: '"'}
ANSI = {"n": "\n", "t": "\t", "r": "\r", "a": "\a", "b": "\b", "e": "\x1b", "E": "\x1b",
        "f": "\f", "v": "\v", "\\": "\\", "'": "'", '"': '"', "?": "?"}


class Lexer(object):
    """Splits a command line into segments (on ; && || | & newline and grouping
    parentheses/braces) of words, and collects the text of every command or
    process substitution for separate analysis. Flavours: bash, powershell, cmd."""

    def __init__(self, src, flavor="bash"):
        if flavor == "powershell":
            src = src.translate(SMART)
        self.s = src
        self.n = len(src)
        self.f = flavor
        self.esc = {"bash": "\\", "powershell": "`", "cmd": "^"}[flavor]
        self.segs = []
        self.subs = []
        self.cur = Seg()
        self.w = None
        self.wdyn = False
        self.wglob = False
        self.wstart = 0
        self.redir = None
        self.pending = []

    # ------------------------------------------------------------- word helpers
    def start(self, i):
        if self.w is None:
            self.w = []
            self.wdyn = False
            self.wglob = False
            self.wstart = i

    def end_word(self, i):
        if self.w is None:
            return
        word = Word("".join(self.w), self.wdyn, self.wglob, self.s[self.wstart:i])
        self.w = None
        kind, self.redir = self.redir, None
        if kind is None:
            self.cur.words.append(word)
        elif kind.startswith("heredoc"):
            quoted = any(q in word.raw for q in "'\"\\")
            self.pending.append((word.text, kind == "heredoc-", quoted, self.cur))
        elif kind == "herestring":
            self.cur.herestrings.append(word)

    def end_seg(self, i, pipe_next=False):
        self.end_word(i)
        self.redir = None
        c = self.cur
        if c.words or c.herestrings or any(p[3] is c for p in self.pending):
            self.segs.append(c)
        self.cur = Seg(pipe_in=pipe_next)

    def dyn(self):
        self.wdyn = True
        self.w.append("\0")

    # ------------------------------------------------------------- scanners
    def match_close(self, k, op, cl):
        """Index of the `cl` matching the `op` at s[k], skipping quoted text."""
        s, n, depth, j = self.s, self.n, 0, k
        while j < n:
            c = s[j]
            if c == self.esc:
                j += 2
                continue
            if c == "'" and self.f != "cmd":
                e = s.find("'", j + 1)
                if e < 0:
                    raise LexError("unterminated quote")
                j = e + 1
                continue
            if c == '"':
                j += 1
                while j < n and s[j] != '"':
                    j += 2 if s[j] == self.esc else 1
                if j >= n:
                    raise LexError("unterminated quote")
                j += 1
                continue
            if c == op:
                depth += 1
            elif c == cl:
                depth -= 1
                if depth == 0:
                    return j
            j += 1
        raise LexError("unbalanced %s" % op)

    def dquote(self, j):
        """Body of a double-quoted string starting at s[j]; returns the index after it."""
        s, n = self.s, self.n
        while j < n:
            c = s[j]
            if c == '"':
                if self.f == "powershell" and j + 1 < n and s[j + 1] == '"':
                    self.w.append('"')
                    j += 2
                    continue
                return j + 1
            if self.f == "bash" and c == "\\" and j + 1 < n and s[j + 1] in '$`"\\\n':
                if s[j + 1] != "\n":
                    self.w.append(s[j + 1])
                j += 2
                continue
            if self.f == "powershell" and c == "`" and j + 1 < n:
                self.w.append(s[j + 1])
                j += 2
                continue
            if c == "$" and self.f != "cmd":
                j = self.dollar(j, True)
                continue
            if c == "`" and self.f == "bash":
                j = self.backtick(j)
                continue
            if c in "%!" and self.f == "cmd":
                j = self.cmdvar(j)
                continue
            self.w.append(c)
            j += 1
        raise LexError("unterminated quote")

    def dollar(self, j, in_dq):
        s, n = self.s, self.n
        nx = s[j + 1] if j + 1 < n else ""
        if nx == "(":
            k = self.match_close(j + 1, "(", ")")
            inner = s[j + 2:k]
            if self.f == "bash" and inner.startswith("(") and inner.endswith(")"):
                inner = inner[1:-1]
            self.subs.append(inner)
            self.dyn()
            return k + 1
        if nx == "{":
            k = self.match_close(j + 1, "{", "}")
            if self.f == "bash":
                self.subs.append(s[j + 2:k])
            self.dyn()
            return k + 1
        if self.f == "bash" and not in_dq and nx == "'":
            return self.ansi_c(j + 2)
        if self.f == "bash" and not in_dq and nx == '"':
            return self.dquote(j + 2)
        if nx and (nx.isalnum() or nx == "_" or (self.f == "bash" and nx in "@*#?$!-")):
            k = j + 1
            if nx.isalpha() or nx == "_":
                while k < n and (s[k].isalnum() or s[k] == "_" or (self.f == "powershell" and s[k] == ":")):
                    k += 1
            else:
                k += 1
            self.dyn()
            return k
        self.w.append("$")
        return j + 1

    def ansi_c(self, j):
        s, n = self.s, self.n
        while j < n:
            c = s[j]
            if c == "'":
                return j + 1
            if c == "\\" and j + 1 < n:
                e = s[j + 1]
                if e in ANSI:
                    self.w.append(ANSI[e])
                    j += 2
                elif e in "xuU":
                    width = {"x": 2, "u": 4, "U": 8}[e]
                    m = re.match(r"[0-9A-Fa-f]{1,%d}" % width, s[j + 2:])
                    if m:
                        self.w.append(chr(int(m.group(0), 16)))
                        j += 2 + len(m.group(0))
                    else:
                        self.w.append("\\" + e)
                        j += 2
                elif e in "01234567":
                    m = re.match(r"[0-7]{1,3}", s[j + 1:])
                    self.w.append(chr(int(m.group(0), 8)))
                    j += 1 + len(m.group(0))
                elif e == "c" and j + 2 < n:
                    self.w.append(chr(ord(s[j + 2]) & 0x1F))
                    j += 3
                else:
                    self.w.append("\\" + e)
                    j += 2
                continue
            self.w.append(c)
            j += 1
        raise LexError("unterminated quote")

    def backtick(self, j):
        s, n = self.s, self.n
        k = j + 1
        while k < n and s[k] != "`":
            k += 2 if s[k] == "\\" else 1
        if k >= n:
            raise LexError("unterminated backtick")
        inner = re.sub(r"\\([`$\\])", r"\1", s[j + 1:k])
        self.subs.append(inner)
        self.dyn()
        return k + 1

    def cmdvar(self, j):
        s = self.s
        c = s[j]
        k = s.find(c, j + 1)
        if k > j + 1 and re.match(r"^[A-Za-z0-9_~:,=\-]+$", s[j + 1:k]):
            self.dyn()
            return k + 1
        self.w.append(c)
        return j + 1

    def heredoc_bodies(self, i):
        s, n = self.s, self.n
        for delim, strip, quoted, seg in self.pending:
            lines = []
            while i < n:
                e = s.find("\n", i)
                line = s[i:e] if e >= 0 else s[i:]
                i = e + 1 if e >= 0 else n
                cmp = line.lstrip("\t") if strip else line
                if cmp.rstrip("\r") == delim:
                    break
                lines.append(line)
            body = "\n".join(lines)
            seg.heredocs.append(body)
            if not quoted:
                self.subs.extend(expansion_subs(body))
        self.pending = []
        return i

    # ------------------------------------------------------------- main loop
    def run(self):
        s, n, f = self.s, self.n, self.f
        i = 0
        while i < n:
            c = s[i]
            if c in " \t\r\f\v":
                self.end_word(i)
                i += 1
                continue
            if c == "\n":
                self.end_seg(i)
                i = self.heredoc_bodies(i + 1)
                continue
            if c == "#" and self.w is None and f != "cmd":
                e = s.find("\n", i)
                i = n if e < 0 else e
                continue
            if f == "powershell" and self.w is None and s.startswith("<#", i):
                e = s.find("#>", i + 2)
                i = n if e < 0 else e + 2
                continue
            if f == "powershell" and self.w is None and s.startswith("--%", i) and (i + 3 >= n or s[i + 3] in " \t"):
                e = s.find("\n", i)
                e = n if e < 0 else e
                for part in s[i + 3:e].split():
                    self.cur.words.append(Word(part))
                i = e
                continue
            if f == "powershell" and self.w is None and s[i:i + 2] in ("@'", '@"') and s[i + 2:i + 3] in ("\n", "\r"):
                q = s[i + 1]
                e = s.find("\n" + q + "@", i + 2)
                if e < 0:
                    raise LexError("unterminated here-string")
                self.start(i)
                body = s[i + 2:e].lstrip("\r\n")
                self.w.append(body)
                if q == '"':
                    found = expansion_subs(body, "powershell")
                    if found or "$" in body:
                        self.wdyn = True
                    self.subs.extend(found)
                i = e + 3
                continue
            if c == self.esc:
                self.start(i)
                if i + 1 < n:
                    nx = s[i + 1]
                    if nx == "\n":
                        i += 2
                        continue
                    if nx == "\r" and s[i + 2:i + 3] == "\n":
                        i += 3
                        continue
                    self.w.append(nx)
                    i += 2
                else:
                    self.w.append(c)
                    i += 1
                continue
            if c == "'" and f != "cmd":
                self.start(i)
                if f == "powershell":
                    j = i + 1
                    while True:
                        e = s.find("'", j)
                        if e < 0:
                            raise LexError("unterminated quote")
                        if s[e + 1:e + 2] == "'":
                            self.w.append(s[j:e] + "'")
                            j = e + 2
                            continue
                        self.w.append(s[j:e])
                        i = e + 1
                        break
                else:
                    e = s.find("'", i + 1)
                    if e < 0:
                        raise LexError("unterminated quote")
                    self.w.append(s[i + 1:e])
                    i = e + 1
                continue
            if c == '"':
                self.start(i)
                i = self.dquote(i + 1)
                continue
            if c == "$" and f != "cmd":
                self.start(i)
                i = self.dollar(i, False)
                continue
            if f == "powershell" and c == "@" and s[i + 1:i + 2] == "(":
                k = self.match_close(i + 1, "(", ")")
                self.subs.append(s[i + 2:k])
                self.start(i)
                self.dyn()
                i = k + 1
                continue
            if c == "`" and f == "bash":
                self.start(i)
                i = self.backtick(i)
                continue
            if c in "%!" and f == "cmd":
                self.start(i)
                i = self.cmdvar(i)
                continue
            if c in ";&|":
                self.end_word(i)
                two = s[i:i + 2]
                if f == "bash" and c == "&" and two == "&>":
                    i += 3 if s[i:i + 3] == "&>>" else 2
                    self.redir = "file"
                    continue
                if two in ("&&", "||", ";;", "|&", ";&"):
                    self.end_seg(i, pipe_next=two == "|&")
                    i += 2
                    if s[i - 2:i + 1] == ";;&":
                        i += 1
                    continue
                self.end_seg(i, pipe_next=c == "|")
                i += 1
                continue
            if c in "<>" or (c == "*" and f == "powershell" and s[i + 1:i + 2] == ">" and self.w is None):
                if c == "*":
                    i += 1
                    c = ">"
                if self.w is not None and "".join(self.w).isdigit() and not self.wdyn:
                    self.w = None
                else:
                    self.end_word(i)
                if f == "bash" and s[i + 1:i + 2] == "(":
                    k = self.match_close(i + 1, "(", ")")
                    self.subs.append(s[i + 2:k])
                    self.start(i)
                    self.dyn()
                    i = k + 1
                    continue
                if f == "bash" and s.startswith("<<<", i):
                    self.redir, i = "herestring", i + 3
                elif f == "bash" and s.startswith("<<-", i):
                    self.redir, i = "heredoc-", i + 3
                elif f == "bash" and s.startswith("<<", i):
                    self.redir, i = "heredoc", i + 2
                elif s[i:i + 2] in (">>", ">|", "<>", ">&", "<&"):
                    self.redir, i = "file", i + 2
                else:
                    self.redir, i = "file", i + 1
                continue
            if c in "()":
                self.end_seg(i)
                i += 1
                continue
            if c in "{}":
                lone = self.w is None and (i + 1 >= n or s[i + 1] in " \t\r\n;&|)")
                if f == "powershell" or lone:
                    self.end_seg(i)
                    i += 1
                    continue
                self.start(i)
                self.w.append(c)
                self.wglob = True
                i += 1
                continue
            if c in "*?[" and f != "cmd":
                self.start(i)
                self.w.append(c)
                self.wglob = True
                i += 1
                continue
            self.start(i)
            self.w.append(c)
            i += 1
        self.end_seg(n)
        return self


def expansion_subs(body, flavor="bash"):
    """Command substitutions inside an unquoted heredoc or expandable here-string."""
    lx = Lexer(body, flavor)
    lx.start(0)
    i, n = 0, len(body)
    while i < n:
        c = body[i]
        if flavor == "bash" and c == "\\":
            i += 2
        elif c == "$":
            try:
                i = lx.dollar(i, True)
            except LexError:
                i += 1
        elif c == "`" and flavor == "bash":
            try:
                i = lx.backtick(i)
            except LexError:
                i += 1
        else:
            i += 1
    return lx.subs


def lex(text, flavor):
    return Lexer(text, flavor).run()


# ====================================================================== analysis

SHELLS = {"bash", "sh", "zsh", "dash", "ksh", "ash", "mksh", "yash", "fish", "rbash", "busybox"}
PWSH = {"pwsh", "powershell", "pwsh-preview"}
INTERPRETERS = {"python", "python3", "python2", "py", "pythonw", "node", "nodejs", "deno", "bun",
                "perl", "ruby", "php", "lua", "osascript", "tclsh", "rscript", "groovy", "jshell"}
INLINE_FLAGS = {"-c", "-e", "-E", "--eval", "-p", "--print", "-r", "eval", "-command", "--command"}
KEYWORDS = {
    "bash": {"!", "if", "then", "else", "elif", "fi", "do", "done", "while", "until", "esac",
             "function", "coproc", "{", "}", "in"},
    "powershell": {"if", "elseif", "else", "foreach", "for", "while", "do", "until", "switch", "try",
                   "catch", "finally", "trap", "function", "filter", "begin", "process", "end",
                   "return", "!", "-not"},
    "cmd": {"@echo", "call"},
}
HEADER_KEYWORDS = {"for", "select", "case"}
EXEC_KEY = re.compile(
    r"^(core\.(pager|editor|sshcommand|fsmonitor|askpass|gitproxy)|sequence\.editor|pager\..+|"
    r"diff\.external|diff\..+\.(command|textconv)|merge\..+\.driver|filter\..+\.(clean|smudge|process)|"
    r"credential(\..+)?\.helper|gpg(\..+)?\.program|uploadpack\.packobjectshook|"
    r"remote\..+\.(receivepack|uploadpack|vcs)|sendemail\..+|difftool\..+\.cmd|mergetool\..+\.cmd|"
    r"core\.hookspath)$")
ASSIGN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=")
GIT_CONFIG_ENV = re.compile(r"^GIT_CONFIG", re.I)

GIT_BUILTINS = set("""
add am annotate apply archive bisect blame branch bugreport bundle cat-file check-attr check-ignore
check-mailmap check-ref-format checkout checkout-index cherry cherry-pick citool clean clone column
commit commit-graph commit-tree config count-objects credential credential-cache credential-store
describe diagnose diff diff-files diff-index diff-tree difftool fast-export fast-import fetch
fetch-pack filter-branch fmt-merge-msg for-each-ref for-each-repo format-patch fsck fsck-objects
fsmonitor--daemon gc get-tar-commit-id grep gui hash-object help hook http-backend http-fetch
http-push index-pack init init-db instaweb interpret-trailers log ls-files ls-remote ls-tree
mailinfo mailsplit maintenance merge merge-base merge-file merge-index merge-one-file merge-tree
mergetool mktag mktree multi-pack-index mv name-rev notes p4 pack-objects pack-redundant
pack-refs patch-id prune prune-packed pull push range-diff read-tree rebase receive-pack reflog
refs remote repack replace replay request-pull rerere reset restore rev-list rev-parse revert rm
send-email send-pack shortlog show show-branch show-index show-ref sparse-checkout stage stash
status stripspace submodule svn switch symbolic-ref tag unpack-file unpack-objects update-index
update-ref update-server-info upload-archive upload-pack var verify-commit verify-pack verify-tag
version whatchanged worktree write-tree backfill last-modified repo
""".split())


class Ctx(object):
    def __init__(self, mode, cwd, config, env=None):
        self.mode = mode
        self.cwd = cwd or os.getcwd()
        self.cfg = config
        self.env = dict(os.environ if env is None else env)
        self._alias_cache = {}


def deny(reason):
    return Decision(DENY, PREFIX + reason)


def ask(reason):
    return Decision(ASK, PREFIX + reason)


def unreadable(ctx, what):
    """A command the guard cannot read that mentions git."""
    if ctx.mode == "child":
        return deny("cannot tell what this command runs (%s) and it involves git; children may not run it. "
                    "Write the git command out plainly." % what)
    return ask("cannot tell what this command runs (%s) and it involves git. Write the git command out plainly." % what)


def mentions_git(*texts):
    return any(GIT_WORD.search(t or "") for t in texts)


def prog_name(text):
    """Normalised program name: basename, lower case, Windows suffix dropped."""
    t = text.replace("\\", "/").rstrip("/")
    base = t.rsplit("/", 1)[-1].lower()
    for suf in (".exe", ".cmd", ".bat", ".com", ".ps1"):
        if base.endswith(suf):
            base = base[: -len(suf)]
            break
    return base


def is_git_name(name):
    return name == "git" or (name.startswith("git-") and len(name) > 4)


def joined(words):
    return " ".join(w.text for w in words)


def analyze_text(text, flavor, ctx, depth):
    if depth > MAX_DEPTH:
        if mentions_git(text):
            return unreadable(ctx, "nested more than %d levels" % MAX_DEPTH)
        return OK
    try:
        lx = lex(text, flavor)
    except LexError as exc:
        if mentions_git(text):
            return unreadable(ctx, str(exc))
        return OK
    d = OK
    for sub in lx.subs:
        d = worst(d, analyze_text(sub, flavor, ctx, depth + 1))
    for seg in lx.segs:
        d = worst(d, analyze_segment(seg, flavor, ctx, depth))
    return d


def analyze_segment(seg, flavor, ctx, depth):
    words = seg.words
    envs = {}
    i = 0
    kw = KEYWORDS[flavor]
    while i < len(words):
        w = words[i]
        t = w.text if flavor == "bash" else w.text.lower()
        if not w.dynamic and t in kw:
            i += 1
            continue
        if not w.dynamic and t in HEADER_KEYWORDS and flavor != "cmd":
            return OK
        if flavor == "bash" and ASSIGN.match(w.text):
            name, _, val = w.text.partition("=")
            envs[name.rstrip("+")] = None if w.dynamic else val
            i += 1
            continue
        break
    rest = words[i:]
    if flavor == "powershell" and rest:
        rest, d = ps_assignment(rest, ctx)
        if d is not None:
            return d
    if flavor == "cmd" and rest and not rest[0].dynamic and rest[0].text.lower() in ("if", "for"):
        for k, w in enumerate(rest):
            if not w.dynamic and is_git_name(prog_name(w.text)):
                return run_command(rest[k:], seg, flavor, ctx, depth, envs)
        return OK
    return run_command(rest, seg, flavor, ctx, depth, envs)


def ps_assignment(words, ctx):
    """`$x = <command>` / `$env:NAME = value` in PowerShell: the command is what follows."""
    first = words[0]
    m = re.match(r"^\$([\w:]+)\s*([+\-*/]?=)?(.*)$", first.raw, re.S)
    if not m:
        return words, None
    target = m.group(1)
    if m.group(2):
        tail = m.group(3)
        rest = ([Word(tail, raw=tail)] if tail else []) + words[1:]
    elif len(words) > 1 and re.match(r"^[+\-*/]?=", words[1].raw):
        tail = re.sub(r"^[+\-*/]?=", "", words[1].text)
        rest = ([Word(tail)] if tail else []) + words[2:]
    else:
        return words, None
    if ctx.mode == "child" and re.match(r"(?i)^env:GIT_CONFIG", target):
        return rest, deny("children may not set git configuration through the environment ($%s)." % target)
    return rest, None


def strip_options(words, argful=(), flags_stop=None):
    """Skip leading options (and the values of `argful` ones); returns the rest."""
    i = 0
    while i < len(words):
        t = words[i].text
        if t == "--":
            return words[i + 1:]
        if not t.startswith("-") or t == "-" or words[i].dynamic:
            break
        if flags_stop and t in flags_stop:
            return None
        key = t.split("=", 1)[0]
        if key in argful and "=" not in t:
            i += 2
        else:
            i += 1
    return words[i:]


def run_command(words, seg, flavor, ctx, depth, envs, xargs_repl=None, via_xargs=False):
    if not words:
        return OK
    cmd = words[0]
    if cmd.dynamic or cmd.glob:
        # Read the arguments as if the program were git, under the child rules.
        probe = Ctx("child", ctx.cwd, ctx.cfg, ctx.env)
        probe._alias_cache = ctx._alias_cache
        guess = git_args(words[1:], seg, flavor, probe, depth, envs, via_xargs, xargs_repl, guessing=True)
        if guess.level > ALLOW or mentions_git(seg.raw(), *[w.text for w in words]):
            return unreadable(ctx, "the program name is computed")
        return OK
    name = prog_name(cmd.text)
    args = words[1:]
    d = OK

    if is_git_name(name):
        if name != "git":
            args = [Word(name[4:])] + args
        return git_args(args, seg, flavor, ctx, depth, envs, via_xargs, xargs_repl)

    if re.match(r"^([A-Za-z]:[\\/]|\\\\)", cmd.text):
        # `C:\Program Files\Git\cmd\git.exe push` split at the space.
        for k, w in enumerate(args):
            if not w.dynamic and re.search(r"[\\/]", w.text) and prog_name(w.text) == "git":
                d = worst(d, git_args(args[k + 1:], seg, flavor, ctx, depth, envs, via_xargs, xargs_repl))
                break

    if name in ("export", "declare", "typeset", "local", "readonly", "set", "setx") and ctx.mode == "child":
        for w in args:
            if GIT_CONFIG_ENV.match(w.text.lstrip("-")) or (name in ("set", "setx") and GIT_CONFIG_ENV.match(w.text)):
                return deny("children may not set git configuration through the environment (%s)." % w.text)

    if name == "busybox" and args:
        return run_command(args, seg, flavor, ctx, depth, envs, xargs_repl, via_xargs)
    if name in SHELLS:
        return worst(d, shell_call(args, seg, "bash", ctx, depth, envs))
    if name in PWSH:
        return worst(d, pwsh_call(args, seg, ctx, depth))
    if name == "cmd":
        for k, w in enumerate(args):
            if w.text.lower() in ("/c", "/k", "/r"):
                rest = args[k + 1:]
                if any(x.dynamic for x in rest):
                    return unreadable(ctx, "cmd /c with a computed command") if mentions_git(seg.raw()) else d
                return worst(d, analyze_text(" ".join(x.raw for x in rest), "cmd", ctx, depth + 1))
        return d
    if name == "eval" or name in ("invoke-expression", "iex"):
        rest = [w for w in args if w.text.lower() not in ("-command",)]
        if any(w.dynamic for w in rest):
            return unreadable(ctx, "%s of a computed string" % name) if mentions_git(seg.raw()) else d
        sub_flavor = "powershell" if name != "eval" else flavor
        return worst(d, analyze_text(joined(rest), sub_flavor, ctx, depth + 1))
    if name in ("start-process", "saps", "start") and flavor != "bash":
        return worst(d, start_process(args, seg, flavor, ctx, depth, envs))
    if name == "env":
        return worst(d, env_call(args, seg, flavor, ctx, depth, envs))
    if name == "xargs":
        return worst(d, xargs_call(args, seg, flavor, ctx, depth, envs))
    if name in ("find", "fd"):
        return worst(d, find_exec(args, seg, flavor, ctx, depth, envs))
    if name == "watch":
        rest = strip_options(args, argful=("-n", "--interval", "-d", "--differences", "-q", "--equexit"))
        if rest:
            if any(w.dynamic for w in rest):
                return unreadable(ctx, "watch of a computed command") if mentions_git(seg.raw()) else d
            return worst(d, analyze_text(joined(rest), "bash", ctx, depth + 1))
        return d
    wrappers = {
        "command": ((), ("-v", "-V")),
        "builtin": ((), None),
        "exec": (("-a",), None),
        "nohup": ((), None),
        "time": (("-f", "--format", "-o", "--output"), None),
        "nice": (("-n", "--adjustment"), None),
        "ionice": (("-c", "--class", "-n", "--classdata", "-t"), None),
        "setsid": ((), None),
        "stdbuf": (("-i", "-o", "-e", "--input", "--output", "--error"), None),
        "sudo": (("-u", "--user", "-g", "--group", "-C", "--close-from", "-D", "--chdir", "-h", "--host",
                  "-p", "--prompt", "-r", "--role", "-t", "--type", "-U", "--other-user", "-T",
                  "--command-timeout"), ("-l", "--list", "-v", "--validate", "-k", "-K", "-e", "--edit")),
        "doas": (("-u", "-C"), None),
        "caffeinate": (("-w", "-t"), None),
        "unbuffer": ((), None),
        "chronic": ((), None),
        "timeout": (("-k", "--kill-after", "-s", "--signal"), None),
        "flock": (("-w", "--timeout", "-E", "--conflict-exit-code"), None),
    }
    if name in wrappers:
        argful, stops = wrappers[name]
        rest = strip_options(args, argful=argful, flags_stop=stops)
        if rest is None:
            return d
        if name == "timeout" and rest:
            rest = rest[1:]
        if name == "flock":
            fl = [w.text for w in args]
            for flag in ("-c", "--command"):
                if flag in fl and fl.index(flag) + 1 < len(args):
                    return worst(d, analyze_text(args[fl.index(flag) + 1].text, "bash", ctx, depth + 1))
            rest = rest[1:] if rest else rest
        return worst(d, run_command(rest, seg, flavor, ctx, depth, envs, xargs_repl, via_xargs))
    if name in INTERPRETERS:
        inline = any(w.text.lower() in INLINE_FLAGS for w in args) or (name == "osascript")
        if inline and mentions_git(seg.raw(), *[w.text for w in args]):
            return unreadable(ctx, "inline %s code" % name)
        return d
    return d


def shell_call(args, seg, flavor, ctx, depth, envs):
    i = 0
    code = None
    while i < len(args):
        w = args[i]
        t = w.text
        if w.dynamic and t.startswith("-"):
            return unreadable(ctx, "shell options are computed") if mentions_git(seg.raw()) else OK
        if t == "--" or t == "-":
            i += 1
            break
        if t.startswith("--"):
            i += 2 if t in ("--rcfile", "--init-file") else 1
            continue
        if (t.startswith("-") or t.startswith("+")) and len(t) > 1:
            if "c" in t[1:]:
                code = True
            if t[1:] in ("o", "O") or t in ("-o", "+o", "-O", "+O"):
                i += 1
            i += 1
            continue
        break
    pos = args[i:]
    if code:
        if not pos:
            return OK
        if pos[0].dynamic:
            return unreadable(ctx, "shell -c of a computed string") if mentions_git(seg.raw()) else OK
        return analyze_text(pos[0].text, flavor, ctx, depth + 1)
    if pos:
        return OK  # a script file: not readable from the command line
    return stdin_script(seg, flavor, ctx, depth)


def stdin_script(seg, flavor, ctx, depth):
    d = OK
    for body in seg.heredocs:
        d = worst(d, analyze_text(body, flavor, ctx, depth + 1))
    for w in seg.herestrings:
        if w.dynamic:
            d = worst(d, unreadable(ctx, "a shell reads a computed string") if mentions_git(w.raw) else OK)
        else:
            d = worst(d, analyze_text(w.text, flavor, ctx, depth + 1))
    if seg.pipe_in:
        # `... | bash`: the script comes from an earlier pipeline stage.
        d = worst(d, Decision(DENY if ctx.mode == "child" else ASK, PREFIX +
                              "a shell reads its script from a pipe; the guard cannot read it. "
                              "Run the commands directly."))
    return d


def pwsh_call(args, seg, ctx, depth):
    i = 0
    argful = {"-file", "-f", "-executionpolicy", "-ex", "-ep", "-workingdirectory", "-wd", "-windowstyle", "-w",
              "-outputformat", "-o", "-of", "-inputformat", "-if", "-in", "-configurationname", "-config",
              "-version", "-v", "-psconsolefile", "-custompipename", "-settingsfile", "-configurationfile",
              "-encodedarguments", "-ea", "-encodedargument"}
    while i < len(args):
        w = args[i]
        t = w.text.lower()
        if t.startswith("/"):
            t = "-" + t[1:]
        if w.dynamic and t.startswith("-"):
            return unreadable(ctx, "PowerShell options are computed") if mentions_git(seg.raw()) else OK
        if not t.startswith("-") or t == "-":
            break
        key = t.split(":", 1)[0]
        if key in ("-e", "-ec") or (len(key) >= 4 and "-encodedcommand".startswith(key)):
            return unreadable(ctx, "PowerShell -EncodedCommand") if True else OK
        if key == "-c" or (len(key) >= 3 and "-command".startswith(key)):
            rest = args[i + 1:]
            if rest and rest[0].text == "-":
                return stdin_script(seg, "powershell", ctx, depth)
            if any(x.dynamic for x in rest):
                return unreadable(ctx, "PowerShell -Command with a computed string") if mentions_git(seg.raw()) else OK
            return analyze_text(joined(rest), "powershell", ctx, depth + 1)
        if key in ("-file", "-f") or (len(key) >= 3 and "-file".startswith(key)):
            return OK
        i += 2 if key in argful else 1
    rest = args[i:]
    if rest:
        if any(x.dynamic for x in rest):
            return unreadable(ctx, "PowerShell with a computed command") if mentions_git(seg.raw()) else OK
        return analyze_text(joined(rest), "powershell", ctx, depth + 1)
    return stdin_script(seg, "powershell", ctx, depth)


def start_process(args, seg, flavor, ctx, depth, envs):
    prog = None
    arglist = []
    i = 0
    positional = []
    while i < len(args):
        w = args[i]
        t = w.text.lower()
        if t in ("-filepath", "-file", "-path") and i + 1 < len(args):
            prog = args[i + 1]
            i += 2
            continue
        if t in ("-argumentlist", "-args", "-arguments") and i + 1 < len(args):
            arglist.append(args[i + 1])
            i += 2
            continue
        if t.startswith("-") or (t.startswith("/") and flavor == "cmd"):
            i += 2 if t in ("-workingdirectory", "-verb", "-windowstyle", "-redirectstandardoutput",
                            "-redirectstandarderror", "-redirectstandardinput", "-credential", "/d") else 1
            continue
        positional.append(w)
        i += 1
    if flavor == "cmd" and positional and args and args[0].raw.startswith('"'):
        positional = positional[1:]  # start "title" program ...
    if prog is None and positional:
        prog, positional = positional[0], positional[1:]
    if prog is None:
        return OK
    arglist.extend(positional)
    words = [prog]
    for a in arglist:
        if a.dynamic:
            words.append(a)
        else:
            words.extend(Word(p) for p in re.split(r"[,\s]+", a.text) if p)
    return run_command(words, seg, flavor, ctx, depth, envs)


def env_call(args, seg, flavor, ctx, depth, envs):
    envs = dict(envs)
    i = 0
    while i < len(args):
        w = args[i]
        t = w.text
        if t in ("-S", "--split-string") or t.startswith("--split-string=") or (t.startswith("-S") and len(t) > 2):
            if t in ("-S", "--split-string"):
                s_arg = args[i + 1] if i + 1 < len(args) else Word("")
                i += 2
            else:
                s_arg = Word(t.split("=", 1)[1] if t.startswith("--") else t[2:], w.dynamic)
                i += 1
            if s_arg.dynamic:
                return unreadable(ctx, "env -S with a computed string") if mentions_git(seg.raw()) else OK
            text = s_arg.text + " " + " ".join(x.raw for x in args[i:])
            return analyze_text(text, flavor, ctx, depth + 1)
        if t == "--":
            i += 1
            break
        if t in ("-u", "--unset", "-C", "--chdir", "-P"):
            i += 2
            continue
        if t.startswith("-") and len(t) > 1 and not w.dynamic:
            i += 1
            continue
        if ASSIGN.match(t):
            name, _, val = t.partition("=")
            envs[name] = None if w.dynamic else val
            i += 1
            continue
        break
    while i < len(args) and ASSIGN.match(args[i].text):
        name, _, val = args[i].text.partition("=")
        envs[name] = None if args[i].dynamic else val
        i += 1
    return run_command(args[i:], seg, flavor, ctx, depth, envs)


def xargs_call(args, seg, flavor, ctx, depth, envs):
    argful = {"-I", "-L", "-n", "-P", "-d", "-E", "-s", "-a", "--arg-file", "--delimiter", "--max-args",
              "--max-procs", "--replace", "--max-lines", "--max-chars", "--eof", "--process-slot-var"}
    repl = None
    i = 0
    while i < len(args):
        t = args[i].text
        if t == "--":
            i += 1
            break
        if not t.startswith("-") or t == "-":
            break
        key = t.split("=", 1)[0]
        if key in ("-I", "--replace"):
            if "=" in t:
                repl = t.split("=", 1)[1]
            elif i + 1 < len(args):
                repl = args[i + 1].text
            i += 1 if "=" in t else 2
            continue
        if t.startswith("-I") and len(t) > 2:
            repl = t[2:]
        elif t.startswith("-i"):
            repl = t[2:] or "{}"
        if key in argful and "=" not in t and len(t) == len(key):
            i += 2
        else:
            i += 1
    rest = args[i:]
    if not rest:
        return OK  # xargs runs echo
    return run_command(rest, seg, flavor, ctx, depth, envs, xargs_repl=repl or "{}", via_xargs=True)


def find_exec(args, seg, flavor, ctx, depth, envs):
    d = OK
    i = 0
    while i < len(args):
        t = args[i].text
        if t in ("-exec", "-execdir", "-ok", "-okdir", "-x", "--exec", "-X", "--exec-batch"):
            j = i + 1
            while j < len(args) and args[j].text not in (";", "+", "\\;"):
                j += 1
            d = worst(d, run_command(args[i + 1:j], seg, flavor, ctx, depth, envs, xargs_repl="{}", via_xargs=True))
            i = j + 1
            continue
        i += 1
    return d


# ------------------------------------------------------------------ git itself

GIT_FLAGS = {"-p", "--paginate", "-P", "--no-pager", "--bare", "--no-replace-objects", "--literal-pathspecs",
             "--glob-pathspecs", "--noglob-pathspecs", "--icase-pathspecs", "--no-optional-locks",
             "--no-lazy-fetch", "--no-advice", "--exec-path", "--html-path", "--man-path", "--info-path",
             "--super-prefix"}
GIT_ARGFUL = {"-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--super-prefix",
              "--attr-source", "--list-cmds", "--exec-path"}
GIT_INFO = {"--version", "-v", "--help", "-h"}


class GitCall(object):
    """A parsed `git [global options] <sub> <args>`."""

    def __init__(self, ctx):
        self.cwd = ctx.cwd
        self.passthrough = []      # global options re-used for read-only lookups
        self.cfg_aliases = {}      # -c alias.x=... (value None = unknown)


def git_args(args, seg, flavor, ctx, depth, envs, via_xargs=False, xargs_repl=None, guessing=False, call=None, hops=0):
    if ctx.mode == "child" and not guessing:
        for k in envs:
            if GIT_CONFIG_ENV.match(k):
                return deny("children may not inject git configuration through the environment (%s)." % k)
    call = call or GitCall(ctx)
    i = 0
    while i < len(args):
        w = args[i]
        t = w.text
        if w.dynamic:
            if t.startswith("-") or i == 0 or not t.replace("\0", ""):
                return unreadable(ctx, "a git option or subcommand is computed")
            break
        if not t.startswith("-"):
            break
        if t in GIT_INFO:
            return OK
        key, eq, val = t.partition("=")
        if key in GIT_ARGFUL and (eq or key in ("-C", "-c") or key not in ("--exec-path", "--super-prefix")):
            if not eq:
                if i + 1 >= len(args):
                    return OK
                vw = args[i + 1]
                val = vw.text
                if vw.dynamic and key in ("-c", "--config-env"):
                    return unreadable(ctx, "git %s with a computed value" % key)
                i += 2
            else:
                i += 1
            if key == "-C":
                call.cwd = os.path.join(call.cwd, val)
            elif key in ("--git-dir", "--work-tree"):
                call.passthrough.append("%s=%s" % (key, os.path.join(call.cwd, val)))
            elif key == "-c":
                d = git_config_override(val, call, ctx, depth)
                if d.level > ALLOW:
                    return d
            elif key == "--config-env":
                ck = val.split("=", 1)[0].lower()
                if ck.startswith("alias.") or EXEC_KEY.match(ck):
                    if ctx.mode == "child":
                        return deny("children may not set %s through --config-env." % ck)
                    if ck.startswith("alias."):
                        call.cfg_aliases[ck[6:]] = None
            continue
        if t in GIT_FLAGS:
            i += 1
            continue
        return unreadable(ctx, "unknown git option %s" % t)
    if i >= len(args):
        if via_xargs:
            return unreadable(ctx, "git subcommand comes from xargs input")
        return OK
    sub_w = args[i]
    if sub_w.dynamic or (xargs_repl and xargs_repl in sub_w.text):
        return unreadable(ctx, "the git subcommand is computed")
    rest = args[i + 1:]
    return git_sub(sub_w.text, rest, seg, flavor, ctx, depth, envs, via_xargs, xargs_repl, call, hops)


def git_config_override(kv, call, ctx, depth):
    key, _, val = kv.partition("=")
    k = key.lower()
    if k.startswith("alias."):
        if ctx.mode == "child":
            return deny("children may not define git aliases (-c %s)." % key)
        call.cfg_aliases[k[6:]] = val
        return OK
    if EXEC_KEY.match(k) and ctx.mode == "child":
        if k == "core.hookspath":
            return deny("children may not point git at another hooks directory (-c %s)." % key)
        return analyze_text(val.lstrip("!"), "bash", ctx, depth + 1)
    return OK


def load_aliases(call, ctx, envs):
    env_key = tuple(sorted((k, v) for k, v in envs.items() if k.upper().startswith("GIT_") and v is not None))
    key = (call.cwd, tuple(call.passthrough), env_key)
    if key in ctx._alias_cache:
        return ctx._alias_cache[key]
    out = run_git(call, ctx, ["config", "-z", "--get-regexp", r"^alias\."], envs)
    aliases = {}
    if out:
        for rec in out.split("\0"):
            if not rec:
                continue
            k, _, v = rec.partition("\n")
            if k.lower().startswith("alias."):
                aliases[k[6:].lower()] = v
    ctx._alias_cache[key] = aliases
    return aliases


def run_git(call, ctx, argv, envs=None, binary=False, timeout=GIT_TIMEOUT):
    exe = shutil.which("git", path=ctx.env.get("PATH"))
    if not exe:
        return None
    env = dict(ctx.env)
    for k, v in (envs or {}).items():
        if k.upper().startswith("GIT_") and v is not None:
            env[k] = v
    env["GIT_OPTIONAL_LOCKS"] = "0"
    env["GIT_TERMINAL_PROMPT"] = "0"
    env.pop("GIT_EXTERNAL_DIFF", None)
    cwd = call.cwd if os.path.isdir(call.cwd) else ctx.cwd
    try:
        r = subprocess.run([exe] + call.passthrough + argv, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except (OSError, subprocess.SubprocessError):
        return None
    if r.returncode != 0:
        return None
    return r.stdout if binary else r.stdout.decode("utf-8", "replace")


def resolve_long(key, known):
    if key in known:
        return [key]
    cands = [k for k in known if k.startswith(key)] if len(key) >= 2 else []
    return cands or [key]


def parse_opts(words, short_arg="", known=(), long_arg=()):
    """git-style option parse (options may follow positionals; `--` ends them;
    unique-prefix abbreviations of long options resolve, ambiguous ones yield every
    candidate). Returns (opts [(name, Word|None)], positionals, after_dashdash, dynamic words)."""
    opts, pos, dd, dyn = [], [], [], []
    i = 0
    while i < len(words):
        w = words[i]
        t = w.text
        if w.dynamic:
            dyn.append(w)
            pos.append(w)
            i += 1
            continue
        if t == "--":
            dd = words[i + 1:]
            break
        if t.startswith("--") and len(t) > 2:
            key, eq, val = t[2:].partition("=")
            names = resolve_long(key, known)
            value = None
            if eq:
                value = Word(val)
            elif any(nm in long_arg for nm in names) and i + 1 < len(words):
                value = words[i + 1]
                i += 1
            for nm in names:
                opts.append((nm, value))
            i += 1
            continue
        if t.startswith("-") and len(t) > 1:
            j = 1
            while j < len(t):
                ch = t[j]
                if ch in short_arg:
                    v = t[j + 1:]
                    if v:
                        value = Word(v)
                    elif i + 1 < len(words):
                        value = words[i + 1]
                        i += 1
                    else:
                        value = None
                    opts.append((ch, value))
                    break
                opts.append((ch, None))
                j += 1
            i += 1
            continue
        pos.append(w)
        i += 1
    return opts, pos, dd, dyn


def has(opts, *names):
    return any(n in names for n, _ in opts)


def values(opts, *names):
    return [v for n, v in opts if n in names]


RISKY_DYNAMIC = {"reset", "checkout", "switch", "clean", "stash", "branch", "worktree", "update-ref", "reflog",
                 "gc", "prune", "config", "submodule", "rebase", "bisect"}


def git_sub(sub, rest, seg, flavor, ctx, depth, envs, via_xargs, xargs_repl, call, hops):
    s = sub.lower() if ctx.mode == "child" else sub
    if s not in GIT_BUILTINS and sub.lower() not in GIT_BUILTINS:
        aliases = dict(load_aliases(call, ctx, envs))
        aliases.update(call.cfg_aliases)
        a = sub.lower()
        if a in aliases:
            value = aliases[a]
            if value is None:
                return unreadable(ctx, "git alias %s is set from the environment" % sub)
            if hops >= MAX_ALIAS_HOPS:
                return unreadable(ctx, "git alias %s expands too deeply" % sub)
            if value.startswith("!"):
                if ctx.mode == "child":
                    return deny("children may not run git alias %s: it runs a shell command (%s)." % (sub, value[:120]))
                text = value[1:] + "".join(" " + w.raw for w in rest)
                return analyze_text(text, "bash", ctx, depth + 1)
            try:
                lx = lex(value, "bash")
            except LexError:
                return unreadable(ctx, "git alias %s cannot be read" % sub)
            expansion = [w for sg in lx.segs for w in sg.words]
            d = git_args(expansion + list(rest), seg, flavor, ctx, depth, envs, via_xargs, xargs_repl, call=call, hops=hops + 1)
            if d.level > ALLOW and "alias" not in d.reason:
                d = Decision(d.level, d.reason + " (through git alias %s = %s)" % (sub, value[:120]))
            return d
        return OK
    if s in ("submodule", "rebase", "bisect"):
        d = nested_commands(s, rest, seg, flavor, ctx, depth, envs)
        if d.level > ALLOW:
            return d
    if ctx.mode == "child":
        return child_rules(s, rest, ctx, call)
    if via_xargs and sub in ("commit", "push"):
        return ask("git %s gets arguments from xargs input; the guard cannot check them." % sub)
    if sub == "commit":
        return commit_lint(rest, ctx, call, envs)
    if sub == "push":
        return push_lint(rest, ctx, call, envs)
    return OK


def nested_commands(s, rest, seg, flavor, ctx, depth, envs):
    if s == "submodule":
        texts = [w.text for w in rest]
        if "foreach" in texts:
            after = rest[texts.index("foreach") + 1:]
            after = [w for w in after if w.text not in ("--recursive", "-q", "--quiet")]
            if any(w.dynamic for w in after):
                return unreadable(ctx, "git submodule foreach with a computed command")
            return analyze_text(joined(after), "bash", ctx, depth + 1)
        return OK
    if s == "rebase":
        opts, _, _, _ = parse_opts(rest, short_arg="xsXCS", known=("exec", "onto", "strategy", "strategy-option"),
                                   long_arg=("exec", "onto", "strategy", "strategy-option"))
        d = OK
        for v in values(opts, "x", "exec"):
            if v is None:
                continue
            if v.dynamic:
                return unreadable(ctx, "git rebase --exec with a computed command")
            d = worst(d, analyze_text(v.text, "bash", ctx, depth + 1))
        return d
    if s == "bisect":
        texts = [w.text for w in rest]
        if texts[:1] == ["run"]:
            return run_command(rest[1:], seg, flavor, ctx, depth, envs)
    return OK


# ------------------------------------------------------------------ child rules

def child_rules(s, rest, ctx, call):
    def no(what):
        return deny("children may not run `git %s` (%s). Report back and let the foreman do it." % (what, CHILD_WHY.get(s, "it can destroy work")))

    if s in ("push", "send-pack", "http-push"):
        return no(s)
    if s == "restore":
        return no("restore")
    dynamic = any(w.dynamic for w in rest)
    if dynamic and s in RISKY_DYNAMIC:
        return deny("children may not run `git %s` with computed arguments; write them out." % s)
    if s == "reset":
        opts, _, _, _ = parse_opts(rest, known=("hard", "soft", "mixed", "merge", "keep", "quiet", "patch",
                                                 "pathspec-from-file"), long_arg=("pathspec-from-file",))
        if has(opts, "hard"):
            return no("reset --hard")
        return OK
    if s == "checkout":
        opts, pos, dd, _ = parse_opts(rest, short_arg="bB", known=(
            "force", "quiet", "progress", "ours", "theirs", "track", "no-track", "guess", "overwrite-ignore",
            "merge", "conflict", "patch", "orphan", "detach", "ignore-skip-worktree-bits", "pathspec-from-file",
            "overlay", "no-overlay", "recurse-submodules", "ignore-other-worktrees"),
            long_arg=("orphan", "pathspec-from-file"))
        if has(opts, "f", "force"):
            return no("checkout --force")
        if dd:
            return no("checkout -- <path>")
        if has(opts, "pathspec-from-file"):
            return no("checkout --pathspec-from-file")
        creating = has(opts, "b", "B", "orphan")
        for w in pos:
            t = w.text
            if t == "." or t.startswith(":") or w.glob or t.endswith("/"):
                return no("checkout %s" % t)
        if len(pos) >= 2 and not creating:
            return no("checkout <tree-ish> <path>")
        if len(pos) == 1 and not creating and os.path.lexists(os.path.join(call.cwd, pos[0].text)):
            return no("checkout %s (a path: this discards its changes)" % pos[0].text)
        return OK
    if s == "switch":
        opts, _, _, _ = parse_opts(rest, short_arg="cC", known=(
            "create", "force-create", "detach", "guess", "discard-changes", "force", "merge", "conflict", "quiet",
            "progress", "track", "orphan", "ignore-other-worktrees", "recurse-submodules"),
            long_arg=("create", "force-create", "orphan"))
        if has(opts, "f", "force", "discard-changes"):
            return no("switch --force/--discard-changes")
        return OK
    if s == "clean":
        opts, _, _, _ = parse_opts(rest, short_arg="e", known=("force", "dry-run", "quiet", "exclude", "interactive"),
                                   long_arg=("exclude",))
        if has(opts, "n", "dry-run"):
            return OK
        return no("clean" + (" -f" if has(opts, "f", "force") else ""))
    if s == "stash":
        sub = rest[0].text if rest else ""
        if sub in ("drop", "clear"):
            return no("stash " + sub)
        return OK
    if s == "branch":
        opts, _, _, _ = parse_opts(rest, short_arg="u", known=(
            "delete", "force", "move", "copy", "list", "all", "remotes", "verbose", "quiet", "track", "no-track",
            "set-upstream-to", "unset-upstream", "contains", "no-contains", "merged", "no-merged", "points-at",
            "sort", "format", "column", "no-column", "edit-description", "show-current", "create-reflog",
            "recurse-submodules", "ignore-case", "omit-empty", "abbrev", "no-abbrev", "color", "no-color"),
            long_arg=("set-upstream-to", "contains", "no-contains", "merged", "no-merged", "points-at", "sort",
                      "format"))
        if has(opts, "D") or (has(opts, "d", "delete") and has(opts, "f", "force")):
            return no("branch -D")
        return OK
    if s == "worktree":
        sub = rest[0].text if rest else ""
        if sub == "remove":
            opts, _, _, _ = parse_opts(rest[1:], known=("force",))
            if has(opts, "f", "force"):
                return no("worktree remove --force")
        return OK
    if s == "update-ref":
        opts, _, _, _ = parse_opts(rest, short_arg="m", known=("stdin", "no-deref", "create-reflog", "message"),
                                   long_arg=("message",))
        if has(opts, "d"):
            return no("update-ref -d")
        if has(opts, "stdin"):
            return no("update-ref --stdin")
        return OK
    if s == "reflog":
        sub = rest[0].text if rest else ""
        if sub in ("expire", "delete"):
            return no("reflog " + sub)
        return OK
    if s == "gc":
        opts, _, _, _ = parse_opts(rest, known=("prune", "no-prune", "aggressive", "auto", "quiet", "force",
                                                 "keep-largest-pack", "cruft", "max-cruft-size", "detach"))
        for v in values(opts, "prune"):
            if v is not None and (v.dynamic or v.text.lower() in ("now", "all")):
                return no("gc --prune=%s" % v.text)
        return OK
    if s == "prune":
        opts, _, _, _ = parse_opts(rest, known=("dry-run", "verbose", "progress", "expire"), long_arg=("expire",))
        if has(opts, "n", "dry-run"):
            return OK
        return no("prune")
    if s == "config":
        opts, pos, _, _ = parse_opts(rest, short_arg="f", known=(
            "get", "get-all", "get-regexp", "get-urlmatch", "list", "add", "replace-all", "unset", "unset-all",
            "rename-section", "remove-section", "edit", "file", "blob", "global", "system", "local", "worktree",
            "type", "default", "show-origin", "show-scope", "name-only", "null", "includes", "no-includes",
            "comment", "value", "fixed-value", "all", "regexp", "url", "get-color", "get-colorbool", "bool", "int",
            "bool-or-int", "path", "expiry-date"),
            long_arg=("file", "blob", "type", "default", "comment", "value", "url"))
        words = [w.text for w in pos]
        if has(opts, "e", "edit") or words[:1] == ["edit"]:
            return no("config --edit")
        reading = has(opts, "get", "get-all", "get-regexp", "get-urlmatch", "list", "l", "get-color",
                      "get-colorbool") or words[:1] in (["get"], ["list"])
        if not reading and len(words) == 1 and not has(opts, "unset", "unset-all", "remove-section"):
            reading = True  # `git config <key>` reads
        if reading:
            return OK
        for t in words:
            k = t.lower()
            if k == "alias" or k.startswith("alias."):
                return no("config %s" % t)
            if EXEC_KEY.match(k):
                return no("config %s" % t)
        return OK
    return OK


CHILD_WHY = {
    "push": "only the foreman publishes",
    "send-pack": "only the foreman publishes",
    "http-push": "only the foreman publishes",
    "reset": "it discards uncommitted work",
    "checkout": "it discards uncommitted changes",
    "switch": "it discards uncommitted changes",
    "restore": "it discards uncommitted changes",
    "clean": "it deletes untracked files",
    "stash": "it deletes stashed work",
    "branch": "it deletes an unmerged branch",
    "worktree": "it deletes a worktree with changes",
    "update-ref": "it deletes or rewrites refs",
    "reflog": "it removes the recovery log",
    "gc": "it removes the objects needed for recovery",
    "prune": "it removes the objects needed for recovery",
    "config": "it would change what git runs",
}


# ------------------------------------------------------------------ main: commit

COMMIT_KNOWN = (
    "message", "file", "reuse-message", "reedit-message", "fixup", "squash", "template", "author", "date",
    "cleanup", "trailer", "pathspec-from-file", "pathspec-file-nul", "gpg-sign", "no-gpg-sign",
    "untracked-files", "all", "include", "only", "patch", "interactive", "amend", "no-edit", "edit",
    "allow-empty", "allow-empty-message", "signoff", "no-signoff", "no-verify", "verify", "dry-run", "short",
    "branch", "porcelain", "long", "null", "quiet", "verbose", "status", "no-status", "reset-author",
    "no-post-rewrite", "ahead-behind", "no-ahead-behind")
COMMIT_ARG = ("message", "file", "reuse-message", "reedit-message", "fixup", "squash", "template", "author",
              "date", "cleanup", "trailer", "pathspec-from-file")
TRAILER_LINE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9-]*\s*:\s")


def commit_lint(rest, ctx, call, envs):
    opts, pos, dd, dyn = parse_opts(rest, short_arg="mFCct", known=COMMIT_KNOWN, long_arg=COMMIT_ARG)
    if has(opts, "dry-run"):
        return OK
    if has(opts, "a", "all"):
        return deny("commit -a/--all is not allowed: stage the files with `git add <paths>`, then commit.")
    if has(opts, "i", "include", "o", "only", "pathspec-from-file") or [w for w in pos if not w.dynamic] or dd:
        return deny("commit with pathspecs (or --include/--only) is not allowed: stage with `git add <paths>`, "
                    "then run `git commit` without paths.")
    if dyn:
        return ask("the commit has computed arguments; %s." % USE_M)
    if has(opts, "C", "c", "reuse-message", "reedit-message", "fixup", "squash", "t", "template"):
        return ask("the commit message is taken from elsewhere; %s." % USE_M)
    parts = []
    for name, v in opts:
        if name in ("m", "message"):
            if v is None:
                return OK  # git fails: -m needs a value
            if v.dynamic:
                return ask("the commit message is computed; %s." % USE_M)
            parts.append(v.text)
        elif name in ("F", "file"):
            if v is None:
                return OK
            if v.dynamic or v.text == "-":
                return ask("the commit message is read from %s; %s." % ("stdin" if v.text == "-" else "a computed path", USE_M))
            path = os.path.join(call.cwd, v.text)
            try:
                with open(path, "rb") as fh:
                    parts.append(fh.read(1 << 20).decode("utf-8", "replace"))
            except OSError:
                return ask("cannot read the message file %s; %s." % (v.text, USE_M))
    if not parts:
        return ask("the commit message is not on the command line (editor or --amend reuse); %s." % USE_M)
    message = "\n\n".join(p.strip("\n") for p in parts)
    trailers = trailer_lines(message)
    for v in values(opts, "trailer"):
        if v is not None:
            if v.dynamic:
                return ask("a --trailer value is computed; write it out.")
            m = re.match(r"^([^:=]+)[:=](.*)$", v.text, re.S)
            trailers.append("%s: %s" % (m.group(1).strip(), m.group(2).strip()) if m else v.text)
    if has(opts, "s", "signoff"):
        trailers.append("Signed-off-by: (committer)")
    cc = ctx.cfg.get("commit") or {}
    pattern = cc.get("messagePattern")
    subject = next((ln.strip() for ln in message.splitlines() if ln.strip()), "")
    if isinstance(pattern, str) and pattern:
        try:
            ok = re.search(pattern, subject) is not None
        except re.error as exc:
            return deny("safety.git.commit.messagePattern is not a valid regular expression (%s)." % exc)
        if not ok:
            return deny("commit subject %r does not match safety.git.commit.messagePattern %s." % (subject[:120], pattern))
    for req in cc.get("requiredTrailers") or []:
        try:
            if not any(re.search(req, t) for t in trailers):
                return deny("commit message lacks a trailer matching %r (safety.git.commit.requiredTrailers)." % req)
        except re.error as exc:
            return deny("invalid requiredTrailers entry %r (%s)." % (req, exc))
    for bad in cc.get("forbiddenTrailers") or []:
        try:
            hit = next((t for t in trailers if re.search(bad, t)), None)
        except re.error as exc:
            return deny("invalid forbiddenTrailers entry %r (%s)." % (bad, exc))
        if hit:
            return deny("commit trailer %r is not allowed (safety.git.commit.forbiddenTrailers: %r)." % (hit[:120], bad))
    check = cc.get("checkCommand")
    if isinstance(check, list) and check and all(isinstance(x, str) for x in check):
        return run_check(check, message, ctx, call, envs)
    return OK


def trailer_lines(message):
    paras = [p for p in re.split(r"\n[ \t]*\n", message.strip("\n")) if p.strip()]
    if len(paras) < 2:
        return []
    lines = [ln for ln in paras[-1].splitlines() if ln.strip()]
    if lines and all(TRAILER_LINE.match(ln) or ln[:1] in " \t" for ln in lines):
        return [ln.strip() for ln in lines if TRAILER_LINE.match(ln)]
    return []


def run_check(argv, message, ctx, call, envs):
    diff = run_git(call, ctx, ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--no-color"], envs,
                   binary=True)
    if diff is None:
        diff = b""
    exe = shutil.which(argv[0], path=ctx.env.get("PATH")) or argv[0]
    if not os.path.isabs(exe) and (os.sep in argv[0] or "/" in argv[0]):
        exe = os.path.join(call.cwd, argv[0])
    env = dict(ctx.env)
    env["PI_FOREMAN_COMMIT_MESSAGE"] = message
    cwd = call.cwd if os.path.isdir(call.cwd) else ctx.cwd
    try:
        r = subprocess.run([exe] + argv[1:], input=diff, cwd=cwd, env=env, stdout=subprocess.PIPE,
                           stderr=subprocess.PIPE, timeout=CHECK_TIMEOUT,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except subprocess.TimeoutExpired:
        return deny("safety.git.commit.checkCommand did not finish within %.0f s." % CHECK_TIMEOUT)
    except OSError as exc:
        return deny("safety.git.commit.checkCommand could not start (%s)." % exc)
    if r.returncode != 0:
        err = (r.stderr or r.stdout).decode("utf-8", "replace").strip()
        if len(err) > REASON_MAX:
            err = err[:REASON_MAX] + " ..."
        return deny("the commit check (safety.git.commit.checkCommand) failed (exit %d)%s" %
                    (r.returncode, ": " + err if err else "."))
    return OK


# ------------------------------------------------------------------ main: push

PUSH_KNOWN = ("all", "branches", "mirror", "delete", "tags", "follow-tags", "dry-run", "porcelain", "force",
              "force-with-lease", "force-if-includes", "repo", "set-upstream", "thin", "no-thin", "quiet",
              "verbose", "progress", "prune", "no-verify", "verify", "recurse-submodules", "atomic", "no-atomic",
              "push-option", "receive-pack", "exec", "ipv4", "ipv6", "signed", "no-signed", "no-force-with-lease",
              "no-force-if-includes")
PUSH_ARG = ("repo", "push-option", "receive-pack", "exec")


def push_lint(rest, ctx, call, envs):
    opts, pos, dd, dyn = parse_opts(rest, short_arg="o", known=PUSH_KNOWN, long_arg=PUSH_ARG)
    pos = pos + list(dd)
    if has(opts, "n", "dry-run"):
        return OK
    protected = [p for p in (ctx.cfg.get("protectedBranches") or []) if isinstance(p, str) and p]
    if not protected:
        return OK
    force = has(opts, "f", "force", "force-with-lease", "force-if-includes")
    delete = has(opts, "d", "delete")
    mirror = has(opts, "mirror")
    every = has(opts, "all", "branches")
    if mirror:
        return deny("push --mirror is not allowed while safety.git.protectedBranches is set (%s)." % ", ".join(protected))
    if dyn:
        if force or delete:
            return ask("forced or deleting push with a computed argument; the guard cannot tell the target branch.")
        return OK
    refspecs = pos[1:]
    targets = []  # (branch pattern, destructive)
    current = None
    if refspecs:
        for w in refspecs:
            r = w.text
            plus = r.startswith("+")
            r = r[1:] if plus else r
            if ":" in r:
                src, dst = r.split(":", 1)
                if not dst:
                    dst = src
            else:
                src = dst = r
            if src in ("HEAD", "@") and dst == src:
                current = current or current_branch(call, ctx, envs)
                dst = current or ""
            elif dst in ("HEAD", "@"):
                current = current or current_branch(call, ctx, envs)
                dst = current or ""
            targets.append((strip_ref(dst), plus or force or delete or src == ""))
    else:
        implicit = set()
        if every:
            implicit.add("*")
        if force or delete:
            current = current_branch(call, ctx, envs)
            if current:
                implicit.add(current)
                up = upstream_branch(call, ctx, envs, current)
                if up:
                    implicit.add(up)
            if not every and push_matching(call, ctx, envs):
                implicit.add("*")
        targets = [(t, force or delete) for t in implicit]
    for dst, destructive in targets:
        if not destructive or not dst:
            continue
        for p in protected:
            if fnmatch.fnmatchcase(dst, p) or ("*" in dst and fnmatch.fnmatchcase(p, dst)):
                kind = "delete" if (delete or dst == "") else "force push"
                return deny("%s to protected branch %s is not allowed (safety.git.protectedBranches)." %
                            (kind, p if "*" in dst else dst))
    return OK


def strip_ref(ref):
    for pre in ("refs/heads/",):
        if ref.startswith(pre):
            return ref[len(pre):]
    return ref


def current_branch(call, ctx, envs):
    out = run_git(call, ctx, ["symbolic-ref", "--quiet", "--short", "HEAD"], envs)
    return out.strip() if out else None


def upstream_branch(call, ctx, envs, branch):
    out = run_git(call, ctx, ["config", "--get", "branch.%s.merge" % branch], envs)
    return strip_ref(out.strip()) if out else None


def push_matching(call, ctx, envs):
    """push.default=matching or configured remote push refspecs push more than this branch."""
    mode = run_git(call, ctx, ["config", "--get", "push.default"], envs)
    if mode and mode.strip().lower() == "matching":
        return True
    return bool(run_git(call, ctx, ["config", "--get-regexp", r"^remote\..*\.push$"], envs))


# ===================================================================== entry

def merge_config(base, over):
    out = json.loads(json.dumps(base))
    if not isinstance(over, dict):
        return out
    if isinstance(over.get("safety"), dict):
        over = over["safety"].get("git") or {}
    for k, v in over.items():
        if k == "commit" and isinstance(v, dict):
            out["commit"].update(v)
        else:
            out[k] = v
    return out


def flavor_of(payload):
    sh = str(payload.get("shell") or "").lower()
    if sh in ("bash", "powershell", "cmd"):
        return sh
    if str(payload.get("tool_name") or "").lower() == "powershell":
        return "powershell"
    return "bash"


def decide(command, mode, cwd=None, config=None, flavor="bash", env=None):
    cfg = merge_config(DEFAULT_CONFIG, config or {})
    ctx = Ctx(mode, cwd, cfg, env)
    return analyze_text(command, flavor, ctx, 0)


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    mode = None
    cfg_file = None
    while argv:
        a = argv.pop(0)
        if a == "--mode" and argv:
            mode = argv.pop(0)
        elif a.startswith("--mode="):
            mode = a.split("=", 1)[1]
        elif a == "--config" and argv:
            cfg_file = argv.pop(0)
        elif a.startswith("--config="):
            cfg_file = a.split("=", 1)[1]
        else:
            raise GuardError("unknown argument %s" % a)
    if mode not in ("child", "main"):
        raise GuardError("--mode child|main is required")
    raw = sys.stdin.buffer.read().decode("utf-8")
    payload = json.loads(raw) if raw.strip() else {}
    if not isinstance(payload, dict):
        raise GuardError("payload is not a JSON object")
    tool = str(payload.get("tool_name") or "")
    if tool.lower() not in ("bash", "powershell"):
        return 0
    ti = payload.get("tool_input") or {}
    command = ti.get("command") if isinstance(ti, dict) else None
    if not isinstance(command, str) or not command.strip():
        return 0
    cfg = DEFAULT_CONFIG
    if cfg_file:
        with open(cfg_file, "r", encoding="utf-8") as fh:
            cfg = merge_config(cfg, json.load(fh))
    if isinstance(payload.get("foreman_git"), dict):
        cfg = merge_config(cfg, payload["foreman_git"])
    cwd = payload.get("cwd") if isinstance(payload.get("cwd"), str) and payload.get("cwd") else os.getcwd()
    ctx = Ctx(mode, cwd, cfg)
    d = analyze_text(command, flavor_of(payload), ctx, 0)
    if d.level == ALLOW:
        return 0
    out = {"hookSpecificOutput": {"hookEventName": "PreToolUse",
                                  "permissionDecision": "deny" if d.level == DENY else "ask",
                                  "permissionDecisionReason": d.reason}}
    sys.stdout.write(json.dumps(out) + "\n")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # noqa: BLE001 - any failure must reach the caller as a block
        sys.stderr.write("git_guard: internal error: %s: %s\n" % (type(exc).__name__, exc))
        sys.exit(2)
