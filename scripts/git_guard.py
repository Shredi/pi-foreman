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
         and push lint (no force, mirror or delete on protected branches; a push
         without refspecs is read through the target remote's configured
         remote.<r>.push / remote.<r>.mirror, inline `-c` values included).
         A command it cannot read that mentions git is an ask.

"Cannot read" includes a computed program word ($X, "$@", $(...), & $x, & (...))
in a command that names git anywhere, even only in an assignment or here-string.
Protected-branch names match case-insensitively on every platform.

The guard reads command strings only. It runs git read-only (`git config`,
`git symbolic-ref`, `git diff --cached`) and the configured check command.
It is not a sandbox: a script or build file can still call git.

Known limits (main mode): only `git commit` and `git push` are linted. `git merge`,
`git tag`, `git commit-tree` and `git send-pack` are not checked for message format
or protected-branch force updates (children may not run send-pack at all).
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
        self.callop = False  # PowerShell: the last token was the `&` or `.` call operator

    # ------------------------------------------------------------- word helpers
    def start(self, i):
        self.callop = False
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
        self.callop = False
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
            if f == "powershell" and c == "." and self.w is None and not self.cur.words and \
                    (i + 1 >= n or s[i + 1] in " \t"):
                # `. <command>` dot-sources; kept as the program word `.`.
                self.cur.words.append(Word("."))
                i += 1
                self.callop = True
                continue
            if f == "powershell" and c == "(" and self.callop and self.w is None:
                # `& (<expr>) args`: the program is computed.
                k = self.match_close(i, "(", ")")
                self.subs.append(s[i + 1:k])
                self.start(i)
                self.dyn()
                i = k + 1
                continue
            if c in ";&|":
                self.end_word(i)
                two = s[i:i + 2]
                if f == "powershell" and c == "&" and two != "&&":
                    self.end_seg(i)
                    i += 1
                    self.callop = True
                    continue
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
# Config a child may not write with `git config`: it changes where pushes go, pulls in other
# config files, or makes git run a program.
CHILD_CONFIG_DENY = re.compile(
    r"^((remote|push|include|includeif|credential)(\..*)?|branch\..+\.pushremote|"
    r"core\.(hookspath|fsmonitor|sshcommand)|diff\.external|.+\.textconv)$")
# The only config keys a child may write with `git config` (review T5: an allowlist, not a
# deny list; every other key, url.*.insteadOf, protocol.*.allow, remote.* and the program keys
# included, is denied). user.name / user.email: a child commits in its worktree and may need
# an identity; neither runs a program nor changes a push target. commit.gpgsign is left out:
# a child can pass `-c commit.gpgsign=false` per command, which persists nothing.
CHILD_CONFIG_ALLOW = frozenset(("user.name", "user.email"))
# `git remote` subcommands that change remotes (reads: -v, show, get-url, update, prune stay).
CHILD_REMOTE_DENY = frozenset(("add", "set-url", "rename", "remove", "rm", "set-head", "set-branches"))
# Config the main-mode push lint reads (inline `-c` values are passed to its `git config` reads).
PUSH_CONFIG = re.compile(r"^(remote\..+\.(push|mirror)|remote\.pushdefault|push\.default|"
                         r"branch\..+\.(pushremote|remote|merge))$")
# Environment variables whose value git runs as a command.
EXEC_ENV = {"GIT_EDITOR", "GIT_SEQUENCE_EDITOR", "GIT_PAGER", "GIT_SSH_COMMAND", "GIT_EXTERNAL_DIFF",
            "GIT_ASKPASS", "EDITOR", "VISUAL", "PAGER"}
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
        self.root = None    # (text, flavor) of the whole command
        self._stray = None
        self.pr_gate = None  # {enabled, reviewed_heads} from the adapter payload
        self.pr_segs = set()     # segments that carry a PR form
        self.state_segs = set()  # segments that change the directory, HEAD or a ref
        self.cfg_env = False     # the command sets GIT_CONFIG_* (export, $env:) before a later segment
        self.events = []         # child trace events of an allowed command ({"event": "test_restore", ...})


def stray_git(text, flavor, depth=0):
    """True when the command names git anywhere other than as a plainly written program
    word: in an assignment, an argument (`set -- git push`), a here-string or heredoc,
    a substitution. A computed program word in such a command may well be git."""
    if depth > MAX_DEPTH:
        return mentions_git(text)
    try:
        lx = lex(text, flavor)
    except LexError:
        return mentions_git(text)
    if any(stray_git(sub, flavor, depth + 1) for sub in lx.subs):
        return True
    kw = KEYWORDS[flavor]
    for seg in lx.segs:
        if any(mentions_git(w.text) for w in seg.herestrings) or mentions_git(*seg.heredocs):
            return True
        prog = None
        for k, w in enumerate(seg.words):
            t = w.text if flavor == "bash" else w.text.lower()
            if w.dynamic or not (t in kw or (flavor == "bash" and ASSIGN.match(w.text))):
                prog = k
                break
        for k, w in enumerate(seg.words):
            if k == prog and not w.dynamic and is_git_name(prog_name(w.text)):
                continue
            if mentions_git(w.text):
                return True
    return False


