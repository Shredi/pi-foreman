#!/usr/bin/env python3
"""pi-foreman shell facts (stdlib, Python 3.9+): the write surfaces of a shell command line.

Lexes the command with the git guard's Lexer (scripts/git_guard.py: words, redirects with fd/op/target, heredocs,
here-strings, substitutions, groups; `sh -c`, stdin scripts, `eval` and command-valued env vars nested up to
MAX_DEPTH) and prints ONE JSON line of facts. It decides nothing: the adapter (ruling.ts selfRulingRefusal) does.

    {"writes": [{"kind": "redirect", "path": "/abs/x" | null, "dir": "/abs" | null, "name": "x" | null,
                 "glob": false, "cwd": "/abs" | null}, ...],
     "links": false, "error": null}

A write is a redirect target (any fd/op), a tee/cp/mv/install/ln/rsync destination (and their sources: an alias or a
move of the file), dd `of=`, `sed -i` operands and sed `w` files, truncate/touch operands, sort/uniq/curl/wget outputs,
`--output=` values, PowerShell write cmdlets, interpreter code writes (shell_write_guard.code_writes), and a literal
ruling-named argument of a program that is not a known reader (`node w.js <file>`). `path`/`dir`/`name` are null when
the shell computes them and the same-line variable grammar (shell_write_guard.grammar_statements) cannot resolve them;
`cwd` is the directory tracked through cd/pushd/Set-Location (null once unsure). `links` is true when the line creates
a symlink or hard link (ln, mklink, New-Item -ItemType SymbolicLink, `symlink`/`link` in interpreter code).
`error` is set when the line cannot be read; the adapter then fails closed.

Input on stdin: {"command": str, "cwd": str, "shell": "bash" | "powershell", "scratch_dir": str | null}.
`$FOREMAN_SCRATCH` resolves to scratch_dir only while the line never assigns it. Exit 0; exit 2 on an internal error.
"""
from __future__ import annotations

import json
import os
import posixpath
import re
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import git_guard as gg  # noqa: E402
import shell_write_guard as swg  # noqa: E402

WRITE_OPS = (">", ">>", ">|", "&>", "&>>", "<>")
CD = {"cd", "pushd", "chdir", "set-location", "sl", "push-location"}
UNSURE_CD = {"popd", "pop-location"}
WRAPPERS = {"command", "builtin", "exec", "nohup", "time", "nice", "ionice", "setsid", "stdbuf", "sudo", "doas",
            "caffeinate", "unbuffer", "chronic", "timeout", "flock", "xargs", "env"}
WRAPPER_ARGFUL = {"-n", "-u", "-g", "-C", "-D", "-a", "-f", "-o", "-k", "-s", "-c", "-t", "-w", "-E", "-I", "-L", "-P",
                  "--chdir", "--user", "--group", "--adjustment", "--output", "--signal", "--kill-after", "--format"}
COPIERS = {"cp", "mv", "install", "ln", "rsync", "copy-item", "cpi", "copy", "move-item", "mi", "move", "link"}
LINKERS = {"ln", "mklink", "link"}
PS_WRITERS = {"set-content", "sc", "add-content", "ac", "out-file", "tee-object", "new-item", "ni", "rename-item", "ren",
              "rni", "clear-content", "clc", "export-csv", "export-clixml"}
READERS = {"cat", "head", "tail", "less", "more", "grep", "egrep", "fgrep", "rg", "wc", "stat", "file", "nl", "realpath",
           "readlink", "cut", "tr", "ls", "diff", "cmp", "md5sum", "md5", "shasum", "sha256sum", "sha1sum", "jq", "echo",
           "printf", "test", "[", "[[", "basename", "dirname", "get-content", "gc", "type", "select-string", "sls",
           "get-item", "gi", "get-childitem", "gci", "dir", "test-path", "resolve-path", "true", "false", "column",
           "fold", "od", "xxd", "hexdump", "strings", "base64", "sha512sum", "b2sum", "cksum", "du", "df", "tree"}
