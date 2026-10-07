#!/usr/bin/env python3
"""pi-foreman shell write guard (stdlib, Python 3.9+).

The foreman changes project files only through its edit/write tools, which the trivial
bound measures, or through a builder. This guard closes the shell path: it reads the
foreman's bash command STRING and refuses it when it would write a file inside the
workspace and outside `<workspace>/.workflow/` (ledger and notes stay writable). It runs
at every tier, trivial included.

Reads a Claude-hook-shaped payload on stdin and prints the core guards' decision JSON:

    {"hookSpecificOutput": {"hookEventName": "PreToolUse",
                            "permissionDecision": "deny",
                            "permissionDecisionReason": "..."},
     "kind": "redirect"}

No output means "no objection". `kind` names the write form (trace field; never command
text). Exit 0 for every decision; exit 2 (stderr, no stdout) on an internal error, which
the adapter treats as a block.

Input fields: tool_input.command, cwd, workspace (the workspace root; defaults to cwd).

What counts as a write (target resolved against the cwd tracked through `cd`/`pushd`,
subshell-scoped; `cd` inside a pipeline or a background job does not carry over):
  redirect      `>` `>>` `>|` `&>` `&>>` `n>` `>&file` `<>` (not /dev/null, not fd dups)
  tee           every file operand
  sed-i perl-i ruby-i   in-place edits of the file operands
  cp mv install ln rsync   the destination (mv: the sources too, they disappear)
  touch truncate dd      the file operands, `dd of=`
  git           apply, am, restore, checkout -- / checkout <rev> --, stash pop|apply,
                reset --hard, run where git's directory (`-C`) is inside the workspace
  patch         unless --dry-run; run where its directory (`-d`) is inside the workspace
  python node perl ruby   code from -c / -e / here-docs / here-strings / piped echo
                containing a write-open pattern (open(..) with a w/a/x/+/> mode,
                write_text, write_bytes, writeFile, appendFile, fs.write*,
                createWriteStream, shutil.copy*/move, os.rename/replace); a literal
                path argument is resolved, anything else counts as a write
  sh bash zsh dash ksh -c / here-doc / eval   scanned recursively as shell
Wrappers are looked through: sudo, doas, env (incl. -C), command, builtin, exec, nohup,
time, nice, timeout, stdbuf, xargs (its stdin items are unresolvable), find -exec/-ok
(`{}` is unresolvable). `$(..)`, backticks and `<(..)`/`>(..)` bodies are scanned too.

Conservative: a target on a write form that cannot be resolved (`$VAR`, `${..}`, globs,
brace lists, `$(..)`, backticks, `~user`, a cwd lost through `cd $X`/`cd -`/`popd`)
counts as a write. A command that cannot be tokenised (unbalanced quotes) or nests deeper
than MAX_DEPTH is refused as `unreadable`.

Blind spots (not a sandbox; these belong to the OS-boundary round):
  - a script written earlier (e.g. under .workflow/) and run as `python .workflow/x.py`,
    `bash x.sh`, `node x.js`, `source x`, `make`, `npm run ...`;
  - arbitrary binaries and build/format tools that write (`cargo fmt`, `go generate`,
    `gofmt -w`, `prettier --write`, `npm install`, code generators, compilers);
  - composed program names (`$X -i ...`, `"$(which sed)" -i`) and program words built at
    run time; aliases and shell functions defined earlier;
  - interpreter code that writes through other APIs (subprocess/os.system strings,
    zipfile, sqlite, `os.chdir` before a relative open, `perl -i` set via $^I);
  - git forms outside the list above (switch, merge, pull, rebase, cherry-pick, revert,
    worktree), `cd` into a directory that fails, `case` patterns mis-read as subshells.
"""
from __future__ import annotations

import json
import ntpath
import os
import re
import sys

MAX_DEPTH = 4
REFUSAL = ("shell write into project files refused: use the edit/write tools "
           "(measured by the trivial bound) or delegate to a builder")


class Unreadable(Exception):
    pass


# --------------------------------------------------------------------------- lexer

class Word(object):
    __slots__ = ("text", "dynamic", "glob", "quoted")

    def __init__(self):
        self.text = ""
        self.dynamic = False   # an expansion ($x, ${..}, $(..), `..`) anywhere in the word
        self.glob = False      # unquoted * ? [ or a brace list
        self.quoted = False

    @property
    def unresolvable(self):
        return self.dynamic or self.glob

    def __repr__(self):
        return "Word(%r%s)" % (self.text, "*" if self.unresolvable else "")


def lit(text):
    w = Word()
    w.text = text
    return w


def unknown():
    w = Word()
    w.text = "?"
    w.dynamic = True
    return w


class Cmd(object):
    def __init__(self):
        self.words = []
        self.redirs = []      # (op, Word)
        self.stdin = []       # here-doc / here-string texts
        self.subst = []       # nested command texts
        self.op_before = None
        self.op_after = None


SEP_OPS = (";", "&&", "||", "|", "|&", "&", "\n")