def involves_git(ctx, seg=None, *texts):
    """The segment (or the given texts) names git, or the whole command names git in a
    position other than a plain git program word."""
    if mentions_git(seg.raw() if seg is not None else "", *texts):
        return True
    if ctx._stray is None:
        ctx._stray = bool(ctx.root) and stray_git(ctx.root[0], ctx.root[1])
    return ctx._stray


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
    if ctx.root is None:
        ctx.root = (text, flavor)
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
    if depth == 0 and ctx.mode == "main" and ctx.pr_segs and ctx.state_segs - ctx.pr_segs and pr_gate_on(ctx):
        # B-M1/B-M2: the head is resolved before any segment runs; another segment may move it.
        return pr_refuse("pr_compound", "pull request in a compound command")
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
    if not rest and any(PR_CONFIG_ENV.match(k) for k in envs):
        ctx.cfg_env = True
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
    if re.match(r"(?i)^env:", target) and PR_CONFIG_ENV.match(target[4:]):
        ctx.cfg_env = True
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
        if guess.level > ALLOW or involves_git(ctx, seg, *[w.text for w in words]):
            return unreadable(ctx, "the program name is computed")
        return OK
    name = prog_name(cmd.text)
    args = words[1:]
    d = OK

    if is_git_name(name):
        if name != "git":
            args = [Word(name[4:])] + args
        return git_args(args, seg, flavor, ctx, depth, envs, via_xargs, xargs_repl)

    if name in CD_NAMES:
        ctx.state_segs.add(seg)

    if name in ("gh", "glab", "hub", "tea"):
        return pr_cli(name, args, ctx, seg)

    if re.match(r"^([A-Za-z]:[\\/]|\\\\)", cmd.text):
        # `C:\Program Files\Git\cmd\git.exe push` split at the space.
        for k, w in enumerate(args):
            if not w.dynamic and re.search(r"[\\/]", w.text) and prog_name(w.text) == "git":
                d = worst(d, git_args(args[k + 1:], seg, flavor, ctx, depth, envs, via_xargs, xargs_repl))
                break

    if name in ("export", "declare", "typeset", "local", "readonly", "set", "setx"):
        for w in args:
            if GIT_CONFIG_ENV.match(w.text.lstrip("-")) or (name in ("set", "setx") and GIT_CONFIG_ENV.match(w.text)):
                if ctx.mode == "child":
                    return deny("children may not set git configuration through the environment (%s)." % w.text)
                if PR_CONFIG_ENV.match(w.text.lstrip("-").split("=", 1)[0]):
                    ctx.cfg_env = True

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
                    return unreadable(ctx, "cmd /c with a computed command") if involves_git(ctx, seg) else d
                line = " ".join(x.raw for x in rest)
                if line.startswith('"') and line.count('"') >= 2:
                    # cmd /c "git push": cmd drops the first and the last quote.
                    e = line.rfind('"')
                    line = line[1:e] + line[e + 1:]
                return worst(d, analyze_text(line, "cmd", ctx, depth + 1))
        return d
    if name in (".", "source"):
        if flavor == "powershell" and args and not args[0].dynamic and is_git_name(prog_name(args[0].text)):
            return worst(d, run_command(args, seg, flavor, ctx, depth, envs))
        if args and involves_git(ctx, seg):
            return unreadable(ctx, "a sourced script")
        return d
    if name == "alias" and flavor == "bash" and any(mentions_git(w.text) for w in args):
        return unreadable(ctx, "a shell alias")
    if name in ("set-alias", "new-alias", "sal", "nal") and involves_git(ctx, seg):
        return unreadable(ctx, "a PowerShell alias")
    if name == "eval" or name in ("invoke-expression", "iex"):
        rest = [w for w in args if w.text.lower() not in ("-command",)]
        if any(w.dynamic for w in rest):
            return unreadable(ctx, "%s of a computed string" % name) if involves_git(ctx, seg) else d
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
                return unreadable(ctx, "watch of a computed command") if involves_git(ctx, seg) else d
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
            return unreadable(ctx, "shell options are computed") if involves_git(ctx, seg) else OK
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
            return unreadable(ctx, "shell -c of a computed string") if involves_git(ctx, seg) else OK
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
            return unreadable(ctx, "PowerShell options are computed") if involves_git(ctx, seg) else OK
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
                return unreadable(ctx, "PowerShell -Command with a computed string") if involves_git(ctx, seg) else OK
            return analyze_text(joined(rest), "powershell", ctx, depth + 1)
        if key in ("-file", "-f") or (len(key) >= 3 and "-file".startswith(key)):
            return OK
        i += 2 if key in argful else 1
    rest = args[i:]
    if rest:
        if any(x.dynamic for x in rest):
            return unreadable(ctx, "PowerShell with a computed command") if involves_git(ctx, seg) else OK
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
                return unreadable(ctx, "env -S with a computed string") if involves_git(ctx, seg) else OK
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
        self.pr_config = False     # --config-env push.pushOption=... (value unknown)
        self.globals = []          # global options seen before the subcommand (alias expansions included)