EXEC_ENV = gg.EXEC_ENV | {"LESSOPEN", "LESSCLOSE", "GIT_SEQUENCE_EDITOR", "MANPAGER"}
LANGS = (("python", re.compile(r"^(python[0-9.]*|pythonw|py)$")), ("node", re.compile(r"^(node|nodejs|deno|bun)$")),
         ("perl", re.compile(r"^perl[0-9.]*$")), ("ruby", re.compile(r"^ruby$")))
INLINE = {"-c", "-e", "-E", "--eval", "-p", "--print", "-r"}
LINK_CODE = re.compile(r"\b(?:sym)?link(?:Sync|_to)?\s*\(|\bhardlink_to\b|\bsymlink\b")
RULING = re.compile(r"^ruling(?:-\d{1,6})?\.md$")
RULING_IN = re.compile(r"(?<![A-Za-z0-9_-])ruling(?:-\d{1,6})?\.md(?![A-Za-z0-9_])")
SED_LONG = {"--expression", "--file", "--in-place", "--quiet", "--silent", "--null-data", "--regexp-extended",
            "--separate", "--sandbox", "--debug", "--posix", "--line-length", "--zero-terminated",
            "--follow-symlinks", "--unbuffered", "--help", "--version"}
FIND_ACTION = re.compile(r"^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$")
COMPUTED = gg.Word("\0", dynamic=True, raw="$(xargs)")
UNKNOWN_SCRATCH = os.path.join(tempfile.gettempdir(), "pi-foreman-scratch-unknown")
_REF = re.compile(r"\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))")
_PLAIN = re.compile(r"(?:[A-Za-z0-9/._=:@%+,~-]|\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$[A-Za-z_][A-Za-z0-9_]*)+")


def _pm(p):
    """The path module for `p`: posixpath for a posix-rooted path (`/h/r` in a bash line, `cd /h`), else os.path. On POSIX both
    are posixpath (no change); on win32 a posix-rooted target stays posix instead of taking the drive and backslashes of the
    native cwd, and native (drive) paths keep ntpath. Consumers resolve both forms the same way (path.resolve / realpath)."""
    return posixpath if p.startswith("/") and not p.startswith("//") else os.path


def _abs(p):
    return _pm(p).isabs(p)


def _resolve(base, p):
    """`p` made absolute against `base` (the tracked cwd) with the module of whichever of them roots the result."""
    if _abs(p):
        return _pm(p).normpath(p)
    m = _pm(base)
    return m.normpath(m.join(base, p))


class State(object):
    def __init__(self, cwd, vars_, flavor):
        self.cwd = cwd
        self.vars = vars_
        self.flavor = flavor
        self.writes = []
        self.links = False
        self.cdpath = False


def line_vars(text, scratch):
    """Same-line variables: the closed grammar of shell_write_guard (all or nothing), plus the harness
    `$FOREMAN_SCRATCH` while the line never names it other than as a `$` reference."""
    out = {}
    stmts = swg.grammar_statements(swg.grammar_header(text))
    if stmts:
        seen = set()
        for st in stmts:
            if st is None:
                continue
            name, raw = st
            value = swg.grammar_value(raw, None, scratch or UNKNOWN_SCRATCH)
            if name in seen or value is None:
                out[name] = None  # assigned twice or not certain: unresolved
            else:
                out[name] = value
            seen.add(name)
    if all(text[max(0, m.start() - 1):m.start()] == "$" or text[max(0, m.start() - 2):m.start()] == "${"
           for m in re.finditer("FOREMAN_SCRATCH", text)):
        out["FOREMAN_SCRATCH"] = scratch or UNKNOWN_SCRATCH
    return out