def _balanced(text, i, open_ch, close_ch):
    """Index just past the `close_ch` matching an opening already consumed before i."""
    depth = 1
    n = len(text)
    while i < n:
        c = text[i]
        if c == "\\":
            i += 2
            continue
        if c == "'":
            j = text.find("'", i + 1)
            if j < 0:
                raise Unreadable("quote")
            i = j + 1
            continue
        if c == '"':
            i = _dquote_end(text, i + 1)
            continue
        if c == "`":
            i = _backtick_end(text, i + 1)
            continue
        if c == open_ch:
            depth += 1
        elif c == close_ch:
            depth -= 1
            if depth == 0:
                return i + 1
        i += 1
    raise Unreadable("unbalanced %s" % open_ch)


def _dquote_end(text, i):
    n = len(text)
    while i < n:
        c = text[i]
        if c == "\\":
            i += 2
            continue
        if c == '"':
            return i + 1
        if c == "$" and text.startswith("$(", i):
            i = _balanced(text, i + 2, "(", ")")
            continue
        if c == "`":
            i = _backtick_end(text, i + 1)
            continue
        i += 1
    raise Unreadable("quote")


def _backtick_end(text, i):
    n = len(text)
    while i < n:
        if text[i] == "\\":
            i += 2
            continue
        if text[i] == "`":
            return i + 1
        i += 1
    raise Unreadable("backtick")


class Lexer(object):
    def __init__(self, text):
        self.t = text
        self.i = 0
        self.items = []          # Cmd | "(" | ")"
        self.cmd = Cmd()
        self.pending = []        # (delim, strip_tabs, cmd)
        self.last_op = None

    # -- words
    def _expansion(self, w):
        t, i = self.t, self.i
        if t.startswith("$((", i):
            self.i = _balanced(t, i + 3, "(", ")")
            if self.i < len(t) and t[self.i] == ")":
                self.i += 1
        elif t.startswith("$(", i):
            end = _balanced(t, i + 2, "(", ")")
            self.cmd.subst.append(t[i + 2:end - 1])
            self.i = end
        elif t.startswith("${", i):
            self.i = _balanced(t, i + 2, "{", "}")
        else:
            m = re.compile(r"\$([A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])").match(t, i)
            if not m:
                w.text += "$"
                self.i = i + 1
                return
            self.i = m.end()
        w.text += "\x00"
        w.dynamic = True

    def _backtick(self, w):
        end = _backtick_end(self.t, self.i + 1)
        self.cmd.subst.append(self.t[self.i + 1:end - 1].replace("\\`", "`"))
        self.i = end
        w.text += "\x00"
        w.dynamic = True

    def read_word(self, stop_at_ops=True):
        """Read one word at self.i (no leading blanks). Returns Word or None."""
        t = self.t
        n = len(t)
        w = Word()
        started = False
        while self.i < n:
            c = t[self.i]
            if c in " \t\r\n":
                break
            if stop_at_ops and c in ";&|()<>":
                if c in "<>" and t.startswith("(", self.i + 1) and not started:
                    # process substitution <(..) / >(..)
                    end = _balanced(t, self.i + 2, "(", ")")
                    self.cmd.subst.append(t[self.i + 2:end - 1])
                    self.i = end
                    w.text += "\x00"
                    w.dynamic = True
                    started = True
                    continue
                break
            started = True
            if c == "\\":
                if self.i + 1 < n and t[self.i + 1] == "\n":
                    self.i += 2
                    continue
                w.text += t[self.i + 1:self.i + 2]
                w.quoted = True
                self.i += 2
            elif c == "'":
                j = t.find("'", self.i + 1)
                if j < 0:
                    raise Unreadable("quote")
                w.text += t[self.i + 1:j]
                w.quoted = True
                self.i = j + 1
            elif c == "$" and t.startswith("$'", self.i):
                j = self.i + 2
                buf = ""
                while j < n and t[j] != "'":
                    if t[j] == "\\" and j + 1 < n:
                        buf += {"n": "\n", "t": "\t"}.get(t[j + 1], t[j + 1])
                        j += 2
                        continue
                    buf += t[j]
                    j += 1
                if j >= n:
                    raise Unreadable("quote")
                w.text += buf
                w.quoted = True
                self.i = j + 1
            elif c == '"':
                w.quoted = True
                self.i += 1
                while True:
                    if self.i >= n:
                        raise Unreadable("quote")
                    d = t[self.i]
                    if d == '"':
                        self.i += 1
                        break
                    if d == "\\" and self.i + 1 < n and t[self.i + 1] in '$`"\\\n':
                        if t[self.i + 1] != "\n":
                            w.text += t[self.i + 1]
                        self.i += 2
                    elif d == "$":
                        self._expansion(w)
                    elif d == "`":
                        self._backtick(w)
                    else:
                        w.text += d
                        self.i += 1
            elif c == "$":
                self._expansion(w)
            elif c == "`":
                self._backtick(w)
            else:
                if c in "*?[":
                    w.glob = True
                elif c == "{" and re.match(r"\{[^{}\s]*(,|\.\.)[^{}\s]*\}", t[self.i:]):
                    w.glob = True
                w.text += c
                self.i += 1
        return w if started else None

    # -- structure
    def _finish_cmd(self, op):
        c = self.cmd
        if c.words or c.redirs or c.subst or c.stdin:
            c.op_before = self.last_op
            c.op_after = op
            self.items.append(c)
        self.last_op = op
        self.cmd = Cmd()

    def _heredocs(self):
        t = self.t
        for delim, strip, owner in self.pending:
            lines = []
            while self.i < len(t):
                j = t.find("\n", self.i)
                line = t[self.i:] if j < 0 else t[self.i:j]
                self.i = len(t) if j < 0 else j + 1
                check = line.lstrip("\t") if strip else line
                if check.rstrip("\r") == delim:
                    break
                lines.append(check)
            owner.stdin.append("\n".join(lines))
        self.pending = []

    def _in_test(self):
        ws = self.cmd.words
        return bool(ws) and ws[0].text == "[[" and not any(w.text == "]]" for w in ws[1:])

    def run(self):
        t = self.t
        n = len(t)
        while self.i < n:
            c = t[self.i]
            if c in " \t\r":
                self.i += 1
                continue
            if c == "\n":
                self.i += 1
                self._finish_cmd("\n")
                self._heredocs()
                continue
            if c == "#":
                j = t.find("\n", self.i)
                self.i = n if j < 0 else j
                continue
            if c in "<>" and self._in_test():
                self.i += 1
                continue
            m = re.compile(r"(\d*)(&>>|&>|>>|>\||>&|<<<|<<-|<<|<>|<&|>|<)").match(t, self.i)
            if m and (c in "<>" or m.group(1) or t.startswith("&>", self.i)) and not t.startswith("<(", self.i) \
                    and not t.startswith(">(", self.i):
                op = m.group(2)
                self.i = m.end()
                while self.i < n and t[self.i] in " \t":
                    self.i += 1
                target = self.read_word()
                if target is None:
                    raise Unreadable("redirection without target")
                if op in ("<<", "<<-"):
                    self.pending.append((target.text, op == "<<-", self.cmd))
                elif op == "<<<":
                    self.cmd.stdin.append(target.text)
                elif op in ("<", "<&"):
                    pass
                else:
                    self.cmd.redirs.append((op, target))
                continue
            two = t[self.i:self.i + 2]
            if two in ("&&", "||", "|&", ";;"):
                self.i += 2
                self._finish_cmd({";;": ";"}.get(two, two))
                continue
            if c in ";&|":
                self.i += 1
                self._finish_cmd(c)
                continue
            if c == "(":
                if not self.cmd.words and t.startswith("((", self.i):
                    self.i = _balanced(t, self.i + 2, "(", ")")
                    if self.i < n and t[self.i] == ")":
                        self.i += 1
                    continue
                self._finish_cmd(";")
                self.items.append("(")
                self.i += 1
                continue
            if c == ")":
                self._finish_cmd(";")
                self.items.append(")")
                self.i += 1
                continue
            w = self.read_word()
            if w is None:
                self.i += 1
                continue
            self.cmd.words.append(w)
        self._finish_cmd(None)
        if self.pending:
            self._heredocs()
        return self.items