def git_args(args, seg, flavor, ctx, depth, envs, via_xargs=False, xargs_repl=None, guessing=False, call=None, hops=0):
    if ctx.mode == "child" and not guessing:
        for k in envs:
            if GIT_CONFIG_ENV.match(k):
                return deny("children may not inject git configuration through the environment (%s)." % k)
    if not guessing and call is None:
        # Commands git runs from the environment: read them like any other command.
        for k, v in envs.items():
            if k.upper() in EXEC_ENV and v:
                d = analyze_text(v, "bash", ctx, depth + 1)
                if d.level > ALLOW:
                    return d
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
        call.globals.append(key)
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
                if ck.startswith("alias.") or EXEC_KEY.match(ck) or CHILD_CONFIG_DENY.match(ck):
                    if ctx.mode == "child":
                        return deny("children may not set %s through --config-env." % ck)
                    if ck.startswith("alias."):
                        call.cfg_aliases[ck[6:]] = None
                if ck == "push.pushoption":
                    call.pr_config = True
                if ctx.mode == "main" and PUSH_CONFIG.match(ck):
                    return ask("push configuration %s comes from the environment (--config-env); "
                               "the guard cannot check the push target." % ck)
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
    if ctx.mode == "child" and re.match(r"^include(if\..+)?\.path$", k):
        return deny("children may not include other git config files (-c %s)." % key)
    if PUSH_CONFIG.match(k) or k == "push.pushoption":
        call.passthrough.extend(["-c", kv])  # the push lint and the PR gate read it back with `git config`
    if EXEC_KEY.match(k):
        if k == "core.hookspath":
            if ctx.mode == "child":
                return deny("children may not point git at another hooks directory (-c %s)." % key)
            return OK
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
    if sub.lower() in GIT_STATE or (sub.lower() == "branch" and branch_changes(rest)):
        ctx.state_segs.add(seg)
    if sub.lower() == "config":
        d = pr_config_write(rest, ctx)
        if d.level > ALLOW:
            return d
    if s in ("submodule", "rebase", "bisect", "difftool"):
        d = nested_commands(s, rest, seg, flavor, ctx, depth, envs)
        if d.level > ALLOW:
            return d
    if ctx.mode == "child":
        if s == "push":
            d = pr_push(rest, ctx, call, envs, seg)
            if d.level > ALLOW:
                return d
        return child_rules(s, rest, ctx, call, seg, via_xargs or bool(xargs_repl))
    if via_xargs and sub in ("commit", "push"):
        return ask("git %s gets arguments from xargs input; the guard cannot check them." % sub)
    if sub == "commit":
        return commit_lint(rest, ctx, call, envs)
    if sub == "push":
        d = pr_push(rest, ctx, call, envs, seg)
        return d if d.level > ALLOW else push_lint(rest, ctx, call, envs)
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
    if s == "difftool":
        opts, _, _, _ = parse_opts(rest, short_arg="xtX", known=("extcmd", "tool", "gui", "no-gui", "dir-diff",
                                                                "prompt", "no-prompt", "symlinks", "no-symlinks",
                                                                "tool-help", "trust-exit-code"),
                                   long_arg=("extcmd", "tool"))
        d = OK
        for v in values(opts, "x", "extcmd"):
            if v is None:
                continue
            if v.dynamic:
                return unreadable(ctx, "git difftool --extcmd with a computed command")
            d = worst(d, analyze_text(v.text, "bash", ctx, depth + 1))
        return d
    if s == "bisect":
        texts = [w.text for w in rest]
        if texts[:1] == ["run"]:
            return run_command(rest[1:], seg, flavor, ctx, depth, envs)
    return OK


# ------------------------------------------------------------------ child rules

def is_test_path(f):
    """A test file by name or directory. Keep in sync with isTestPath in
    extensions/core-adapter/diffscan.ts (same patterns, same order)."""
    p = f.replace("\\", "/")
    base = p[p.rfind("/") + 1:]
    return bool(
        re.search(r"_test\.go\Z", base)
        or re.search(r"(^|[._-])(test|spec)s?\.[a-z]+\Z", base, re.I | re.A)
        or re.match(r"test_.*\.py\Z", base)
        or re.search(r"_tests?\.(py|rs)\Z", base)
        or base == "conftest.py"
        or re.search(r"(^|/)(tests?|__tests__|spec)/", p)
    )


RESTORE_ALLOWED = ("git restore/checkout -- is allowed for a child only on test files your diff modified "
                   "(vs HEAD), one plain path each: `git restore [--worktree|-W] [--staged|-S] [--] <test file>...` "
                   "or `git checkout -- <test file>...`")
RESTORE_SHORT = frozenset("WS")
RESTORE_HARMLESS_GLOBALS = frozenset(("-P", "--no-pager", "--no-optional-locks", "--no-advice"))


def restore_path_problem(p, ctx, call):
    """Why the path word `p` may not be restored by a child, or (None, repo-relative name)."""
    t = p.text
    if p.dynamic:
        return "computed", None
    if not t or t in (".", "..") or t.startswith(("-", ":", "~")) or "\0" in t:
        return "not a plain file path", None
    if any(c in t for c in "*?[]") or p.glob:
        return "a glob", None
    if "\\" in t and os.name != "nt":
        return "not a plain file path (backslash)", None
    if re.match(r"^[A-Za-z]:(?![\\/])", t):
        return "a drive-relative path", None
    if ".." in re.split(r"[\\/]", t):
        return "a path with `..`", None
    if not os.path.isdir(call.cwd):
        return "in an unknown directory", None
    full = os.path.join(call.cwd, t)
    if os.path.isdir(full) or t.endswith(("/", "\\")):
        return "a directory", None
    top = run_git(call, ctx, ["rev-parse", "--show-toplevel"])
    if not top or not top.strip():
        return "not inside a git work tree", None
    root = os.path.normcase(os.path.realpath(top.strip()))
    own = run_git(GitCall(ctx), ctx, ["rev-parse", "--show-toplevel"])
    if not own or os.path.normcase(os.path.realpath(own.strip())) != root:
        return "in another repository than the working directory's", None
    real = os.path.normcase(os.path.realpath(full))
    if real != root and not real.startswith(root.rstrip(os.sep) + os.sep):
        return "outside the repository", None
    if run_git(call, ctx, ["ls-files", "--error-unmatch", "--", t]) is None:
        return "not tracked (untracked files are not restored)", None
    changed = [n for n in (run_git(call, ctx, ["diff", "--name-only", "HEAD", "--", t]) or "").splitlines() if n]
    if not changed:
        return "not modified against HEAD", None
    if len(changed) != 1:
        return "not a single file", None
    if not is_test_path(changed[0]):
        return "not a test file (source changes are the foreman's call)", None
    return None, changed[0]


RESTORE_SHELL_BAN = re.compile(r"[$`;&|<>(){}%\n\r]")


def restore_alone(ctx, seg):
    """The WHOLE command is this one simple git call: one segment, written `git` literally, no shell
    syntax that could set or expand anything (quoted or computed assignments, eval, read, printf -v,
    BASH_ENV, substitutions, redirects, chains, nesting). Decided on structure, not on variable names."""
    if not ctx.root or seg is None:
        return False
    text, flavor = ctx.root
    if flavor not in ("bash", "powershell") or RESTORE_SHELL_BAN.search(text):
        return False
    try:
        lx = lex(text, flavor)
    except LexError:
        return False
    if len(lx.segs) != 1 or lx.subs:
        return False
    only = lx.segs[0]
    if only.heredocs or only.herestrings or not only.words or only.words[0].dynamic or only.words[0].raw != "git":
        return False
    return only.raw() == seg.raw()


