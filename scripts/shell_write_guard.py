#!/usr/bin/env python3
"""pi-foreman shell write guard (stdlib, Python 3.9+).

The foreman changes project files only through its edit/write tools, which the trivial
bound measures, or through a builder. This guard closes the shell path: it reads the
foreman's bash command STRING and refuses it when it would write a file inside the
workspace and outside the allowed dirs (`allowed_dirs`, default `<workspace>/.workflow/`:
ledger and notes stay writable; the adapter adds the scratch dir in scratchpad mode). It runs
at every tier, trivial included.

Reads a Claude-hook-shaped payload on stdin and prints the core guards' decision JSON:

    {"hookSpecificOutput": {"hookEventName": "PreToolUse",
                            "permissionDecision": "deny",
                            "permissionDecisionReason": "..."},
     "kind": "redirect"}

No output means "no objection". `kind` names the write form (trace field; never command
text). Exit 0 for every decision; exit 2 (stderr, no stdout) on an internal error, which
the adapter treats as a block.

Input fields: tool_input.command, cwd, workspace (the workspace root; defaults to cwd),
shell ("bash" | "powershell"; the foreman's opt-in powershell tool sends "powershell"),
allowed_dirs (workspace-relative list; missing = [".workflow"]; absolute or `..` entries are ignored).

What counts as a write (target resolved against the cwd tracked through `cd`/`pushd`,
subshell-scoped; `cd` inside a pipeline or a background job does not carry over):
  redirect      `>` `>>` `>|` `&>` `&>>` `n>` `>&file` `<>` (not /dev/null, not fd dups)
  tee           every file operand
  sed-i perl-i ruby-i   in-place edits of the file operands
  cp mv install ln rsync   the destination (mv: the sources too, they disappear)
  touch truncate dd      the file operands, `dd of=`
  delete        rm rmdir unlink shred trash operands, `git rm` (and `git clean` unless -n)
  rename        `git mv` operands
  sort curl wget        `sort -o F`; `curl -o F`, `curl -O` (cwd or --output-dir);
                `wget -O F` (not `-O -`), else its `-P` dir or the cwd
  tar unzip     `tar x` into the cwd or `-C D`; `unzip` into the cwd or `-d D` (not -l/-t/-p)
  awk-i         `awk|gawk -i inplace` file operands
  git           apply, am, restore, stash pop|apply, reset --hard, every checkout/switch
                except creating a branch at HEAD (`checkout -b|-B|--orphan NAME`,
                `switch -c|-C NAME`, no start point, no path; a branch switch rewrites
                the work tree), run where git's directory (`-C`) is inside the workspace
  patch         unless --dry-run; run where its directory (`-d`) is inside the workspace
  python node perl ruby   code from -c / -e / here-docs / here-strings / piped echo
                containing a write-open pattern (open(..) with a w/a/x/+/> mode,
                write_text, write_bytes, writeFile, appendFile, fs.write*,
                createWriteStream, shutil.copy*/move, os.rename/replace; a method
                `x.open('w')` / `.open(mode='w')`, whose target is unknown); a literal
                path argument is resolved, anything else counts as a write
  sh bash zsh dash ksh -c / here-doc / eval   scanned recursively as shell (option
                clusters such as `-euo pipefail -c` included); `pwsh -Command` as PowerShell
Wrappers are looked through: sudo, doas, env (incl. -C), command, builtin, exec, nohup,
time, nice, timeout, stdbuf, xargs (its stdin items are unresolvable), find -exec/-ok
(`{}` is unresolvable), and the project runners `uv run`, `poetry run`, `pipenv run`,
`npx` / `npm exec` (incl. -c), `pnpm exec|dlx`, `yarn exec`, `bunx`, `bun x|run`
(`python -m` is not a wrapper); `deno run|eval`, `tsx`, `ts-node` get the node analysis.
`$(..)`, backticks and `<(..)`/`>(..)` bodies are scanned too.

PowerShell (`shell: "powershell"`): Set-Content, Add-Content, Clear-Content, Out-File,
Tee-Object, New-Item, Copy-Item (destination), Move-Item, Remove-Item, Rename-Item and
their aliases (sc ac clc tee ni cp copy cpi mv move mi rm ri del erase rd rmdir ren rni),
`-OutFile` / `-DestinationPath` of any cmdlet, `>`/`>>`/`n>`/`*>` (not `$null`, not
`2>&1`), `[IO.File]::` writers (relative paths against the start directory), literal
`iex '..'`, `$(..)` bodies; Set-Location/Push-Location are tracked, Pop-Location loses
the location; a writer without a target (pipeline input) or with `$var` counts as a
write; other programs (git, python, node, sed, ...) get the bash analysis above.

Conservative: a target on a write form that cannot be resolved (`$VAR`, `${..}`, globs,
brace lists, `$(..)`, backticks, `~user`, a cwd lost through `cd $X`/`cd -`/`popd`, a
Windows drive-relative `C:x` / `D:`, which is also what bash leaves of an unquoted
`C:\\a\\b`) counts as a write. A file target is resolved through symlinks before `..`
(as the kernel does; `cd` folds `..` first unless -P), so `.workflow/<link>/..` is not
`.workflow/`. A command that cannot be tokenised (unbalanced quotes) or nests deeper
than MAX_DEPTH is refused as `unreadable`.

Blind spots (not a sandbox; these belong to the OS-boundary round):
  - a script written earlier (e.g. under .workflow/) and run as `python .workflow/x.py`,
    `bash x.sh`, `node x.js`, `source x`, `make`, `npm run ...`;
  - arbitrary binaries and build/format tools that write (`cargo fmt`, `go generate`,
    `gofmt -w`, `prettier --write`, `npm install`, code generators, compilers) and other
    writers (`mkdir`, `chmod`, `split`, `uniq in out`, `xxd -r`, `openssl -out`, `tar c`,
    `curl -D|-c`, awk `print > "f"`, `ed`/`ex`/`vim -c wq`, `pdm run`, `hatch run`);
  - composed program names (`$X -i ...`, `"$(which sed)" -i`) and program words built at
    run time; aliases and shell functions defined earlier;
  - interpreter code that writes through other APIs (subprocess/os.system strings,
    zipfile, sqlite, os.remove, fs.rmSync, `os.chdir` before a relative open, `perl -i`
    set via $^I);
  - git forms outside the list above (merge, pull, rebase, cherry-pick, revert, stash
    push, worktree), `cd` into a directory that fails, `case` patterns mis-read as
    subshells, a symlink into the project created under `.workflow/` in the same call;
  - PowerShell: other cmdlets that write (Export-*, Set-ItemProperty, .NET types other
    than [IO.File]), `cmd /c`, script files, `iex $var`, `-EncodedCommand` (refused as
    unreadable), PowerShell that bash starts other than through `pwsh -Command`.
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


def absolute(text, cwd, lexical=True):
    """Absolute path for a literal word, or None when it cannot be known.

    `lexical=False` keeps `..` for realpath: the kernel resolves a symlink before the `..`
    that follows it (a file operand), while `cd` without -P folds `..` first."""
    if "\x00" in text:   # an expansion placeholder
        return None
    norm = os.path.normpath if lexical else (lambda p: p)
    if text.startswith("~"):
        head = text.split("/", 1)[0]
        if head != "~":
            return None
        text = os.path.expanduser(text)
    if os.name == "nt":
        m = re.match(r"^/([A-Za-z])(/.*)?$", text)
        if m:   # MSYS form /c/...
            text = "%s:%s" % (m.group(1).upper(), (m.group(2) or "/"))
        if re.match(r"^[A-Za-z]:(?![\\/])", text):
            # drive-relative (`D:`, `C:x`; also what bash leaves of an unquoted `C:\a\b`):
            # it depends on that drive's own current directory, which is not tracked
            return None
        if os.path.isabs(text) or _drive_path(text):
            return norm(text)
    else:
        if _drive_path(text):
            return ntpath.normpath(text)   # a Windows path is never inside a POSIX workspace
        if text.startswith("/"):
            return norm(text)
    if cwd is None:
        return None
    return norm(os.path.join(cwd, text))


DEFAULT_ALLOWED_DIRS = [".workflow"]


def _allowed_rel(d):
    """A workspace-relative allowed dir, or None (absolute, `..`, the root itself, not a string)."""
    if not isinstance(d, str) or not d.strip() or _drive_path(d) or d.startswith(("/", "\\")):
        return None
    parts = [p for p in re.split(r"[\\/]+", d) if p not in ("", ".")]
    if not parts or ".." in parts:
        return None
    return parts


class Scope(object):
    def __init__(self, workspace, allowed_dirs=None):
        self.ws = os.path.normpath(os.path.abspath(workspace))
        self.ws_real = os.path.realpath(self.ws)
        dirs = DEFAULT_ALLOWED_DIRS if allowed_dirs is None else allowed_dirs
        self.allowed = [os.path.normpath(os.path.join(self.ws_real, *parts))
                        for parts in map(_allowed_rel, dirs) if parts]

    def project_path(self, abs_path):
        if abs_path is None:
            return True
        if _drive_path(abs_path) and os.name != "nt":
            return False
        real = os.path.realpath(abs_path)
        if not (_inside(self.ws, abs_path) or _inside(self.ws_real, real)):
            return False
        for allowed in self.allowed:
            if _inside(allowed, real) and _fold(os.path.normpath(real)) != _fold(allowed):
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
        return self.project_path(absolute(text, cwd, lexical=False))

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


def _branch_create_only(sub, args):
    """`git checkout|switch` that leaves the work tree alone: only creating a branch at HEAD
    (`checkout -b|-B|--orphan NAME`, `switch -c|-C NAME`, no start point) or no operand at all,
    with quiet/track options only. Every other form (a branch switch, a path, `.`, a rev plus
    a path, -f, -p, -m, --pathspec-from-file, `switch --orphan`) rewrites files: a write."""
    create = ("-b", "-B", "--orphan") if sub == "checkout" else ("-c", "-C", "--create", "--force-create")
    harmless = {"-q", "--quiet", "-t", "--track", "--no-track", "--progress", "--no-progress",
                "--guess", "--no-guess", "--detach", "-d"}
    named = 0
    i = 0
    while i < len(args):
        a = args[i]
        t = a.text.split("=", 1)[0] if a.text.startswith("--") else a.text
        if a.unresolvable or not t.startswith("-") or t == "-" or t == "--":
            return False
        if t in create and i + 1 < len(args) and "=" not in a.text:
            named += 1
            i += 2
            continue
        if t not in harmless:
            return False
        i += 1
    return named <= 1


WRAPPERS = {"command", "builtin", "exec", "nohup", "time", "nice", "timeout", "stdbuf", "sudo", "doas",
            "env", "xargs", "chronic", "ionice", "caffeinate"}
# (program, subcommand) -> (options taking a value, options naming the working dir, shell-string options)
RUNNERS = {
    ("uv", "run"): ({"--with", "--with-editable", "--with-requirements", "--python", "-p", "--project", "--package",
                     "--extra", "--group", "--only-group", "--no-group", "--env-file", "--index", "--default-index",
                     "-i", "--index-url", "--extra-index-url", "--find-links", "-f", "--directory", "--config-file",
                     "--cache-dir", "--color", "--python-preference"}, {"--directory"}, set()),
    ("poetry", "run"): ({"-C", "--directory", "-P", "--project"}, {"-C", "--directory"}, set()),
    ("pipenv", "run"): (set(), set(), set()),
    ("npx", None): ({"-p", "--package", "-c", "--call", "-w", "--workspace"}, set(), {"-c", "--call"}),
    ("npm", "exec"): ({"-p", "--package", "-c", "--call", "-w", "--workspace"}, set(), {"-c", "--call"}),
    ("pnpm", "exec"): ({"-C", "--dir", "--filter", "-F", "--reporter"}, {"-C", "--dir"}, {"-c", "--shell-mode"}),
    ("pnpm", "dlx"): ({"-C", "--dir", "--package", "--reporter"}, {"-C", "--dir"}, {"-c", "--shell-mode"}),
    ("yarn", "exec"): ({"--cwd"}, {"--cwd"}, set()),
    ("bunx", None): ({"-p", "--package"}, set(), set()),
    ("bun", "x"): ({"-p", "--package", "--cwd"}, {"--cwd"}, set()),
    ("bun", "run"): ({"--cwd", "--env-file", "--config", "-c"}, {"--cwd"}, set()),
}


def _eval_args(args):
    """`deno eval [opts] CODE` as node-style `-e CODE`."""
    _, ops = _positionals(args, long_with_arg=("--import-map", "--config", "--ext", "--location"))
    return [lit("-e"), ops[0]] if ops else []


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
        if any(w.text.startswith("-") and "P" in w.text[1:] and not w.text.startswith("--") for w in words[1:]):
            raw = absolute(a.text, cwd, lexical=False)   # cd -P: symlinks first, then `..`
            return None if raw is None else os.path.realpath(raw)
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
        if prog in ("pwsh", "powershell"):
            k = 0
            while k < len(args):
                a = args[k]
                t = a.text.lower()
                if a.unresolvable or not t.startswith("-"):
                    return   # a script file: a blind spot
                if t in ("-e", "-ec") or (len(t) > 2 and "-encodedcommand".startswith(t)):
                    raise Found("unreadable", "<encoded command>")
                if t == "-c" or (len(t) > 2 and "-command".startswith(t)):
                    return self.ps_text(" ".join(w.text for w in args[k + 1:]), cwd, depth + 1)
                if t in ("-file", "-f"):
                    return
                k += 2 if t in ("-executionpolicy", "-ex", "-ep", "-workingdirectory", "-wd", "-outputformat",
                                "-of", "-inputformat", "-if", "-windowstyle", "-w", "-configurationname",
                                "-settingsfile") else 1
            return
        runner = self.runner_inner(prog, args)
        if runner is not None:
            return self.runner(prog, runner, cwd, depth, stdin)
        if prog == "deno" and args and args[0].text in ("run", "eval"):
            return self.node(args[1:] if args[0].text == "run" else _eval_args(args[1:]), cwd, stdin)
        if prog in ("node", "nodejs", "deno", "bun", "tsx", "ts-node"):
            return self.node(args, cwd, stdin)
        if prog in ("rm", "rmdir", "unlink", "shred", "trash"):
            _, ops = _positionals(args, with_arg="ns" if prog == "shred" else "",
                                  long_with_arg=("--iterations", "--size", "--random-source"))
            for w in ops:
                _hit(s, "delete", w, cwd)
            return
        if prog in ("sort", "curl", "wget", "tar", "unzip", "awk", "gawk"):
            return self.fetch_like(prog, args, cwd)
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

    def runner_inner(self, prog, args):
        """Project runners (`uv run`, `npx`, ...): (inner words, cwd option word, shell text) or None."""
        spec = None
        i = 0
        for key, val in RUNNERS.items():
            if key[0] != prog:
                continue
            j = 0
            while key[1] and j < len(args) and args[j].text.startswith("-") and not args[j].unresolvable:
                j += 2 if args[j].text in val[0] else 1   # global options before the subcommand
            if key[1] is None or (j < len(args) and args[j].text == key[1]):
                spec, i = val, (j + 1 if key[1] else 0)
                break
        if spec is None:
            return None
        with_arg, cwd_opts, shell_opts = spec
        where = None
        while i < len(args):
            a = args[i]
            t = a.text
            if a.unresolvable or not t.startswith("-") or t == "-":
                break
            if t == "--":
                i += 1
                break
            name, eq = (t.split("=", 1) + [None])[:2] if t.startswith("--") else (t, None)
            val = lit(eq) if eq is not None else (args[i + 1] if name in with_arg and i + 1 < len(args) else None)
            if name in shell_opts:
                if val is not None or name not in with_arg:   # npx -c 'cmd' | pnpm exec -c cmd...
                    body = val.text if val is not None else " ".join(w.text for w in args[i + 1:])
                    return [], where, body
            if name in cwd_opts:
                where = val if val is not None else unknown()
            i += 2 if (name in with_arg and eq is None) else 1
        return args[i:], where, None

    def runner(self, prog, spec, cwd, depth, stdin):
        inner, where, body = spec
        if where is not None:
            cwd = None if where.unresolvable else absolute(where.text, cwd)
        if body is not None:
            return self.text(body, cwd, depth + 1)
        if inner:
            self.run(inner, cwd, depth, stdin)

    def _hit_dir(self, kind, word, cwd):
        """A tool that writes files of its own naming into a directory (curl -O, wget, tar x, unzip)."""
        if word is None:
            d = cwd
        elif word.unresolvable:
            raise Found(kind, _show(word))
        else:
            d = absolute(word.text, cwd, lexical=False)
        if d is None or self.scope.project_path(os.path.join(d, "file")):
            raise Found(kind, _show(word) if word is not None else "<working dir>")

    def fetch_like(self, prog, args, cwd):
        s = self.scope
        if prog == "sort":
            opts, _ = _positionals(args, with_arg="oktSTy", long_with_arg=("--output", "--key", "--field-separator",
                                                                           "--buffer-size", "--temporary-directory"))
            for o in _opt(opts, "-o", "--output"):
                _hit(s, "sort", o if o is not None else unknown(), cwd)
            return
        if prog == "curl":
            opts, _ = _positionals(args, with_arg="AbcdDeEFHKmoPQrTuUwxXyYzC",
                                   long_with_arg=("--output", "--output-dir", "--data", "--header", "--user",
                                                  "--request", "--url", "--config", "--cookie", "--cookie-jar",
                                                  "--dump-header", "--form", "--user-agent", "--referer"))
            for o in _opt(opts, "-o", "--output"):
                if o is None or o.text != "-":
                    _hit(s, "curl", o if o is not None else unknown(), cwd)
            if _opt(opts, "-O", "--remote-name", "--remote-name-all", "-J", "--remote-header-name"):
                out = _opt(opts, "--output-dir")
                self._hit_dir("curl", out[-1] if out and out[-1] is not None else None, cwd)
            return
        if prog == "wget":
            opts, _ = _positionals(args, with_arg="OoaPeitTwQUDIXABlRYUH",
                                   long_with_arg=("--output-document", "--directory-prefix", "--output-file",
                                                  "--append-output", "--input-file", "--user-agent", "--header"))
            if _opt(opts, "--spider"):
                return
            docs = _opt(opts, "-O", "--output-document")
            if docs:
                if docs[-1] is None or docs[-1].text != "-":
                    _hit(s, "wget", docs[-1] if docs[-1] is not None else unknown(), cwd)
                return
            pre = _opt(opts, "-P", "--directory-prefix")
            self._hit_dir("wget", pre[-1] if pre and pre[-1] is not None else None, cwd)
            return
        if prog == "tar":
            first = args[0].text if args and not args[0].unresolvable else ""
            old = first and not first.startswith("-") and re.match(r"^[A-Za-z]+$", first)
            opts, _ = _positionals(args[1:] if old else args, with_arg="fCbHKLNTVXg",
                                   long_with_arg=("--file", "--directory", "--exclude", "--files-from"))
            extract = (old and "x" in first) or _opt(opts, "-x", "--extract", "--get")
            if not extract:
                return
            d = _opt(opts, "-C", "--directory")
            self._hit_dir("tar", (d[-1] if d[-1] is not None else unknown()) if d else None, cwd)
            return
        if prog == "unzip":
            opts, _ = _positionals(args, with_arg="dxP")
            if _opt(opts, "-l", "-t", "-p", "-v", "-Z", "-c", "-z"):
                return
            d = _opt(opts, "-d")
            self._hit_dir("unzip", (d[-1] if d[-1] is not None else unknown()) if d else None, cwd)
            return
        # awk / gawk -i inplace (also --include=inplace): the file operands are rewritten
        opts, ops = _positionals(args, with_arg="fvFilEe", long_with_arg=("--file", "--assign", "--field-separator",
                                                                         "--include", "--load", "--source"))
        libs = [o.text for o in _opt(opts, "-i", "--include") if o is not None]
        if not any(lib in ("inplace", "inplace.awk") for lib in libs):
            return
        if not _opt(opts, "-f", "--file", "-e", "--source", "-E") and ops:
            ops = ops[1:]   # the program text
        for w in ops:
            if not re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", w.text):
                _hit(s, "awk-i", w, cwd)

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
        # option clusters (`-euo pipefail`, `+o x`): each o/O takes the next word; with -c
        # the first operand after the options is the command string
        code = False
        i = 0
        while i < len(args):
            t = args[i].text
            if args[i].unresolvable:
                return
            if t in ("-", "--"):
                i += 1
                break
            if t[:1] in ("-", "+") and len(t) > 1 and not t.startswith("--"):
                code = code or (t[0] == "-" and "c" in t[1:])
                i += 1 + t[1:].count("o") + t[1:].count("O")
                continue
            if t.startswith("--"):
                i += 2 if t in ("--rcfile", "--init-file") else 1
                continue
            break
        if code:
            if i < len(args):
                self.text(args[i].text, cwd, depth + 1)
            return
        if i < len(args):
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
        if sub in ("rm", "mv"):
            _, ops = _positionals(args[i + 1:], long_with_arg=("--pathspec-from-file",))
            kind = "delete" if sub == "rm" else "rename"
            if not ops:
                raise Found(kind, "git " + sub)
            for w in ops:
                _hit(self.scope, kind, w, where)
            return
        if sub == "clean" and not (set(rest) & {"-n", "--dry-run"}) and self.scope.dir_in_ws(where):
            raise Found("delete", "git clean")
        if sub == "apply":
            write = not (set(rest) & {"--check", "--stat", "--numstat", "--summary"}) or "--apply" in rest
        elif sub in ("am", "restore"):
            write = not (set(rest) & {"--abort", "--show-current-patch", "--quit"})
        elif sub in ("checkout", "switch"):
            write = not _branch_create_only(sub, args[i + 1:])
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

    # -- PowerShell (the foreman's `powershell` tool; `pwsh -c` from bash)
    def ps_text(self, text, cwd, depth):
        if depth > MAX_DEPTH:
            raise Found("unreadable", "<nested too deep>")
        s = self.scope
        start = cwd   # .NET's current directory: [IO.File] relative paths resolve against it
        for m in IO_FILE.finditer(text):
            meth = m.group(1).lower()
            if meth.startswith(("read", "exists", "get", "openread", "opentext")):
                continue
            args = _split_args(text, m.end())
            idx = [1] if meth == "copy" else ([0, 1] if meth in ("move", "replace") else [0])
            for k in idx:
                v = _str_value(args[k], "powershell") if k < len(args) else None
                if v is None or s.target(v, start):
                    raise Found("io-file", v or "<write in code>")
        units, subst = ps_units(text)
        for body in subst:
            self.ps_text(body, cwd, depth + 1)
        for u in units:
            for op, word in u.redirs:
                if word.text != "$null":
                    _hit(s, "redirect", word, cwd)
            words = list(u.words)
            while words and not words[0].unresolvable and words[0].text.lower() in PS_KEYWORDS:
                words.pop(0)
            if len(words) > 1 and words[0].unresolvable and re.match(r"^[-+*/]?=$", words[1].text):
                words = words[2:]   # $x = <command>
            if not words or words[0].unresolvable:
                continue
            verb = re.split(r"\\", words[0].text)[-1].lower()
            if verb.endswith(".exe"):
                verb = verb[:-4]
            verb = PS_ALIASES.get(verb, verb)
            if verb == "function" or verb == "filter":
                continue
            params, pos = _ps_params(words[1:])
            for k in ("outfile", "destinationpath"):
                if k in params:
                    _hit(s, k, params[k] if params[k] is not None else unknown(), cwd)
            if verb in ("set-location", "push-location"):
                t = params.get("path") or params.get("literalpath") or (pos[0] if pos else None)
                if t is not None:
                    cwd = None if t.unresolvable or t.text == "-" else absolute(t.text, cwd)
                continue
            if verb == "pop-location":
                cwd = None
                continue
            if verb == "invoke-expression":
                code = params.get("command") or (pos[0] if pos else None)
                if code is not None and not code.unresolvable:
                    self.ps_text(code.text, cwd, depth + 1)
                continue
            if verb in PS_WRITERS:
                self.ps_writer(verb, params, pos, cwd)
                continue
            self.run(words, cwd, depth, None)

    def ps_writer(self, verb, params, pos, cwd):
        s = self.scope
        idx, path_is_target = PS_WRITERS[verb]
        targets = []
        if path_is_target:
            targets += [params[k] for k in ("path", "literalpath", "filepath") if k in params]
        targets += pos if idx == "all" else [pos[k] for k in idx if k < len(pos)]
        if verb in ("copy-item", "move-item"):
            dest = params.get("destination", "missing")
            if dest != "missing":
                targets.append(dest)
            elif len(pos) < 2:
                targets.append(lit("."))   # no destination: the current location
        if verb == "new-item" and "name" in params:
            base = targets[0] if targets else lit(".")
            name = params["name"]
            if name is None or name.unresolvable or base is None or base.unresolvable:
                targets = [unknown()]
            else:
                targets = [lit(base.text.rstrip("\\/") + "/" + name.text)]
        if verb == "tee-object" and not targets and "variable" in params:
            return
        if not targets:
            raise Found(verb, "<pipeline input>")
        for t in targets:
            for item in _ps_split(t if t is not None else unknown()):
                _hit(s, verb, item, cwd)

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
    r"fs\.(?:promises\.)?write\w*|Deno\.write(?:Text)?File(?:Sync)?|Bun\.write|File\.write|IO\.write)\s*\(")
CALLS_TWO = re.compile(   # (source, destination): the destination is written, a moved source vanishes
    r"(?<![A-Za-z0-9_])(shutil\.(?:copy\w*|move)|os\.(?:rename|replace|link|symlink)|"
    r"(?:fs\.)?(?:copyFileSync|copyFile|renameSync|rename|cpSync|cp))\s*\(")
PATH_WRITE = re.compile(r"""(?:Path|PurePath)\(\s*([rRbBuU]{0,2}(?:"[^"\\]*"|'[^'\\]*'))\s*\)\s*\.\s*write_(?:text|bytes)\b""")
BARE_WRITE = re.compile(r"\.\s*write_(?:text|bytes)\s*\(|\.\s*touch\s*\(")
OPEN = re.compile(r"(?<![A-Za-z0-9_])(?:(os|io|codecs|fs|File|IO|Kernel)\s*\.\s*)?(open|sysopen|openSync)\b\s*(\(?)")


def _str_value(arg, lang):
    """The literal value of a plain string argument, or None."""
    if lang == "powershell":
        m = re.match(r"""^\s*('(?:[^']|'')*'|"(?:[^"`$]|`.)*")\s*$""", arg, re.S)
        if not m:
            return None
        body = m.group(1)
        return body[1:-1].replace("''", "'") if body[0] == "'" else re.sub(r"`(.)", r"\1", body[1:-1])
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
        kws, pos = {}, []
        for a in args:
            kw = re.match(r"^\s*([A-Za-z_]\w*)\s*(?:=(?!=)|:)\s*(.*)$", a, re.S)
            if kw:
                kws.setdefault(kw.group(1), kw.group(2))
            else:
                pos.append(a)
        mode_kw = kws.get("mode", kws.get("flags"))
        if m.group(1) is None and re.search(r"\.\s*$", text[:m.start(2)]):
            # a method call (`p.open('w')`, `Path(x).open(mode='w')`): the mode comes first and the
            # target is the object, which is not resolved
            mv = _str_value(mode_kw, lang) if mode_kw is not None else (_str_value(pos[0], lang) if pos else None)
            if mode_kw is not None and mv is None:
                out.append(None)
                continue
            if mv is not None and MODE.match(mv) and re.search(r"[wax+]", mv):
                out.append(None)
                continue
        path_arg = kws.get("file", kws.get("path", pos[0] if pos else None))
        args = [path_arg if path_arg is not None else ""] + pos[1:]
        mode_arg = mode_kw if mode_kw is not None else (pos[1] if len(pos) >= 2 else None)
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


# --------------------------------------------------------------------------- PowerShell

class PsUnit(object):
    def __init__(self):
        self.words = []
        self.redirs = []   # (op, Word)


def _ps_quote_end(text, i, q):
    """Index past the closing quote of a PowerShell string opened at i-1."""
    n = len(text)
    while i < n:
        c = text[i]
        if q == "'" and c == "'":
            if text.startswith("''", i):
                i += 2
                continue
            return i + 1
        if q == '"':
            if c == "`":
                i += 2
                continue
            if c == '"':
                if text.startswith('""', i):
                    i += 2
                    continue
                return i + 1
            if text.startswith("$(", i):
                i = _ps_paren_end(text, i + 2)
                continue
        i += 1
    raise Unreadable("quote")


def _ps_paren_end(text, i):
    depth = 1
    n = len(text)
    while i < n:
        c = text[i]
        if c == "`":
            i += 2
            continue
        if c in "'\"":
            i = _ps_quote_end(text, i + 1, c)
            continue
        if c == "(":
            depth += 1
        elif c == ")":
            depth -= 1
            if depth == 0:
                return i + 1
        i += 1
    raise Unreadable("unbalanced (")


def ps_units(text):
    """Simple commands of a PowerShell string: (units, `$(..)` bodies). Script blocks, parens,
    pipelines and statement separators all split units; nothing is executed or expanded."""
    units, subst = [], []
    cur = PsUnit()
    i, n = 0, len(text)

    def finish():
        nonlocal cur
        if cur.words or cur.redirs:
            units.append(cur)
        cur = PsUnit()

    def word_at(j):
        w = Word()
        started = False
        while j < n:
            c = text[j]
            if c in " \t\r\n;|{}()<>&" or (c == "#" and not started):
                break
            started = True
            if c == "`":
                w.text += text[j + 1:j + 2]
                w.quoted = True
                j += 2
            elif c == "'":
                end = _ps_quote_end(text, j + 1, "'")
                w.text += text[j + 1:end - 1].replace("''", "'")
                w.quoted = True
                j = end
            elif c == '"':
                end = _ps_quote_end(text, j + 1, '"')
                body = text[j + 1:end - 1]
                for m in re.finditer(r"\$\(", body):
                    subst.append(body[m.end():_ps_paren_end(body, m.end()) - 1])
                if "$" in body:
                    w.dynamic = True
                w.text += re.sub(r"`(.)", r"\1", body)
                w.quoted = True
                j = end
            elif c == "$":
                if text.startswith("$(", j):
                    end = _ps_paren_end(text, j + 2)
                    subst.append(text[j + 2:end - 1])
                    j = end
                    w.text += "\x00"
                    w.dynamic = True
                    continue
                m = re.compile(r"\$(null|true|false)\b", re.I).match(text, j)
                if m and not w.text:
                    w.text += m.group(0).lower()
                    j = m.end()
                    continue
                w.text += "\x00"
                w.dynamic = True
                m = re.compile(r"\$(\{[^}]*\}|[\w:?^$]+)").match(text, j)
                j = m.end() if m else j + 1
            else:
                if c in "*?[":
                    w.glob = True
                w.text += c
                j += 1
        return (w if started else None), j

    while i < n:
        c = text[i]
        if c in " \t\r":
            i += 1
            continue
        if text.startswith("<#", i):
            j = text.find("#>", i + 2)
            i = n if j < 0 else j + 2
            continue
        if c == "#":
            j = text.find("\n", i)
            i = n if j < 0 else j
            continue
        if text.startswith("@'", i) or text.startswith('@"', i):
            q = text[i + 1]
            m = re.compile(r"\r?\n%s@" % re.escape(q)).search(text, i + 2)
            if m is None:
                raise Unreadable("here-string")
            w = lit(text[i + 2:m.start()])
            w.dynamic = q == '"' and "$" in w.text
            cur.words.append(w)
            i = m.end()
            continue
        m = re.compile(r"([0-9*])?(>>|>)(&[0-9])?").match(text, i)
        if m:
            i = m.end()
            if m.group(3):
                continue   # stream merge 2>&1
            while i < n and text[i] in " \t":
                i += 1
            target, i = word_at(i)
            if target is None:
                raise Unreadable("redirection without target")
            cur.redirs.append((m.group(2), target))
            continue
        if c == "<":
            i += 1   # input redirection is not supported by PowerShell; harmless
            continue
        if c in "\n;|{}()" or text.startswith("&&", i):
            finish()
            i += 2 if text.startswith(("&&", "||"), i) else 1
            continue
        if c == "&":
            if cur.words:
                finish()   # a background job
            i += 1          # else the call operator
            continue
        if c == "@" and text[i + 1:i + 2] in ("(", "{"):
            finish()
            i += 2
            continue
        w, i = word_at(i)
        if w is None:
            i += 1
            continue
        if not cur.words and not w.quoted and w.text == ".":
            continue   # dot-sourcing operator
        cur.words.append(w)
    finish()
    return units, subst


# canonical cmdlet -> (kind, positional indexes that are targets or "all", whether -Path is a target)
PS_WRITERS = {
    "set-content": ([0], True), "add-content": ([0], True), "clear-content": ("all", True),
    "out-file": ([0], True), "tee-object": ([0], True), "new-item": ([0], True),
    "copy-item": ([1], False), "move-item": ([0, 1], True), "remove-item": ("all", True),
    "rename-item": ([0], True),
}
PS_ALIASES = {"sc": "set-content", "ac": "add-content", "clc": "clear-content", "tee": "tee-object",
              "ni": "new-item", "cp": "copy-item", "copy": "copy-item", "cpi": "copy-item",
              "mv": "move-item", "move": "move-item", "mi": "move-item", "ri": "remove-item", "rm": "remove-item",
              "del": "remove-item", "erase": "remove-item", "rd": "remove-item", "rmdir": "remove-item",
              "rni": "rename-item", "ren": "rename-item",
              "sl": "set-location", "cd": "set-location", "chdir": "set-location", "pushd": "push-location",
              "popd": "pop-location", "iex": "invoke-expression"}
PS_VALUE_PARAMS = ("path", "literalpath", "filepath", "destination", "value", "encoding", "name", "newname",
                   "itemtype", "filter", "include", "exclude", "credential", "stream", "delimiter", "width",
                   "inputobject", "type", "target", "variable", "outfile", "destinationpath", "uri", "method",
                   "body", "headers", "command", "stackname")
PS_KEYWORDS = {"if", "elseif", "else", "foreach", "for", "while", "do", "switch", "try", "catch", "finally",
               "until", "return", "trap", "param", "begin", "process", "end", "in", "throw", "exit"}
IO_FILE = re.compile(r"\[\s*(?:System\s*\.\s*)?IO\s*\.\s*File\s*\]\s*::\s*(\w+)\s*\(", re.I)


def _ps_params(words):
    """PowerShell parameters ({canonical lower name: Word or None}) and positionals."""
    params, pos = {}, []
    i = 0
    while i < len(words):
        w = words[i]
        if not w.quoted and not w.unresolvable and re.match(r"^-[A-Za-z]", w.text):
            name, _, val = w.text[1:].partition(":")
            name = name.lower()
            cands = [p for p in PS_VALUE_PARAMS if p.startswith(name)]
            canon = name if name in PS_VALUE_PARAMS else (cands[0] if cands else name)
            if val:
                params[canon] = lit(val)
            elif cands and i + 1 < len(words):
                params[canon] = words[i + 1]
                i += 1
            else:
                params.setdefault(canon, None)
        else:
            pos.append(w)
        i += 1
    return params, pos


def _ps_split(word):
    """`a,b` (a PowerShell array argument) -> its items."""
    if word.unresolvable or "," not in word.text:
        return [word]
    return [lit(t) for t in word.text.split(",") if t]


# --------------------------------------------------------------------------- entry

def decide(command, cwd, workspace=None, shell="bash", allowed_dirs=None):
    """None (no project write) or (kind, target). `shell`: "bash" or "powershell".
    `allowed_dirs`: workspace-relative dirs that stay writable (None = [".workflow"])."""
    scope = Scope(workspace or cwd, allowed_dirs)
    try:
        a = Analyzer(scope)
        (a.ps_text if shell == "powershell" else a.text)(command, os.path.normpath(os.path.abspath(cwd)), 0)
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
    allowed = payload.get("allowed_dirs")
    if not isinstance(allowed, list):
        allowed = None
    hit = decide(command, cwd, ws, "powershell" if payload.get("shell") == "powershell" else "bash", allowed)
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