def tokenize(text):
    return Lexer(text).run()


# --------------------------------------------------------------------------- paths

def _fold(p):
    if os.name == "nt" or sys.platform == "darwin":
        return os.path.normcase(p).lower()
    return p


def _inside(root, p):
    root, p = _fold(os.path.normpath(root)), _fold(os.path.normpath(p))
    if p == root:
        return True
    sep = os.sep
    return p.startswith(root.rstrip(sep + "/") + sep) or (os.altsep and p.startswith(root.rstrip(sep + "/") + os.altsep))


def _drive_path(text):
    return bool(re.match(r"^[A-Za-z]:[\\/]", text)) or text.startswith("\\\\")


def absolute(text, cwd):
    """Absolute path for a literal word, or None when it cannot be known."""
    if "\x00" in text:   # an expansion placeholder
        return None
    if text.startswith("~"):
        head = text.split("/", 1)[0]
        if head != "~":
            return None
        text = os.path.expanduser(text)
    if os.name == "nt":
        m = re.match(r"^/([A-Za-z])(/.*)?$", text)
        if m:   # MSYS form /c/...
            text = "%s:%s" % (m.group(1).upper(), (m.group(2) or "/"))
        if os.path.isabs(text) or _drive_path(text):
            return os.path.normpath(text)
    else:
        if _drive_path(text):
            return ntpath.normpath(text)   # a Windows path is never inside a POSIX workspace
        if text.startswith("/"):
            return os.path.normpath(text)
    if cwd is None:
        return None
    return os.path.normpath(os.path.join(cwd, text))


class Scope(object):
    def __init__(self, workspace):
        self.ws = os.path.normpath(os.path.abspath(workspace))
        self.ws_real = os.path.realpath(self.ws)
        self.workflow = os.path.join(self.ws_real, ".workflow")

    def project_path(self, abs_path):
        if abs_path is None:
            return True
        if _drive_path(abs_path) and os.name != "nt":
            return False
        real = os.path.realpath(abs_path)
        if not (_inside(self.ws, abs_path) or _inside(self.ws_real, real)):
            return False
        if _inside(self.workflow, real) and _fold(os.path.normpath(real)) != _fold(self.workflow):
            return False
        return True

    def target(self, word, cwd):
        """True when writing to `word` (a Word or str) counts as a project write."""
        if isinstance(word, Word):
            if word.unresolvable:
                return True
            text = word.text
        else:
            text = word
        if text in ("/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty"):
            return False
        if text == "":
            return False
        return self.project_path(absolute(text, cwd))

    def dir_in_ws(self, cwd):
        """A tool that writes below its working directory (git, patch): any place in the workspace."""
        if cwd is None:
            return True
        real = os.path.realpath(cwd)
        return _inside(self.ws, cwd) or _inside(self.ws_real, real)