def child_restore(s, rest, ctx, call, seg, via_xargs):
    """A child's `git restore` / `git checkout -- <paths>`: allowed only on modified, tracked test files.
    Children run from the task base; a child that committed moves HEAD, so "vs HEAD" is then its own
    uncommitted diff since that commit."""
    def no(why):
        return deny("%s; %s. Anything else: report back and let the foreman do it." % (RESTORE_ALLOWED, why))

    if via_xargs:
        return no("the paths come from xargs input")
    if ctx.state_segs - {seg}:
        return no("an earlier part of the command changes the directory or HEAD; run the restore on its own")
    # Only the cwd's own repository: no global option (-C, --git-dir, --work-tree, -c, --namespace, ...),
    # no GIT_* variable anywhere in the command (GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, GIT_CONFIG*),
    # no wrapper (env, command, sudo, ...) in front of git.
    extra = [g for g in call.globals if g not in RESTORE_HARMLESS_GLOBALS]
    if extra:
        return no("the global option %s is not allowed (it can point git at another repository)" % extra[0])
    if ctx.root and re.search(r"GIT_", ctx.root[0], re.I):
        return no("the command sets a GIT_* variable (it can point git at another repository)")
    if not restore_alone(ctx, seg):
        return no("the restore must be a command of its own: exactly one plain `git ...` call, nothing chained, "
                  "nested or redirected, no variable, assignment, wrapper or substitution")
    if s == "restore":
        opts, pos, dd, _ = parse_opts(rest, short_arg="s", known=(
            "source", "patch", "worktree", "staged", "quiet", "progress", "ours", "theirs", "merge", "conflict",
            "ignore-unmerged", "ignore-skip-worktree-bits", "recurse-submodules", "overlay", "no-overlay",
            "pathspec-from-file", "pathspec-file-nul"), long_arg=("source", "pathspec-from-file", "conflict"))
        for name, _ in opts:
            if name not in ("worktree", "staged") and name not in RESTORE_SHORT:
                return no("-%s%s is not allowed" % ("-" if len(name) > 1 else "", name))
        paths = list(pos) + list(dd)
    else:
        opts, pos, dd, _ = parse_opts(rest)
        if opts or pos:
            return no("options or a tree-ish before `--` are not allowed")
        paths = list(dd)
    if not paths:
        return no("no path given")
    names = []
    for p in paths:
        why, name = restore_path_problem(p, ctx, call)
        if why:
            return no("%s is %s" % (p.text.replace("\0", "?") or "''", why))
        names.append(name)
    ctx.events.extend({"event": "test_restore", "path": n} for n in names)
    return OK