def value(word, st):
    """Static text of a word, or None when the shell computes it and the bound variables do not resolve it."""
    if "\0" not in word.text:
        return word.text
    raw = word.raw
    if "'" in raw or "\\" in raw:
        return None
    raw = raw.replace('"', "")
    if st.flavor != "bash" or not _PLAIN.fullmatch(raw):
        return None
    out = []
    pos = 0
    for m in _REF.finditer(raw):
        v = st.vars.get(m.group(1) or m.group(2))
        if v is None:
            return None
        out.append(raw[pos:m.start()])
        out.append(v)
        pos = m.end()
    out.append(raw[pos:])
    return "".join(out)


def add(st, kind, text, glob=False, cwd="keep", partial=None):
    """Record a write target. `text` None: fully computed; `partial` the raw text with NULs for computed parts."""
    base = st.cwd if cwd == "keep" else cwd
    rec = {"kind": kind, "path": None, "dir": None, "name": None, "glob": bool(glob), "cwd": base}
    if text is None and partial is not None:
        head, _, tail = partial.replace("\\", "/").rpartition("/")
        if "\0" not in tail and tail:
            rec["name"] = tail
        if "\0" not in head and (head or partial.startswith("/")):
            d = head or "/"
            rec["dir"] = _resolve(base, d) if (_abs(d) or base) else None
    elif text is not None:
        if text.startswith("~"):
            text = os.path.expanduser(text)
        if _abs(text) or base:
            p = _resolve(base, text)
            rec["path"] = p
            rec["dir"] = _pm(p).dirname(p)
            rec["name"] = _pm(p).basename(p) or None
        else:
            rec["name"] = os.path.basename(text.rstrip("/")) or None
    st.writes.append(rec)


_NATIVE_RAW = re.compile(r"^[A-Za-z]:\\")


def native_raw(raw, v, st):
    """win32 bash only: a word written as a native drive path with backslashes (`D:\\x\\h\\r`, quoted or not). Bash reads unquoted
    backslashes as escapes, but a Windows shell or a quoted spelling reaches the native path, so it is ALSO a candidate target
    (fail closed). The quote-stripped raw text, or None when it adds nothing (not win32, an expansion, equal to the value)."""
    if os.path.sep != "\\" or st.flavor != "bash" or not raw:
        return None
    r = raw.replace('"', "").replace("'", "")
    if not _NATIVE_RAW.match(r) or "$" in r or "`" in r or r == v:
        return None
    return r


def add_word(st, kind, word, cwd="keep"):
    v = value(word, st)
    add(st, kind, v, glob=word.glob, cwd=cwd, partial=word.text if v is None else None)
    n = native_raw(word.raw, v, st)
    if n is not None:
        add(st, kind, n, glob=word.glob, cwd=cwd)


def operands(args):
    """Non-option words (after `--` everything)."""
    out, rest = [], False
    for w in args:
        if not rest and w.text == "--":
            rest = True
            continue
        if not rest and w.text.startswith("-") and w.text != "-":
            continue
        out.append(w)
    return out


def walk(text, flavor, st, depth):
    if depth > gg.MAX_DEPTH:
        raise ValueError("nested more than %d levels" % gg.MAX_DEPTH)
    try:
        lx = gg.lex(text, flavor)
    except gg.LexError as exc:
        raise ValueError(str(exc))
    saved = st.cwd
    for sub in lx.subs:  # a substitution runs in a subshell: its cd does not carry over
        walk(sub, flavor, st, depth + 1)
        st.cwd = saved
    for seg in lx.segs:
        segment(seg, flavor, st, depth)


def nested(text, flavor, st, depth):
    saved, fl = st.cwd, st.flavor
    st.flavor = flavor
    walk(text, flavor, st, depth + 1)
    st.cwd, st.flavor = saved, fl