# --------------------------------------------------------------------------- analysis

class Found(Exception):
    def __init__(self, kind, target):
        Exception.__init__(self, kind)
        self.kind = kind
        self.target = target


def _show(word):
    if isinstance(word, Word):
        return "<unresolved>" if word.unresolvable else word.text
    return str(word)


def _hit(scope, kind, word, cwd):
    if scope.target(word, cwd):
        raise Found(kind, _show(word))


def _prog(word):
    if word.unresolvable:
        return None
    name = re.split(r"[\\/]", word.text)[-1].lower()
    if name.endswith(".exe"):
        name = name[:-4]
    return name


def _positionals(args, with_arg=(), long_with_arg=()):
    """Split options from operands. `--` ends options. Returns (opts, operands)."""
    opts, ops = [], []
    i = 0
    while i < len(args):
        a = args[i]
        t = a.text
        if t == "--" and not a.unresolvable:
            ops.extend(args[i + 1:])
            break
        if t.startswith("--") and len(t) > 2 and not a.unresolvable:
            name = t.split("=", 1)[0]
            if "=" not in t and name in long_with_arg and i + 1 < len(args):
                opts.append((name, args[i + 1]))
                i += 2
                continue
            opts.append((name, lit(t.split("=", 1)[1]) if "=" in t else None))
        elif t.startswith("-") and len(t) > 1 and not a.unresolvable:
            letters = t[1:]
            for k, ch in enumerate(letters):
                if ch in with_arg:
                    rest = letters[k + 1:]
                    if rest:
                        opts.append(("-" + ch, lit(rest)))
                    elif i + 1 < len(args):
                        opts.append(("-" + ch, args[i + 1]))
                        i += 1
                    else:
                        opts.append(("-" + ch, None))
                    break
                opts.append(("-" + ch, None))
        else:
            ops.append(a)
        i += 1
    return opts, ops


def _opt(opts, *names):
    return [v for k, v in opts if k in names]


WRAPPERS = {"command", "builtin", "exec", "nohup", "time", "nice", "timeout", "stdbuf", "sudo", "doas",
            "env", "xargs", "chronic", "ionice", "caffeinate"}
SHELLS = {"sh", "bash", "zsh", "dash", "ksh", "mksh", "ash"}
PYTHONS = re.compile(r"^(python[0-9.]*|py|pypy[0-9.]*)$")