def child_rules(s, rest, ctx, call, seg=None, via_xargs=False):
    def no(what):
        return deny("children may not run `git %s` (%s). Report back and let the foreman do it." % (what, CHILD_WHY.get(s, "it can destroy work")))

    if s in ("push", "send-pack", "http-push"):
        return no(s)
    if s == "restore":
        return child_restore(s, rest, ctx, call, seg, via_xargs)
    dynamic = any(w.dynamic for w in rest)
    if dynamic and s in RISKY_DYNAMIC:
        return deny("children may not run `git %s` with computed arguments; write them out." % s)
    if s == "reset":
        opts, _, _, _ = parse_opts(rest, known=("hard", "soft", "mixed", "merge", "keep", "quiet", "patch",
                                                 "pathspec-from-file"), long_arg=("pathspec-from-file",))
        for o in ("hard", "merge", "keep"):
            if has(opts, o):
                # --merge and --keep still drop work (unmerged entries, the moved-over commits).
                return no("reset --%s" % o)
        return OK
    if s == "checkout":
        opts, pos, dd, _ = parse_opts(rest, short_arg="bB", known=(
            "force", "quiet", "progress", "ours", "theirs", "track", "no-track", "guess", "overwrite-ignore",
            "merge", "conflict", "patch", "orphan", "detach", "ignore-skip-worktree-bits", "pathspec-from-file",
            "overlay", "no-overlay", "recurse-submodules", "ignore-other-worktrees"),
            long_arg=("orphan", "pathspec-from-file"))
        if dd:
            return child_restore(s, rest, ctx, call, seg, via_xargs)
        if has(opts, "f", "force"):
            return no("checkout --force")
        if has(opts, "pathspec-from-file"):
            return no("checkout --pathspec-from-file")
        for v in values(opts, "B"):
            if v is not None and protected_ref(ctx, call, v.text):
                return no("checkout -B %s (resets a protected branch)" % v.text)
        creating = has(opts, "b", "B", "orphan")
        for w in pos:
            t = w.text
            if t == "." or t.startswith(":") or w.glob or t.endswith("/"):
                return no("checkout %s" % t)
        if len(pos) >= 2 and not creating:
            return no("checkout <tree-ish> <path>")
        if len(pos) == 1 and not creating and os.path.lexists(os.path.join(call.cwd, pos[0].text)):
            return deny("children may not run `git checkout %s` (a path: this discards its changes). %s."
                        % (pos[0].text, RESTORE_ALLOWED))
        return OK
    if s == "switch":
        opts, _, _, _ = parse_opts(rest, short_arg="cC", known=(
            "create", "force-create", "detach", "guess", "discard-changes", "force", "merge", "conflict", "quiet",
            "progress", "track", "orphan", "ignore-other-worktrees", "recurse-submodules"),
            long_arg=("create", "force-create", "orphan"))
        if has(opts, "f", "force", "discard-changes"):
            return no("switch --force/--discard-changes")
        for v in values(opts, "C", "force-create"):
            if v is not None and protected_ref(ctx, call, v.text):
                return no("switch -C %s (resets a protected branch)" % v.text)
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
        opts, pos, _, _ = parse_opts(rest, short_arg="u", known=(
            "delete", "force", "move", "copy", "list", "all", "remotes", "verbose", "quiet", "track", "no-track",
            "set-upstream-to", "unset-upstream", "contains", "no-contains", "merged", "no-merged", "points-at",
            "sort", "format", "column", "no-column", "edit-description", "show-current", "create-reflog",
            "recurse-submodules", "ignore-case", "omit-empty", "abbrev", "no-abbrev", "color", "no-color"),
            long_arg=("set-upstream-to", "contains", "no-contains", "merged", "no-merged", "points-at", "sort",
                      "format"))
        if has(opts, "D") or (has(opts, "d", "delete") and has(opts, "f", "force")):
            return no("branch -D")
        if has(opts, "u", "set-upstream-to", "unset-upstream"):
            return no("branch --set-upstream-to/--unset-upstream (changes the push and pull target)")
        if has(opts, "f", "force", "m", "M", "move", "c", "C", "copy"):
            # Moving, renaming onto or copying onto a branch: a protected one may not be touched.
            moving = has(opts, "m", "M", "move", "c", "C", "copy")
            for w in (pos if moving else pos[:1]):
                if protected_ref(ctx, call, w.text):
                    return no("branch %s (moves the protected branch %s)" % (" ".join(x.text for x in rest), w.text))
        return OK
    if s == "worktree":
        sub = rest[0].text if rest else ""
        if sub == "remove":
            opts, _, _, _ = parse_opts(rest[1:], known=("force",))
            if has(opts, "f", "force"):
                return no("worktree remove --force")
        return OK
    if s == "update-ref":
        opts, pos, _, _ = parse_opts(rest, short_arg="m", known=("stdin", "no-deref", "create-reflog", "message"),
                                   long_arg=("message",))
        if has(opts, "d"):
            return no("update-ref -d")
        if has(opts, "stdin"):
            return no("update-ref --stdin")
        if pos and protected_ref(ctx, call, pos[0].text):
            return no("update-ref %s (moves a protected branch)" % pos[0].text)
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
        if has(opts, "global", "system", "file", "f"):
            return no("config --global/--system/--file (writes outside this repository)")
        if has(opts, "rename-section", "remove-section") or words[:1] in (["rename-section"], ["remove-section"]):
            return no("config --rename-section/--remove-section")
        key_words = words[1:2] if words[:1] in (["set"], ["unset"]) else words[:1]
        if not key_words or any(w.dynamic for w in pos):
            return no("config with an unreadable key")
        if key_words[0].lower() not in CHILD_CONFIG_ALLOW:
            return no("config %s (children may set only %s)" % (key_words[0], ", ".join(sorted(CHILD_CONFIG_ALLOW))))
        return OK
    if s == "remote":
        sub = rest[0].text.lower() if rest else ""
        if rest and rest[0].dynamic:
            return no("remote with a computed subcommand")
        if sub in CHILD_REMOTE_DENY:
            return no("remote %s (changes where fetches and pushes go)" % sub)
        return OK
    if s == "read-tree":
        opts, _, _, _ = parse_opts(rest, known=("reset", "prefix", "index-output", "trivial", "aggressive",
                                                 "dry-run", "exclude-per-directory", "empty", "quiet",
                                                 "no-sparse-checkout", "recurse-submodules"))
        if has(opts, "u", "reset"):
            return no("read-tree -u/--reset")
        return OK
    if s == "checkout-index":
        opts, _, _, _ = parse_opts(rest, short_arg="", known=("force", "all", "index", "quiet", "no-create",
                                                              "stage", "prefix", "temp", "stdin", "ignore-skip-worktree-bits"))
        if has(opts, "f", "force", "a", "all"):
            return no("checkout-index -f/-a")
        return OK
    if s == "rm":
        opts, _, _, _ = parse_opts(rest, known=("force", "cached", "dry-run", "quiet", "ignore-unmatch",
                                                 "sparse", "pathspec-from-file", "pathspec-file-nul"),
                                   long_arg=("pathspec-from-file",))
        if has(opts, "n", "dry-run", "cached"):
            return OK
        if has(opts, "f", "force", "r"):
            return no("rm -f/-r")
        return OK
    if s == "fetch":
        opts, pos, dd, _ = parse_opts(rest, short_arg="jo", known=FETCH_KNOWN, long_arg=FETCH_ARG)
        forced = has(opts, "f", "force")
        for w in (pos + list(dd))[1:]:
            r = w.text
            if (forced or r.startswith("+")) and ":" in r:
                dst = strip_ref(r.split(":", 1)[1])
                if dst and protected_hit(ctx, dst):
                    return no("fetch %s (forced update of protected branch %s)" % (r, dst))
        return OK
    return OK


FETCH_KNOWN = ("all", "append", "atomic", "depth", "deepen", "shallow-since", "shallow-exclude", "unshallow",
               "update-shallow", "negotiation-tip", "negotiate-only", "dry-run", "porcelain", "write-fetch-head",
               "force", "keep", "multiple", "auto-maintenance", "auto-gc", "write-commit-graph", "prefetch",
               "prune", "prune-tags", "no-tags", "refetch", "refmap", "tags", "recurse-submodules", "jobs",
               "no-recurse-submodules", "set-upstream", "submodule-prefix", "update-head-ok", "upload-pack",
               "quiet", "verbose", "progress", "server-option", "show-forced-updates", "ipv4", "ipv6")
FETCH_ARG = ("depth", "deepen", "shallow-since", "shallow-exclude", "negotiation-tip", "refmap",
             "recurse-submodules", "jobs", "submodule-prefix", "upload-pack", "server-option")