def segment(seg, flavor, st, depth):
    for fd, op, target in seg.redirs:
        if op in WRITE_OPS or (op == ">&" and not re.match(r"^[0-9]+-?$|^-$", target.text)):
            if target.text != "/dev/null":
                add_word(st, "redirect", target)
    words = list(seg.words)
    kw = gg.KEYWORDS[flavor]
    while words:
        w = words[0]
        t = w.text if flavor == "bash" else w.text.lower()
        if "\0" not in w.text and t in kw:
            words.pop(0)
            continue
        if flavor == "bash" and gg.ASSIGN.match(w.text):
            assignment(w, st, depth)
            words.pop(0)
            continue
        break
    command(words, seg, flavor, st, depth)


def assignment(w, st, depth):
    name = w.text.split("=", 1)[0].rstrip("+")
    if name == "CDPATH":
        st.cdpath = True
    if name in EXEC_ENV:
        raw = w.raw.split("=", 1)[1]
        if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in "'\"":
            raw = raw[1:-1]
        nested(raw.lstrip("|"), "bash", st, depth)


def strip_wrapper(name, args, st):
    """Arguments after a wrapper's options; `env -C`/`sudo -D` leave the directory unsure."""
    i = 0
    while i < len(args):
        t = args[i].text
        if t == "--":
            i += 1
            break
        if name == "env" and gg.ASSIGN.match(t):
            assignment(args[i], st, 0)
            i += 1
            continue
        if not t.startswith("-") or t == "-":
            break
        if t in ("-C", "-D", "--chdir") or t.startswith("--chdir="):
            st.cwd = None
        i += 2 if t in WRAPPER_ARGFUL else 1
    rest = args[i:]
    if name == "timeout" and rest:
        rest = rest[1:]
    return rest


def change_dir(args, st, flavor):
    ops = [w for w in args if not (w.text.startswith("-") and w.text not in ("-",))]
    if flavor == "powershell":
        ops = [w for w in args if w.text.lower() not in ("-path", "-literalpath")]
    v = value(ops[0], st) if len(ops) == 1 else None
    if v is None or v in ("-",) or v.startswith("~") or (st.cdpath and not _abs(v)):
        st.cwd = None
    elif _abs(v) or st.cwd is not None:
        st.cwd = _resolve(st.cwd, v)


def copier(name, args, st):
    target_dir = None
    rest = []
    i = 0
    after = False
    while i < len(args):
        w = args[i]
        t = w.text.lower() if st.flavor == "powershell" else w.text
        if not after and t == "--":
            after = True
        elif not after and t in ("-t", "--target-directory") and i + 1 < len(args):
            target_dir = args[i + 1]
            i += 1
        elif not after and t.startswith("--target-directory="):
            target_dir = gg.Word(w.text.split("=", 1)[1], raw=w.raw.split("=", 1)[1])
        elif not after and st.flavor == "powershell" and t in ("-destination", "-target") and i + 1 < len(args):
            target_dir = args[i + 1]
            i += 1
        elif not after and t.startswith("-") and t != "-":
            if name in LINKERS or (name == "cp" and re.match(r"^-[a-zA-Z]*[sl]|^--(symbolic-)?link$", w.text)):
                st.links = True
            if st.flavor == "powershell" and t in ("-itemtype", "-filter", "-include", "-exclude") and i + 1 < len(args):
                i += 1
        else:
            rest.append(w)
        i += 1
    if name in LINKERS:
        st.links = True
    if target_dir is None and len(rest) >= 2:
        target_dir, rest = rest[-1], rest[:-1]
    elif target_dir is None:
        rest = rest  # one operand (ln -s x): the link lands in the cwd under the source name
    for src in rest:
        add_word(st, "source", src)
    if target_dir is not None:
        add_word(st, "dest", target_dir)
        tv = value(target_dir, st)
        for src in rest:
            sv = value(src, st)
            name_ = os.path.basename(sv.rstrip("/")) if sv is not None else None
            if tv is not None and name_:
                add(st, "dest", _pm(tv).join(tv, name_), glob=src.glob or target_dir.glob)
            else:
                add(st, "dest", None, partial=(target_dir.text + "/" + (name_ or "\0")))
    else:
        for src in rest:
            sv = value(src, st)
            add(st, "dest", os.path.basename(sv.rstrip("/")) if sv else None, glob=src.glob, partial="\0")