class Analyzer(object):
    def __init__(self, scope):
        self.scope = scope

    # -- shell text
    def text(self, text, cwd, depth):
        if depth > MAX_DEPTH:
            raise Found("unreadable", "<nested too deep>")
        items = tokenize(text)
        stack = []
        prev = None
        for it in items:
            if it == "(":
                stack.append(cwd)
                prev = None
                continue
            if it == ")":
                if stack:
                    cwd = stack.pop()
                prev = None
                continue
            piped_in = None
            if it.op_before in ("|", "|&") and prev is not None:
                piped_in = self.stdout_of(prev)
            cwd = self.command(it, cwd, depth, piped_in)
            prev = it
        return cwd

    def stdout_of(self, cmd):
        if not cmd.words:
            return "\n".join(cmd.stdin) or None
        p = _prog(cmd.words[0])
        if p in ("echo", "printf"):
            return " ".join(w.text for w in cmd.words[1:])
        if p == "cat" and len(cmd.words) == 1:
            return "\n".join(cmd.stdin) or None
        return None

    def command(self, cmd, cwd, depth, piped_in):
        s = self.scope
        for op, word in cmd.redirs:
            if op == ">&" and (word.text == "-" or word.text.isdigit()) and not word.unresolvable:
                continue
            _hit(s, "redirect", word, cwd)
        for sub in cmd.subst:
            self.text(sub, cwd, depth + 1)
        words = list(cmd.words)
        # keywords and assignments in front of the program word
        while words and not words[0].unresolvable and words[0].text in (
                "if", "then", "else", "elif", "do", "while", "until", "!", "{", "}", "fi", "done", "esac"):
            words.pop(0)
        if words and not words[0].unresolvable and words[0].text in ("for", "case", "select", "function", "[["):
            return cwd
        while words and re.match(r"^[A-Za-z_][A-Za-z0-9_]*\+?=", words[0].text):
            words.pop(0)
        if not words:
            return cwd
        stdin = "\n".join(cmd.stdin) if cmd.stdin else piped_in
        if _prog(words[0]) in ("cd", "pushd", "popd"):
            new = self.cd(words, cwd)
            if cmd.op_before in ("|", "|&") or cmd.op_after in ("|", "|&", "&"):
                return cwd
            return new
        self.run(words, cwd, depth, stdin)
        return cwd

    def cd(self, words, cwd):
        p = _prog(words[0])
        if p == "popd":
            return None
        args = [w for w in words[1:] if not (w.text.startswith("-") and w.text != "-" and not w.unresolvable)]
        if not args:
            return os.path.expanduser("~")
        a = args[0]
        if a.unresolvable or a.text == "-" or a.text.startswith("+"):
            return None
        return absolute(a.text, cwd)

    # -- one simple command (program word first)
    def run(self, words, cwd, depth, stdin):
        s = self.scope
        prog = _prog(words[0])
        args = words[1:]
        if prog is None:
            return
        if prog in WRAPPERS:
            return self.wrapper(prog, args, cwd, depth, stdin)
        if prog == "eval":
            return self.text(" ".join(w.text for w in args), cwd, depth + 1)
        if prog == "find":
            return self.find(args, cwd, depth)
        if prog in SHELLS:
            return self.shell(prog, args, cwd, depth, stdin)
        if PYTHONS.match(prog):
            return self.interp("python", args, cwd, stdin, "c", "WXmQ")
        if prog in ("node", "nodejs", "deno", "bun"):
            return self.node(args, cwd, stdin)
        if prog == "perl":
            self.inplace("perl", args, cwd, "eEMI")
            return self.interp("perl", args, cwd, stdin, "eE", "MI")
        if prog == "ruby":
            self.inplace("ruby", args, cwd, "erICEF")
            return self.interp("ruby", args, cwd, stdin, "e", "rICEF")
        if prog in ("sed", "gsed"):
            return self.sed(args, cwd)
        if prog == "tee":
            _, ops = _positionals(args)
            for w in ops:
                _hit(s, "tee", w, cwd)
            return
        if prog in ("cp", "mv", "install", "ln", "rsync"):
            return self.copy(prog, args, cwd)
        if prog in ("touch", "truncate"):
            opts, ops = _positionals(args, with_arg="tdr" if prog == "touch" else "sr",
                                     long_with_arg=("--date", "--reference", "--size"))
            for w in ops:
                _hit(s, prog, w, cwd)
            return
        if prog == "dd":
            for w in args:
                if w.text.startswith("of="):
                    t = Word()
                    t.text, t.dynamic, t.glob = w.text[3:], w.dynamic, w.glob
                    _hit(s, "dd", t, cwd)
            return
        if prog == "git":
            return self.git(args, cwd)
        if prog == "patch":
            opts, ops = _positionals(args, with_arg="dioprBDFgVYzx",
                                     long_with_arg=("--directory", "--input", "--output", "--strip"))
            if _opt(opts, "--dry-run", "-C", "--check"):
                return
            for o in _opt(opts, "-o", "--output"):
                if o is not None and o.text != "-":
                    _hit(s, "patch", o, cwd)
            d = _opt(opts, "-d", "--directory")
            where = cwd
            if d:
                where = None if d[-1] is None or d[-1].unresolvable else absolute(d[-1].text, cwd)
            if s.dir_in_ws(where):
                raise Found("patch", "<working tree>")
            return

    def wrapper(self, prog, args, cwd, depth, stdin):
        with_arg = {"sudo": "ugpChDrtUT", "doas": "uC", "nice": "n", "timeout": "sk", "stdbuf": "ioe",
                    "env": "uCSP", "xargs": "IEdLnPsa", "ionice": "cnp"}.get(prog, "")
        rest = list(args)
        i = 0
        opts = []
        while i < len(rest):
            t = rest[i].text
            if rest[i].unresolvable or not t.startswith("-") or t == "-":
                break
            if t == "--":
                i += 1
                break
            letters = t[1:] if not t.startswith("--") else ""
            for k, ch in enumerate(letters):
                if ch in with_arg:
                    val = letters[k + 1:] or (rest[i + 1].text if i + 1 < len(rest) else "")
                    opts.append(("-" + ch, val, rest[i + 1] if not letters[k + 1:] and i + 1 < len(rest) else None))
                    if not letters[k + 1:]:
                        i += 1
                    break
            if t.startswith("--") and "=" not in t and t in ("--chdir", "--user", "--unset", "--split-string",
                                                             "--replace", "--max-args", "--max-procs",
                                                             "--delimiter", "--signal", "--kill-after"):
                opts.append((t, rest[i + 1].text if i + 1 < len(rest) else "", rest[i + 1] if i + 1 < len(rest) else None))
                i += 1
            elif t.startswith("--") and "=" in t:
                opts.append((t.split("=", 1)[0], t.split("=", 1)[1], None))
            i += 1
        inner = rest[i:]
        if prog == "env":
            while inner and re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", inner[0].text):
                inner = inner[1:]
            for k, v, w in opts:
                if k in ("-S", "--split-string"):
                    raise Found("unreadable", "<env -S>")
                if k in ("-C", "--chdir"):
                    cwd = None if (w is not None and w.unresolvable) else absolute(v, cwd)
        if prog == "timeout" and inner:
            inner = inner[1:]   # the duration
        if prog == "xargs":
            repl = [v for k, v, _ in opts if k in ("-I", "--replace")]
            if repl:
                r = repl[-1]
                inner = [unknown() if r and r in w.text else w for w in inner]
            else:
                inner = inner + [unknown()]
            if not inner or (len(inner) == 1 and inner[0].text == "?"):
                return
        if not inner:
            return
        self.run(inner, cwd, depth, stdin)

    def find(self, args, cwd, depth):
        i = 0
        while i < len(args):
            t = args[i].text
            if t in ("-exec", "-execdir", "-ok", "-okdir"):
                j = i + 1
                inner = []
                while j < len(args) and args[j].text not in (";", "+"):
                    inner.append(unknown() if "{}" in args[j].text else args[j])
                    j += 1
                if inner:
                    where = None if t.endswith("dir") else cwd
                    self.run(inner, where, depth + 1, None)
                i = j
            elif t in ("-fprint", "-fprint0", "-fprintf", "-fls") and i + 1 < len(args):
                _hit(self.scope, "find", args[i + 1], cwd)
            i += 1

    def shell(self, prog, args, cwd, depth, stdin):
        i = 0
        while i < len(args):
            t = args[i].text
            if args[i].unresolvable:
                return
            if t.startswith("-") and len(t) > 1 and not t.startswith("--"):
                if "c" in t[1:]:
                    if i + 1 >= len(args):
                        return
                    self.text(args[i + 1].text, cwd, depth + 1)
                    return
                if t[1:] in ("o", "O") and i + 1 < len(args):
                    i += 1
                i += 1
                continue
            if t.startswith("--"):
                i += 1
                continue
            return   # `bash script.sh`: a blind spot (documented)
        if stdin:
            self.text(stdin, cwd, depth + 1)

    def sed(self, args, cwd):
        inplace = False
        scripted = False
        ops = []
        i = 0
        while i < len(args):
            a = args[i]
            t = a.text
            if a.unresolvable:
                ops.append(a)
            elif t == "--":
                ops.extend(args[i + 1:])
                break
            elif t.startswith("--in-place"):
                inplace = True
            elif t in ("--expression", "--file"):
                scripted = True
                i += 1
            elif t.startswith("--expression=") or t.startswith("--file="):
                scripted = True
            elif t.startswith("--"):
                if t in ("--line-length",):
                    i += 1
            elif t.startswith("-") and len(t) > 1:
                letters = t[1:]
                for k, ch in enumerate(letters):
                    if ch == "i":
                        inplace = True
                        if k == len(letters) - 1 and i + 2 < len(args) and (
                                args[i + 1].text == "" or re.match(r"^\.[^/\\]*$", args[i + 1].text)):
                            i += 1   # BSD sed: `-i ''` / `-i .bak` suffix
                        break        # GNU: the rest of the cluster is the suffix
                    if ch in "ef":
                        scripted = True
                        if k == len(letters) - 1:
                            i += 1
                        break
                    if ch == "l":
                        if k == len(letters) - 1:
                            i += 1
                        break
            else:
                ops.append(a)
            i += 1
        if not inplace:
            return
        if not scripted and ops:
            ops = ops[1:]
        for w in ops:
            _hit(self.scope, "sed-i", w, cwd)

    def inplace(self, lang, args, cwd, with_arg):
        on = False
        ops = []
        code_given = False
        i = 0
        while i < len(args):
            a = args[i]
            t = a.text
            if t == "--":
                ops.extend(args[i + 1:])
                break
            if t.startswith("-") and len(t) > 1 and not a.unresolvable:
                letters = t[1:]
                for k, ch in enumerate(letters):
                    if ch == "i":
                        on = True
                        break   # the rest is the backup suffix
                    if ch in with_arg:
                        if ch in "eE":
                            code_given = True
                        if k == len(letters) - 1:
                            i += 1
                        break
            else:
                ops.append(a)
            i += 1
        if not on:
            return
        if not code_given and ops:
            ops = ops[1:]   # the script file
        for w in ops:
            _hit(self.scope, lang + "-i", w, cwd)

    def copy(self, prog, args, cwd):
        s = self.scope
        with_arg = {"cp": "tS", "mv": "tS", "install": "tSmogC", "ln": "tS", "rsync": "efBTM"}[prog]
        long_arg = ("--target-directory", "--suffix", "--mode", "--owner", "--group", "--exclude", "--include",
                    "--filter", "--files-from", "--exclude-from", "--include-from", "--rsh", "--temp-dir",
                    "--backup-dir", "--compare-dest", "--copy-dest", "--link-dest", "--rsync-path", "--chmod")
        opts, ops = _positionals(args, with_arg=with_arg, long_with_arg=long_arg)
        target = _opt(opts, "-t", "--target-directory")
        if prog == "install" and _opt(opts, "-d", "--directory"):
            for w in ops:
                _hit(s, prog, w, cwd)
            return
        if target:
            dest = target[-1] if target[-1] is not None else unknown()
            srcs = ops
        elif prog == "ln" and len(ops) == 1:
            if ops[0].unresolvable:
                dest = unknown()
            else:
                dest = lit(re.split(r"[\\/]", ops[0].text.rstrip("/\\"))[-1] or ".")
            srcs = []
        elif len(ops) >= 2:
            dest, srcs = ops[-1], ops[:-1]
        else:
            return
        if prog == "rsync" and not dest.unresolvable and re.match(r"^[^/\\]*:", dest.text) and not _drive_path(dest.text):
            return   # remote destination host:path
        _hit(s, prog, dest, cwd)
        if prog == "mv":
            for w in srcs:
                _hit(s, prog, w, cwd)

    def git(self, args, cwd):
        i = 0
        where = cwd
        while i < len(args):
            t = args[i].text
            if t == "-C" and i + 1 < len(args):
                d = args[i + 1]
                where = None if d.unresolvable else absolute(d.text, where)
                i += 2
                continue
            if t in ("-c", "--git-dir", "--work-tree", "--namespace") and i + 1 < len(args):
                if t == "--work-tree":
                    where = None if args[i + 1].unresolvable else absolute(args[i + 1].text, where)
                i += 2
                continue
            if t.startswith("--work-tree="):
                where = absolute(t.split("=", 1)[1], where)
            if t.startswith("-"):
                i += 1
                continue
            break
        if i >= len(args) or args[i].unresolvable:
            return
        sub = args[i].text
        rest = [w.text for w in args[i + 1:]]
        write = False
        if sub == "apply":
            write = not (set(rest) & {"--check", "--stat", "--numstat", "--summary"}) or "--apply" in rest
        elif sub in ("am", "restore"):
            write = not (set(rest) & {"--abort", "--show-current-patch", "--quit"})
        elif sub == "checkout":
            write = "--" in rest
        elif sub == "stash":
            write = bool(rest) and rest[0] in ("pop", "apply")
        elif sub == "reset":
            write = "--hard" in rest
        if write and self.scope.dir_in_ws(where):
            raise Found("git", "git " + sub)

    # -- interpreters
    def node(self, args, cwd, stdin):
        codes = []
        script = False
        i = 0
        while i < len(args):
            t = args[i].text
            if t in ("-e", "--eval", "-p", "--print") and i + 1 < len(args):
                codes.append(args[i + 1])
                i += 2
                continue
            if t in ("-r", "--require", "--import", "--loader") and i + 1 < len(args):
                i += 2
                continue
            if t == "-":
                break
            if not t.startswith("-") or args[i].unresolvable:
                script = True
                break
            i += 1
        if not codes and not script and stdin:
            codes.append(lit(stdin))
        for c in codes:
            self.code("node", c, cwd)

    def interp(self, lang, args, cwd, stdin, code_flags, arg_flags):
        codes = []
        script = False
        i = 0
        while i < len(args):
            a = args[i]
            t = a.text
            if a.unresolvable:
                script = True
                break
            if t == "-":
                break
            if t == "--":
                script = i + 1 < len(args)
                break
            if t.startswith("--"):
                i += 1
                continue
            if t.startswith("-") and len(t) > 1:
                letters = t[1:]
                stop = False
                for k, ch in enumerate(letters):
                    if ch in code_flags:
                        tail = letters[k + 1:]
                        if tail:
                            codes.append(lit(tail))
                        elif i + 1 < len(args):
                            i += 1
                            codes.append(args[i])
                        if lang == "python":
                            stop = True
                        break
                    if ch in arg_flags:
                        if k == len(letters) - 1:
                            i += 1
                        if lang == "python" and ch == "m":
                            stop = True   # python -m module: a blind spot
                            script = True
                        break
                if stop:
                    break
                i += 1
                continue
            script = True
            break
        if not codes and not script and stdin:
            codes.append(lit(stdin))
        for c in codes:
            self.code(lang, c, cwd)

    def code(self, lang, word, cwd):
        for path in code_writes(lang, word.text):
            if path is None:
                raise Found(lang, "<write in code>")
            if self.scope.target(path, cwd):
                raise Found(lang, path)