def protected_hit(ctx, branch):
    """The protected-branch pattern `branch` matches, or None.

    Case-insensitive everywhere: on macOS and Windows `Main` and `main` are the same loose
    ref file, and the remote's file system is unknown. Over-matching only refuses a branch
    whose name differs from a protected one by case."""
    b = branch.lower()
    for p in ctx.cfg.get("protectedBranches") or []:
        if not isinstance(p, str) or not p:
            continue
        q = p.lower()
        if fnmatch.fnmatchcase(b, q) or ("*" in b and fnmatch.fnmatchcase(q, b)):
            return p
    return None


def protected_ref(ctx, call, ref, envs=None):
    """`ref` (a branch name, refs/heads/<name>, or HEAD) names a protected branch."""
    if ref in ("HEAD", "@"):
        ref = current_branch(call, ctx, envs or {}) or ""
    return bool(ref) and protected_hit(ctx, strip_ref(ref)) is not None


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
    "branch": "it deletes an unmerged branch or moves a protected one",
    "worktree": "it deletes a worktree with changes",
    "update-ref": "it deletes or rewrites refs",
    "reflog": "it removes the recovery log",
    "gc": "it removes the objects needed for recovery",
    "prune": "it removes the objects needed for recovery",
    "config": "it would change what git runs or where it pushes",
    "read-tree": "it overwrites uncommitted changes",
    "checkout-index": "it overwrites uncommitted changes",
    "rm": "it deletes files from the work tree",
    "fetch": "only the foreman moves protected branches",
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
    from_file = False  # a -F file's text never goes into a deny reason
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
                from_file = True
            except OSError:
                return ask("cannot read the message file %s; %s." % (v.text, USE_M))
    if not parts:
        return ask("the commit message is not on the command line (editor or --amend reuse); %s." % USE_M)
    # CRLF files (Windows editors, text-mode writes): git's cleanup drops the CR too.
    message = "\n\n".join(p.replace("\r\n", "\n").strip("\n") for p in parts)
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
            if from_file:
                return deny("commit message does not match safety.git.commit.messagePattern %s." % pattern)
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
            if from_file:
                return deny("commit message has a trailer matching forbidden pattern %r "
                            "(safety.git.commit.forbiddenTrailers)." % bad)
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
        return ask("the push has a computed argument (remote or refspec); the guard cannot tell the target "
                   "branch. Write it out.")
    current = current_branch(call, ctx, envs)
    remote = pos[0].text if pos else push_remote(call, ctx, envs, current)
    if remote and git_bool(config_values(call, ctx, envs, "remote.%s.mirror" % remote)):
        return deny("remote %s is configured as a mirror (remote.%s.mirror); a push to it is not allowed while "
                    "safety.git.protectedBranches is set." % (remote, remote))
    refspecs = [w.text for w in pos[1:]]
    configured = False
    if not refspecs and not every and remote:
        # `git push [<remote>]` without refspecs uses remote.<remote>.push when it is set.
        refspecs = config_values(call, ctx, envs, "remote.%s.push" % remote)
        configured = bool(refspecs)
    targets = []  # (branch pattern, destructive)
    if refspecs:
        for r in refspecs:
            plus = r.startswith("+")
            r = r[1:] if plus else r
            if r == ":":
                src = dst = "*"  # matching branches
            elif ":" in r:
                src, dst = r.split(":", 1)
                if not dst:
                    dst = src
            else:
                src = dst = r
            if dst in ("HEAD", "@"):
                dst = current or ""
            targets.append((strip_ref(dst), plus or force or delete or src == ""))
    else:
        implicit = set()
        if every:
            implicit.add("*")
        if force or delete:
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
        p = protected_hit(ctx, dst)
        if p:
            kind = "delete" if (delete or dst == "") else "force push"
            where = " (configured refspec remote.%s.push)" % remote if configured else ""
            return deny("%s to protected branch %s is not allowed%s (safety.git.protectedBranches)." %
                        (kind, p if "*" in dst else dst, where))
    return OK


def config_values(call, ctx, envs, key):
    """Every value of `key` git would see (repo, user and inline `-c` config); read-only."""
    out = run_git(call, ctx, ["config", "--get-all", key], envs)
    return [ln for ln in out.splitlines() if ln.strip()] if out else []


def git_bool(vals):
    return bool(vals) and vals[-1].strip().lower() in ("true", "yes", "on", "1")


def push_remote(call, ctx, envs, current):
    """The remote a bare `git push` goes to."""
    keys = (["branch.%s.pushRemote" % current] if current else []) + ["remote.pushDefault"] + \
        (["branch.%s.remote" % current] if current else [])
    for k in keys:
        v = config_values(call, ctx, envs, k)
        if v:
            return v[-1].strip()
    return "origin"


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


# ================================================================== PR gate

# A pull/merge request is created only for a head a reviewer has passed (payload `pr_gate`).
# Children never create one. The refusal text carries `[pr_refused:<reason>]` for the adapter's trace.
PR_PUSH_KEY = re.compile(r"^(merge_request\.|mr\.|pull_request|topic|pr($|[._-]))", re.I)
# Environment that injects git config (push.pushOption among it) into a push.
PR_CONFIG_ENV = re.compile(r"^GIT_CONFIG_(COUNT|KEY_\d+|PARAMETERS)$", re.I)
# gh's built-in top-level commands, help topics and its default alias `co`. Any other top-level
# word is a user alias or an extension the guard cannot read.
GH_BUILTINS = frozenset("""
accessibility actions agent-task alias api at attestation auth browse cache co codespace completion config
copilot cs discussion environment exit-codes ext extension extensions formatting gist gpg-key help issue label
licenses mintty org pr preview project reference release repo ruleset run search secret skill ssh-key status
telemetry variable version workflow
""".split())
# Commands that change the directory, HEAD or a ref: a PR form next to one in a compound is refused.
CD_NAMES = frozenset(("cd", "pushd", "popd", "chdir", "set-location", "sl", "push-location", "pop-location"))
GIT_STATE = frozenset(("commit", "reset", "checkout", "switch", "merge", "rebase", "cherry-pick", "revert", "am",
                       "pull", "push", "fetch", "stash", "tag", "update-ref", "symbolic-ref", "worktree"))