def sed_call(args, st):
    """Options normalised first: `-e X`, `-eX`, `-ne X`, `--expression[=]X`; `-f`/`--file` scripts and long options
    other than the exact GNU forms (abbreviations such as `--expr=`, `--in`) are unknown: a fully computed write."""
    scripts, files, inplace, explicit, unsure = [], [], False, False, False
    i, opts = 0, True
    while i < len(args):
        w = args[i]
        t = w.text
        nxt = args[i + 1] if i + 1 < len(args) else None
        if opts and t == "--":
            opts = False
        elif opts and t.startswith("--"):
            key, eq, val = t.partition("=")
            if key not in SED_LONG:
                unsure = True  # an abbreviation or unknown option: the script or in-place target is not known
            elif key in ("--expression", "--file"):
                explicit = True
                unsure = unsure or key == "--file"
                s = gg.Word(val) if eq else nxt
                if not eq:
                    i += 1
                if key == "--expression" and s is not None:
                    scripts.append(s)
            elif key == "--in-place":
                inplace = True
            elif key == "--line-length" and not eq:
                i += 1
        elif opts and t.startswith("-") and len(t) > 1:
            for k, c in enumerate(t[1:], 1):
                rest = t[k + 1:]
                if c in "ef":
                    explicit = True
                    s = gg.Word(rest) if rest else nxt
                    if not rest:
                        i += 1
                    if c == "f":
                        unsure = True
                    elif s is not None:
                        scripts.append(s)
                    break
                if c == "i":
                    inplace = True  # the rest of the cluster is the backup suffix
                    break
                if c == "l":
                    if not rest:
                        i += 1
                    break
        else:
            files.append(w)
        i += 1
    for w in args:
        v = value(w, st) if "\0" in w.text else w.text
        if v is None or ("\0" in w.text and v.startswith("-")):
            unsure = True  # a computed word may be -i, -f or a script: fully computed write
    if not explicit and files:
        scripts.append(files.pop(0))
    if unsure:
        add(st, "sed-f", None)  # script file or unknown option: unknown commands, fully computed write
    for s in scripts:
        if re.search(r"[ewW\0]", s.text):
            # e/w/W anywhere (e command, w/W file, s///e or s///w flag) or a computed script: fully computed write
            add(st, "sed-e", None)
    if inplace:
        for f in files:
            add_word(st, "sed-i", f)


def option_values(args, shorts, longs):
    """Values of output options: `-o X`, `-oX`, a cluster ending in o (`-uo X`), `--output X`, `--output=X`."""
    out = []
    for i, w in enumerate(args):
        t = w.text
        nxt = args[i + 1] if i + 1 < len(args) else None
        if t.startswith("--"):
            key, eq, val = t.partition("=")
            if key in longs:
                if eq:
                    out.append(gg.Word(val, raw=w.raw.split("=", 1)[1] if "=" in w.raw else val, glob=w.glob))
                elif nxt is not None:
                    out.append(nxt)
        elif t.startswith("-") and len(t) > 1:
            for k, c in enumerate(t[1:], 1):
                if c in shorts:
                    if k + 1 < len(t):
                        rest = t[k + 1:]
                        out.append(gg.Word(rest, raw=rest if "\0" not in rest else w.raw[w.raw.find(c) + 1:]))
                    elif nxt is not None:
                        out.append(nxt)
                    break
    return out