# --------------------------------------------------------------------------- interpreter code

STR = re.compile(r"""^\s*[rRbBuU]{0,2}("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s*$""", re.S)
MODE = re.compile(r"^[rwxabtU+]{1,4}$")
CALLS_PATH_FIRST = re.compile(
    r"(?<![A-Za-z0-9_])(writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|"
    r"fs\.(?:promises\.)?write\w*|Deno\.writeTextFile|Deno\.writeFile|Bun\.write|File\.write|IO\.write)\s*\(")
CALLS_TWO = re.compile(   # (source, destination): the destination is written, a moved source vanishes
    r"(?<![A-Za-z0-9_])(shutil\.(?:copy\w*|move)|os\.(?:rename|replace|link|symlink)|"
    r"(?:fs\.)?(?:copyFileSync|copyFile|renameSync|rename|cpSync|cp))\s*\(")
PATH_WRITE = re.compile(r"""(?:Path|PurePath)\(\s*([rRbBuU]{0,2}(?:"[^"\\]*"|'[^'\\]*'))\s*\)\s*\.\s*write_(?:text|bytes)\b""")
BARE_WRITE = re.compile(r"\.\s*write_(?:text|bytes)\s*\(|\.\s*touch\s*\(")
OPEN = re.compile(r"(?<![A-Za-z0-9_])(?:(os|io|codecs|fs|File|IO|Kernel)\s*\.\s*)?(open|sysopen|openSync)\b\s*(\(?)")