GH_STATE = (("co",), ("pr", "checkout"), ("repo", "sync"))
BRANCH_CHANGE = ("f", "force", "m", "M", "move", "c", "C", "copy", "d", "D", "delete", "u", "set-upstream-to",
                 "unset-upstream", "track", "edit-description")
PR_API_PULLS = re.compile(r"(^|/)pulls(/\d+)?/?(\?.*)?$")
PR_LONG = ("head", "source-branch", "repo", "hostname", "base", "title", "body", "assignee", "label", "reviewer")
# (program, subcommand words, short options that take a value, head options, label)
PR_FORMS = (
    [("gh", ("pr", b), "aBbFHlmprRTt", ("H", "head"), "gh pr create") for b in ("create", "new")] +
    [("glab", (a, b), "abdlmrRst", ("s", "source-branch"), "glab mr create")
     for a in ("mr", "merge-request") for b in ("create", "new")] +
    [("hub", ("pull-request",), "mFbhaMlri", ("h", "head"), "hub pull-request")] +
    [("tea", (a, b), "tdbmaLlro", ("head",), "tea pr create")
     for a in ("pr", "pulls", "pull") for b in ("create", "c")]
)
PR_ADVICE = {
    "no_review": "no reviewer PASS is recorded in this session. Run a reviewer on this head (HEAD %s) in the "
                 "checkout the pull request comes from, then retry.",
    "stale_review": "the recorded reviewer PASS is for another commit than this head (%s). Run a reviewer on "
                    "this head, then retry.",
    "head_unknown": "the head commit could not be resolved (no git repository here, the head ref does not "
                    "exist or is computed). Name an existing local branch and run a reviewer on it, then retry.",
    "pr_alias": "this is a gh alias or extension (or defines one); the guard cannot tell whether it creates a "
                "pull request. Write the gh command out, e.g. gh pr create.",
    "pr_compound": "another segment of this command changes the directory, HEAD or a ref, so the head checked "
                   "now need not be the head the pull request opens from; run the PR step on its own.",
    "pr_config": "this stores a push option that opens a pull/merge request on every later push. Pass it to "
                 "one reviewed push with -o instead.",
}


def pr_gate_on(ctx):
    return ctx.mode == "child" or (isinstance(ctx.pr_gate, dict) and bool(ctx.pr_gate.get("enabled")))


def pr_block(ctx, reason, what):
    """Refuse a PR form that is not checked against a head: `child` for a child, `reason` when the gate is on."""
    if ctx.mode == "child":
        return pr_refuse("child", what)
    return pr_refuse(reason, what) if pr_gate_on(ctx) else OK


def branch_changes(rest):
    """`git branch` that creates, moves, copies, deletes or re-targets a branch (not a listing)."""
    opts, pos, dd, _ = parse_opts(rest, short_arg="u", long_arg=(
        "contains", "no-contains", "merged", "no-merged", "points-at", "sort", "format", "set-upstream-to"))
    return bool(pos or dd) or has(opts, *BRANCH_CHANGE)


def pr_config_write(rest, ctx):
    """`git config [set] push.pushOption <PR key>`: every later push would carry it."""
    if not pr_gate_on(ctx):
        return OK
    words = list(rest)
    if words and not words[0].dynamic and words[0].text in ("get", "list", "unset", "rename-section",
                                                           "remove-section", "edit", "get-color", "get-colorbool"):
        return OK
    if words and not words[0].dynamic and words[0].text == "set":
        words = words[1:]
    opts, pos, dd, _ = parse_opts(words, short_arg="f", long_arg=("file", "blob", "type", "default", "comment",
                                                                  "value", "url"))
    if has(opts, "get", "get-all", "get-regexp", "get-urlmatch", "get-color", "get-colorbool", "list", "l",
           "unset", "unset-all", "remove-section", "rename-section", "edit", "e"):
        return OK
    pos = list(pos) + list(dd)
    if len(pos) < 2 or not (pos[0].dynamic or pos[0].text.lower() == "push.pushoption"):
        return OK
    if pos[1].dynamic or PR_PUSH_KEY.match(pos[1].text.split("=", 1)[0].strip()):
        return pr_block(ctx, "pr_config", "git config push.pushOption")
    return OK


def pr_refuse(reason, what, sha=None):
    if reason == "child":
        return deny("%s refused [pr_refused:child]: children may not create pull requests. Report back and let "
                    "the foreman do it after a review." % what)
    text = PR_ADVICE[reason]
    if "%s" in text:
        text = text % (sha[:12] if sha else "?")
    return deny("%s refused [pr_refused:%s]: %s" % (what, reason, text))


def pr_gate_check(ctx, call, refs, what, envs=None, upstream=False):
    """`refs`: head refs of the pull request (None = HEAD, "" = unreadable). `upstream`: the
    head's upstream branch, when it has one, must be a reviewed head too (gh opens the PR from
    the remote branch, B-M3)."""
    if ctx.mode == "child":
        return pr_refuse("child", what)
    gate = ctx.pr_gate
    if not isinstance(gate, dict) or not gate.get("enabled"):
        return OK
    heads = gate.get("reviewed_heads")
    reviewed = set(h.lower() for h in heads if isinstance(h, str)) if isinstance(heads, list) else set()
    for ref in refs or [None]:
        ref = "HEAD" if ref is None else ref
        out = None
        if ref and not ref.startswith("-") and "\0" not in ref:
            out = run_git(call, ctx, ["rev-parse", "--verify", "--quiet", ref + "^{commit}"], envs)
        sha = out.strip().lower() if out else ""
        if not re.match(r"^[0-9a-f]{40,64}$", sha):
            return pr_refuse("head_unknown", what)
        if sha not in reviewed:
            return pr_refuse("stale_review" if reviewed else "no_review", what, sha)
        if upstream:
            up = run_git(call, ctx, ["rev-parse", "--verify", "--quiet",
                                     ("" if ref == "HEAD" else ref) + "@{upstream}^{commit}"], envs)
            up = up.strip().lower() if up else ""
            if up and up not in reviewed:
                return pr_refuse("stale_review", what, up)
    return OK