def interpreter(lang, name, args, seg, flavor, st, depth):
    code = []
    i = 0
    script = False
    while i < len(args):
        t = args[i].text
        if t in INLINE or (lang == "perl" and re.match(r"^-[a-zA-Z]*[eE]$", t)):
            if i + 1 < len(args):
                code.append(args[i + 1].text)
            i += 2
            continue
        if lang in ("perl", "ruby") and re.match(r"^-[a-zA-Z]*i", t):
            for f in operands(args[i + 1:]):
                add_word(st, "inplace", f)
        if not t.startswith("-"):
            script = True
            break
        i += 1
    if not code and (not script or (i < len(args) and args[i].text == "-")):
        code.extend(seg.heredocs)
        code.extend(w.text for w in seg.herestrings)
    for c in code:
        if LINK_CODE.search(c):
            st.links = True
        for p in swg.code_writes(lang if lang != "ruby" else "python", c):
            add(st, "code", p if p is not None and "\0" not in p else None, partial=None)
    ruling_args(args, st)


def ruling_args(args, st):
    """A literal ruling-named argument of a program that is not a known reader: the program may write it."""
    for w in args:
        t = w.text.split("=", 1)[-1] if w.text.startswith("-") else w.text
        r = w.raw.split("=", 1)[-1] if w.raw.startswith("-") else w.raw
        n = native_raw(r, t, st)
        if n is not None and RULING.match(os.path.basename(n.replace("\\", "/"))):
            add(st, "arg", n)
        if "\0" not in t and _abs(t) and RULING.match(os.path.basename(t.replace("\\", "/"))):
            add(st, "arg", t)
        elif RULING_IN.search(w.text):  # inside awk system(), find -name/-exec, ...: the dir is unknown
            add(st, "arg", None, partial="\0/ruling.md")


def command(words, seg, flavor, st, depth):
    if not words:
        return
    cmd = words[0]
    if "\0" in cmd.text:
        add(st, "command", None)  # computed or unresolved program: fully computed write
        return
    name = gg.prog_name(cmd.text)
    args = words[1:]
    if name in WRAPPERS:
        rest = strip_wrapper(name, args, st)
        if name == "xargs" and rest:
            rest = rest + [COMPUTED]  # operands from stdin
        command(rest, seg, flavor, st, depth)
        return
    if name in CD:
        change_dir(args, st, flavor)
        return
    if name in UNSURE_CD:
        st.cwd = None
        return
    for v in option_values(args, "", ("--output", "--out", "--output-file", "--outfile", "--log-file")):
        add_word(st, "output", v)
    if name in gg.SHELLS:
        shell(args, seg, st, depth)
        return
    if name in gg.PWSH:
        for k, w in enumerate(args):
            if w.text.lower() in ("-c", "-command", "-com"):
                nested(" ".join(x.text for x in args[k + 1:]), "powershell", st, depth)
                return
        return
    if name in ("eval", "invoke-expression", "iex"):
        if name == "eval" and any(value(w, st) is None for w in args):
            add(st, "eval", None)  # computed script: fully computed write
            return
        nested(" ".join(w.text for w in args if w.text.lower() != "-command"), flavor if name == "eval" else "powershell", st, depth)
        return
    if name == "tee" or name == "tee-object":
        for w in operands(args):
            add_word(st, "tee", w)
        return
    if name in COPIERS and not (name == "copy" and flavor == "bash"):
        copier(name, args, st)
        return
    if name == "mklink":
        st.links = True
        for w in args:
            if not w.text.startswith("/"):
                add_word(st, "link", w)
        return
    if name == "dd":
        for w in args:
            if w.text.startswith("of="):
                ow = gg.Word(w.text[3:], raw=w.raw[3:] if w.raw.startswith("of=") else w.raw)
                v = value(ow, st)
                add(st, "dd", v, glob=w.glob, partial=w.text[3:] if v is None else None)
                n = native_raw(ow.raw, v, st)
                if n is not None:
                    add(st, "dd", n, glob=w.glob)
        return
    if name in ("sed", "gsed"):
        sed_call(args, st)
        return
    if name == "find":
        if any("\0" in w.text or FIND_ACTION.match(w.text) for w in args):
            # -exec/-ok run a command, -delete/-fprint/-fls write, a computed word may be any of them: fully computed write
            add(st, "find", None)
        return
    if name in ("truncate", "touch", "shred"):
        skip = False
        for w in args:
            if skip:
                skip = False
                continue
            if w.text in ("-s", "--size", "-r", "--reference", "-d", "-t"):
                skip = True
                continue
            if not w.text.startswith("-"):
                add_word(st, name, w)
        return
    if name == "sort":
        for v in option_values(args, "oT", ("--output", "--temporary-directory")):
            add_word(st, "sort", v)
        return
    if name == "uniq":
        ops = operands(args)
        if len(ops) >= 2:
            add_word(st, "uniq", ops[1])
        return
    if name == "curl":
        for v in option_values(args, "o", ("--output",)):
            add_word(st, "curl", v)
        if any(re.match(r"^-[a-zA-Z]*O|^--remote-name", w.text) for w in args):
            add(st, "curl", None, partial="\0")
        return
    if name == "wget":
        outs = option_values(args, "O", ("--output-document",))
        for v in outs:
            if v.text != "-":
                add_word(st, "wget", v)
        if not outs:
            add(st, "wget", None, partial="\0")
        return
    if flavor == "powershell" and (name in PS_WRITERS or name in ("cp", "mv")):
        if name in ("new-item", "ni") and any(re.match(r"(?i)^(symboliclink|junction|hardlink)$", w.text) for w in args):
            st.links = True
        for w in args:
            if not w.text.startswith("-"):
                add_word(st, "cmdlet", w)
        return
    for lang, rx in LANGS:
        if rx.match(name):
            interpreter(lang, name, args, seg, flavor, st, depth)
            return
    if name in READERS:
        return
    ruling_args(args, st)