def _str_value(arg, lang):
    """The literal value of a plain string argument, or None."""
    m = STR.match(arg)
    if not m:
        return None
    body = m.group(1)
    q = body[0]
    inner = body[1:-1]
    if q == '"' and lang in ("perl", "ruby") and re.search(r"[$@]|#\{", inner):
        return None
    if lang == "python" and re.match(r"^\s*[fF]", arg):
        return None
    if lang == "node" and "${" in inner:
        return None
    return re.sub(r"\\(.)", r"\1", inner)


def _split_args(text, start):
    """Top-level comma-separated arguments of a call whose '(' ends at start-1."""
    depth = 0
    args = []
    cur = ""
    i = start
    n = len(text)
    while i < n:
        c = text[i]
        if c in "\"'`":
            j = i + 1
            while j < n and text[j] != c:
                j += 2 if text[j] == "\\" else 1
            cur += text[i:j + 1]
            i = j + 1
            continue
        if c in "([{":
            depth += 1
        elif c in ")]}":
            if depth == 0:
                args.append(cur)
                return args
            depth -= 1
        elif c == "," and depth == 0:
            args.append(cur)
            cur = ""
            i += 1
            continue
        cur += c
        i += 1
    args.append(cur)
    return args


def _bare_args(text, start):
    """Arguments of a paren-less call (perl `open my $fh, '>', $f;`)."""
    end = len(text)
    for stop in (";", "\n", " or ", " || ", " && "):
        j = text.find(stop, start)
        if 0 <= j < end:
            end = j
    return _split_args(text[start:end] + ")", 0)