def pr_head_ref(w):
    """Head ref of a `--head` value (`owner:branch` -> `branch`); "" when computed."""
    return "" if w is None or w.dynamic else w.text.rsplit(":", 1)[-1]


def pr_cli(name, args, ctx, seg=None):
    """gh / glab / hub / tea commands that create or change a pull request."""
    if any(not w.dynamic and w.text == "--help" for w in args):
        return OK
    _, pos, dd, _ = parse_opts(args, short_arg="R" if name == "gh" else "", long_arg=("repo", "hostname"))
    words = [w.text.lower() for w in list(pos) + list(dd)]
    call = GitCall(ctx)
    if name == "gh" and words:
        if tuple(words[:1]) in GH_STATE or tuple(words[:2]) in GH_STATE:
            ctx.state_segs.add(seg)
        if words[0] == "alias" and words[1:2] in (["set"], ["import"]):
            return pr_block(ctx, "pr_alias", "gh alias %s" % words[1])
        if words[0] not in GH_BUILTINS:
            # B-B1: a user alias (`gh alias set mk 'pr create'`) or an extension.
            return pr_block(ctx, "pr_alias", "gh %s" % ("<computed>" if "\0" in words[0] else words[0][:40]))
    if name == "gh" and words[:1] == ["api"]:
        opts, pos, dd, _ = parse_opts(args, short_arg="XHfFqtp", long_arg=(
            "method", "header", "field", "raw-field", "input", "jq", "template", "preview", "hostname", "cache"))
        pos = list(pos) + list(dd)
        endpoint = pos[1].text if len(pos) > 1 else ""
        method = [v.text.upper() for v in values(opts, "X", "method") if v is not None]
        fws = [v for v in values(opts, "f", "F", "field", "raw-field") if v is not None]
        fields = [v.text for v in fws]
        write = (method[-1] in ("POST", "PATCH")) if method else bool(fields or has(opts, "input"))
        # B-M5: a body the guard cannot read (`-F query=@file`, `--input`, a computed field) may create one.
        graphql = endpoint.lower() == "graphql" and (
            any("createpullrequest" in f.lower() for f in fields) or has(opts, "input") or
            any(v.dynamic or v.text.partition("=")[2].startswith("@") for v in fws))
        if not write or not (PR_API_PULLS.search(endpoint) or graphql):
            return OK
        ctx.pr_segs.add(seg)
        heads = [pr_head_ref(Word(f[5:])) for f in fields if f.startswith("head=")]
        return pr_gate_check(ctx, call, heads, "gh api %s" % endpoint)
    for prog, sub, shorts, head_opts, label in PR_FORMS:
        if prog == name and tuple(words[:len(sub)]) == sub:
            ctx.pr_segs.add(seg)
            opts, _, _, _ = parse_opts(args, short_arg=shorts, long_arg=PR_LONG)
            heads = [pr_head_ref(v) for v in values(opts, *head_opts)]
            return pr_gate_check(ctx, call, heads, label, upstream=(prog == "gh"))
    return OK


def pr_push(rest, ctx, call, envs, seg=None):
    """`git push` forms that open a pull request: PR push options (`-o`, `-c push.pushOption`,
    GIT_CONFIG_* in the environment, push.pushOption in the repository config), Gerrit refs/for/*."""
    if not pr_gate_on(ctx):
        return OK
    opts, pos, dd, _ = parse_opts(rest, short_arg="o", known=PUSH_KNOWN, long_arg=PUSH_ARG)
    if has(opts, "n", "dry-run"):
        return OK
    pos = list(pos) + list(dd)
    keyed = call.pr_config or ctx.cfg_env or any(PR_CONFIG_ENV.match(k) for k in envs)
    if not keyed:
        keyed = any(PR_PUSH_KEY.match(v.split("=", 1)[0].strip()) for v in config_values(call, ctx, envs, "push.pushOption"))
    for v in values(opts, "o", "push-option"):
        if v is None:
            continue
        if v.dynamic:
            if ctx.mode == "main" and isinstance(ctx.pr_gate, dict) and ctx.pr_gate.get("enabled"):
                return ask("a push option is computed; the guard cannot tell whether it opens a pull request. "
                           "Write it out.")
            continue
        if PR_PUSH_KEY.match(v.text.split("=", 1)[0].strip()):
            keyed = True
    spec_words = pos if has(opts, "repo") else pos[1:]
    pairs = []
    for w in spec_words:
        s = w.text[1:] if w.text.startswith("+") else w.text
        src, _, dst = s.partition(":")
        pairs.append((src, dst if ":" in s and dst else src))
    gerrit = [src for src, dst in pairs if dst.startswith("refs/for/")]
    if not keyed and not gerrit:
        return OK
    ctx.pr_segs.add(seg)
    if any(w.dynamic for w in spec_words):
        return pr_block(ctx, "head_unknown", "git push (pull request)")
    heads = [src for src, _ in pairs if src] if keyed else gerrit
    return pr_gate_check(ctx, call, heads or [None], "git push (pull request)", envs)


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


def decide(command, mode, cwd=None, config=None, flavor="bash", env=None, pr_gate=None):
    cfg = merge_config(DEFAULT_CONFIG, config or {})
    ctx = Ctx(mode, cwd, cfg, env)
    ctx.pr_gate = pr_gate
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
    ctx.pr_gate = payload.get("pr_gate")
    d = analyze_text(command, flavor_of(payload), ctx, 0)
    if d.level == ALLOW:
        if ctx.events:
            # No hook decision: the git-guard extension forwards these to the child's trace.
            sys.stdout.write(json.dumps({"foremanEvents": ctx.events}) + "\n")
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