def shell(args, seg, st, depth):
    i = 0
    code = False
    while i < len(args):
        t = args[i].text
        if t in ("--", "-"):
            i += 1
            break
        if t.startswith("--"):
            i += 2 if t in ("--rcfile", "--init-file") else 1
            continue
        if (t.startswith("-") or t.startswith("+")) and len(t) > 1:
            code = code or "c" in t[1:]
            i += 2 if t in ("-o", "+o", "-O", "+O") else 1
            continue
        break
    pos = args[i:]
    if code:
        if pos:
            v = value(pos[0], st)
            if v is None:
                add(st, "shell", None)  # computed script: fully computed write
            else:
                nested(v, "bash", st, depth)
        return
    if pos:
        ruling_args(pos, st)
        return
    for body in seg.heredocs:
        nested(body, "bash", st, depth)
    for w in seg.herestrings:
        nested(w.text, "bash", st, depth)


def facts(payload):
    text = payload.get("command") or ""
    flavor = "powershell" if payload.get("shell") == "powershell" else "bash"
    cwd = payload.get("cwd") or os.getcwd()
    st = State(_pm(cwd).normpath(cwd), line_vars(text, payload.get("scratch_dir")) if flavor == "bash" else {}, flavor)
    try:
        walk(text, flavor, st, 0)
    except ValueError as exc:
        return {"writes": st.writes, "links": st.links, "error": str(exc) or "unreadable"}
    return {"writes": st.writes, "links": st.links, "error": None}


def main():
    payload = json.loads(sys.stdin.read() or "{}")
    ti = payload.get("tool_input") if isinstance(payload.get("tool_input"), dict) else {}
    if "command" not in payload and "command" in ti:
        payload["command"] = ti["command"]
    sys.stdout.write(json.dumps(facts(payload)) + "\n")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # noqa: BLE001 - any failure must reach the caller as a block
        sys.stderr.write("shell_facts: internal error: %s: %s\n" % (type(exc).__name__, exc))
        sys.exit(2)