def code_writes(lang, text):
    """Write targets in interpreter code: literal paths, or None for an unknown target."""
    out = []
    for m in PATH_WRITE.finditer(text):
        out.append(_str_value(m.group(1), lang))
    if BARE_WRITE.search(PATH_WRITE.sub("", text)):
        out.append(None)
    for m in CALLS_PATH_FIRST.finditer(text):
        args = _split_args(text, m.end())
        out.append(_str_value(args[0], lang) if args else None)
    for m in CALLS_TWO.finditer(text):
        args = _split_args(text, m.end())
        if len(args) < 2:
            out.append(None)
            continue
        moved = re.search(r"move|rename|replace", m.group(1), re.I)
        out.extend(_str_value(a, lang) for a in (args[:2] if moved else args[1:2]))
    for m in OPEN.finditer(text):
        args = _split_args(text, m.end()) if m.group(3) else _bare_args(text, m.end())
        args = [a for a in args if a.strip()]
        if lang == "perl" or m.group(2) == "sysopen":
            out.extend(_perl_open(args, lang))
            continue
        mode_arg = None
        for a in args[1:]:
            kw = re.match(r"^\s*(mode|flags)\s*[=:]\s*(.*)$", a, re.S)
            if kw:
                mode_arg = kw.group(2)
                break
        if mode_arg is None and len(args) >= 2 and not re.match(r"^\s*\w+\s*=", args[1]):
            mode_arg = args[1]
        if mode_arg is None:
            continue
        mv = _str_value(mode_arg, lang)
        if mv is None:
            if re.search(r"O_RDONLY", mode_arg) and not re.search(r"O_(WRONLY|RDWR|CREAT|APPEND|TRUNC)", mode_arg):
                continue
            if re.match(r"^\s*[\{]", mode_arg) and not re.search(r"flags?\s*:", mode_arg):
                continue   # node options object without flags
            out.append(_str_value(args[0], lang) if args else None)
            continue
        if MODE.match(mv) and re.search(r"[wax+]", mv):
            out.append(_str_value(args[0], lang))
    return out


def _perl_open(args, lang):
    if len(args) < 2:
        return []
    mode = _str_value(args[1], lang)
    if mode is None:
        return [None]
    m = mode.strip()
    if m in (">", ">>", "+<", "+>", "+>>") or re.match(r"^\+?[<>]{1,2}:", m):
        return [_str_value(args[2], lang) if len(args) > 2 else None]
    if re.match(r"^(\+<|\+?>>?)", m):
        return [re.sub(r"^(\+<|\+?>>?)\s*", "", m)]
    return []


# --------------------------------------------------------------------------- entry

def decide(command, cwd, workspace=None):
    """None (no project write) or (kind, target)."""
    scope = Scope(workspace or cwd)
    try:
        Analyzer(scope).text(command, os.path.normpath(os.path.abspath(cwd)), 0)
    except Found as f:
        return f.kind, f.target
    except Unreadable:
        return "unreadable", "<command>"
    return None


def main(argv=None):
    raw = sys.stdin.buffer.read().decode("utf-8")
    payload = json.loads(raw) if raw.strip() else {}
    if not isinstance(payload, dict):
        raise ValueError("payload is not a JSON object")
    ti = payload.get("tool_input") or {}
    command = ti.get("command") if isinstance(ti, dict) else None
    if not isinstance(command, str) or not command.strip():
        return 0
    cwd = payload.get("cwd") if isinstance(payload.get("cwd"), str) and payload.get("cwd") else os.getcwd()
    ws = payload.get("workspace") if isinstance(payload.get("workspace"), str) and payload.get("workspace") else cwd
    hit = decide(command, cwd, ws)
    if hit is None:
        return 0
    kind, target = hit
    out = {"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny",
                                  "permissionDecisionReason": "pi-foreman: %s (%s: %s)" % (REFUSAL, kind, target[:200])},
           "kind": kind}
    sys.stdout.write(json.dumps(out) + "\n")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # noqa: BLE001 - any failure must reach the caller as a block
        sys.stderr.write("shell_write_guard: internal error: %s: %s\n" % (type(exc).__name__, exc))
        sys.exit(2)
