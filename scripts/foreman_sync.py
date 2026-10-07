#!/usr/bin/env python3
"""Deterministic session-end sync of the configured repositories (stdlib, 3.9+, no model).

    python scripts/foreman_sync.py --cwd <workspace> --state <agentDir>/pi-foreman/state
                                   --session <id> [--dry-run] [--json] [--trusted-project]
                                   [--agent-dir D] [--session-file F] [--trace F] [--usage F]
                                   [--review-log F]

For each `sync.repos` entry {path, branch, paths} of the merged config (scripts/foreman_config.py,
the loader the extension uses; the list comes from L1-L3 only):

- refused (reported, repo skipped): not a git work tree root, unreadable git config, detached
  HEAD, a merge/rebase/cherry-pick/revert in progress, or a current branch that may not be
  pushed (it is neither the entry's `branch` nor recorded for this session in
  `<state>/created-branches.json` as {workspace, branch, session});
- `git pull --ff-only --no-rebase` (when the branch has an upstream); a failure skips the repo;
- candidates = changed or untracked files matching the entry's `paths` globs (fnmatch on
  `/`-separated repo-relative paths); a candidate whose name or content looks like a secret
  refuses the whole repo (only the file name and the rule are reported);
- staged by explicit path (`git add -- <file>...`, chunked) and committed with
  `git commit -m "chore(sync): <date> <session-8>" -- <files>`;
- pushed with `git push <remote> <branch>:refs/heads/<branch>` (remote = the branch's upstream
  remote, else origin). Never forced, never anything that discards work.

Git runs with the hardened environment and `-c` options of scripts/safe_ops.py: no system config,
core.fsmonitor off, ext:: transport off, commit.gpgSign and submodule.recurse off, and core.hooksPath set to an empty
directory, so repository hooks (pre-commit, commit-msg, pre-push) do NOT run; core.alternateRefsCommand
and core.alternateRefsPrefixes are emptied. A repo whose local or worktree config (includes followed)
sets any key outside a small allowlist of harmless keys (ALLOWED_KEYS: core layout/line-ending keys,
user.name/email, remote.*.url/fetch, branch tracking, pull/push/fetch defaults, display keys; some only
with a false value, branch remotes only naming a configured remote, remote urls only https://, ssh://,
git:// or scp-like `[user@]host:path`, never a local path, file:// or a `<helper>::` transport, whose
receive-pack hooks would run in this env), includes a file outside the git dir, has objects/info/alternates,
or holds a gitlink (submodule entry) in its index, is refused before any pull, add, commit or push, and
the check runs again right before the commit and right before the push (a detached child may still
be writing config); only key classes and rule names are reported. Every git call also passes
`-c diff.ignoreSubmodules=all` (and status `--ignore-submodules=all`), so no nested repository's own
config (filters) is honoured. The push remote must be a configured remote with an url.

Test seam: TEST_LOCAL_REMOTES (module attribute, empty) lists exact local paths the url rule accepts.
It is honoured only while `unittest` is imported, it is never read from foreman.json, flags or the
environment, so only an in-process test can set it (the suite pushes to a local bare repo).
Candidates are scanned whole as bytes (larger than 20 MiB: refused); symlinks and hard links are
refused. Git output shown in a report is redacted (`scheme://user:pass@` and token-like strings). That is deliberate: a hook is
code from the repository, and sync runs with the owner's credentials.

When `sync.runRetro` is on, scripts/foreman_retro.py runs for this session and its summary is
appended. Output is at most 40 lines (text or JSON). Exit 0 when every repo is clean, committed
or pushed; 1 when any repo was skipped or refused; 2 on a usage or config error.
"""
from __future__ import annotations

import argparse
import datetime
import fnmatch
import json
import os
import re
import shutil
import stat
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import foreman_config as fc  # noqa: E402
import safe_ops  # noqa: E402

MAX_LINES = 40
CHUNK = 100
SCAN_CHUNK = 1024 * 1024
SCAN_OVERLAP = 4096
SCAN_MAX = 20 * 1024 * 1024
GIT_TIMEOUT = 120
CREATED_FILE = "created-branches.json"
OK_STATUSES = ("clean", "committed", "pushed", "dry-run")

SECRET_NAMES = [".env*", "*.pem", "*.key", "*.p12", "id_rsa*", "id_ed25519*", "*credential*", "*secret*", "*token*",
                ".npmrc", ".netrc", ".pypirc", ".git-credentials", "*.kdbx", "*.jks", "*.pfx", "id_ecdsa*"]
TOKEN_RX = r"(?<![A-Za-z0-9_])(?:ghp_|gho_|ghs_|ghu_|ghr_|AIza|github_pat_|npm_|glpat-|sk-ant-|xox[bap]-|xoxe[.-])[A-Za-z0-9_\-]{16,}"
SECRET_CONTENT = [
    ("private key header", re.compile(rb"-----BEGIN [A-Z ]*PRIVATE KEY( BLOCK)?-----")),
    ("token prefix", re.compile(TOKEN_RX.encode("ascii"))),
    ("AWS access key id", re.compile(rb"(?<![A-Z0-9])AKIA[0-9A-Z]{16}(?![A-Z0-9])")),
]
REDACT = [(re.compile(r"(\w[\w+.\-]*://)[^/@\s]+@"), r"\1***@"), (re.compile(TOKEN_RX), "***"),
          (re.compile(r"(?<![A-Z0-9])AKIA[0-9A-Z]{16}(?![A-Z0-9])"), "***")]
# Repo-local, worktree and included config keys sync accepts (security re-review N1: a deny list
# missed keys twice). Any other key refuses the repo; only its key class (`section.<x>.name`, the
# subsection masked) or a rule label is reported, never a value. `<x>` = any subsection name.
# Value rules: "false" = only a false value; "remote" = must name a configured remote;
# "url" = URL_OK (network transports only).
ALLOWED_KEYS = [(re.compile(rx), rule) for rx, rule in (
    (r"core\.(?:repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|symlinks"
     r"|autocrlf|eol|safecrlf|quotepath|untrackedcache|splitindex|checkstat|trustctime|commitgraph"
     r"|multipackindex|abbrev)", None),
    (r"core\.fsmonitor", "false"),
    (r"extensions\.(?:worktreeconfig|objectformat|refstorage)", None), (r"init\.defaultbranch", None),
    (r"user\.(?:name|email)", None),
    (r"remote\..+\.url", "url"), (r"remote\..+\.(?:fetch|tagopt|prune)", None),
    (r"branch\..+\.(?:remote|pushremote)", "remote"), (r"branch\..+\.(?:merge|rebase)", None),
    (r"pull\.(?:ff|rebase)", None), (r"push\.(?:default|autosetupremote)", None), (r"fetch\.prune", None),
    (r"gc\.(?:auto|autodetach)", None), (r"(?:commit|tag)\.gpgsign", "false"),
    (r"(?:color|i18n|log|status|advice)\..+", None), (r"diff\.(?:renames|algorithm)", None),
    (r"merge\.conflictstyle", None), (r"rerere\.enabled", None), (r"index\.version", None),
    (r"feature\.manyfiles", None), (r"include\.path|includeif\..+\.path", "include"))]
# git's own scp-like rule: a colon before any slash, no `::` (a transport helper), no `://` (a url). The host must be
# at least two characters (a drive letter `C:` is a local path) and no user/host part may start with `-`.
URL_OK = re.compile(r"(?:https|ssh|git)://(?:[A-Za-z0-9][^/@\s]*@)?(?:[A-Za-z0-9][A-Za-z0-9.-]*|\[[0-9A-Fa-f:.]+\])"
                    r"(?::[0-9]*)?(?:/\S*)?"
                    r"|(?:[A-Za-z0-9][A-Za-z0-9._~+-]*@)?[A-Za-z0-9][A-Za-z0-9.-]+:(?!:|//)\S*")
TEST_LOCAL_REMOTES = ()  # test seam, see the module docstring


def url_ok(val):
    """True for a remote url sync may pull from and push to (B1: no local repo with its own hooks)."""
    if URL_OK.fullmatch(val or ""):
        return True
    return bool(TEST_LOCAL_REMOTES) and "unittest" in sys.modules and \
        any(same_path(val, p) for p in TEST_LOCAL_REMOTES if os.path.isabs(val or ""))


class UsageError(Exception):
    pass


# ------------------------------------------------------------------ git

def git(args, cwd, stdin=None):
    """(code, stdout, stderr) of one hardened git call (safe_ops env and -c options)."""
    exe = shutil.which("git")
    if not exe:
        return 127, "", "git is not on PATH"
    try:
        r = subprocess.run([exe, "-c", "commit.gpgSign=false", "-c", "submodule.recurse=false", "-c", "diff.ignoreSubmodules=all",
                            "-c", "core.alternateRefsCommand=", "-c", "core.alternateRefsPrefixes="] + safe_ops.git_hardening() + list(args), cwd=cwd, env=safe_ops._git_env(),
                           input=stdin, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=GIT_TIMEOUT)
    except (OSError, subprocess.SubprocessError) as exc:
        return 1, "", str(exc)
    return r.returncode, r.stdout.decode("utf-8", "surrogateescape"), r.stderr.decode("utf-8", "replace")


def redact(text):
    for rx, sub in REDACT:
        text = rx.sub(sub, text)
    return text


def first_line(text):
    lines = [ln.strip() for ln in (text or "").splitlines() if ln.strip()]
    return redact(lines[0])[:160] if lines else "no detail"


def same_path(a, b):
    return safe_ops.norm(os.path.realpath(a)) == safe_ops.norm(os.path.realpath(b))


# ------------------------------------------------------------------ pieces

def read_created(state_dir):
    """Records of branches this foreman created: [{workspace, branch, session}]; [] when absent."""
    try:
        with open(os.path.join(state_dir, CREATED_FILE), encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return []
    items = data.get("branches") if isinstance(data, dict) else data
    return [r for r in items if isinstance(r, dict)] if isinstance(items, list) else []


def session_created(records, root, branch, session):
    for r in records:
        if r.get("branch") == branch and r.get("session") == session and isinstance(r.get("workspace"), str):
            if same_path(r["workspace"], root):
                return True
    return False


def in_progress(root):
    """Name of an operation in progress (merge, rebase, cherry-pick, revert), or None."""
    for marker, name in (("MERGE_HEAD", "merge"), ("rebase-merge", "rebase-merge"), ("rebase-apply", "rebase-apply"),
                         ("CHERRY_PICK_HEAD", "cherry-pick"), ("REVERT_HEAD", "revert")):
        code, out, _ = git(["rev-parse", "--git-path", marker], root)
        p = out.strip()
        if code == 0 and p and os.path.exists(p if os.path.isabs(p) else os.path.join(root, p)):
            return name
    return None


def status_paths(root):
    """Repo-relative `/` paths of changed or untracked files (both sides of a rename)."""
    code, out, err = git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=all"], root)
    if code != 0:
        raise RuntimeError("git status failed: %s" % first_line(err))
    parts = out.split("\0")
    paths, i = [], 0
    while i < len(parts):
        rec = parts[i]
        i += 1
        if len(rec) < 4:
            continue
        xy, p = rec[:2], rec[3:]
        paths.append(p)
        if "R" in xy or "C" in xy:
            if i < len(parts) and parts[i]:
                paths.append(parts[i])
            i += 1
    seen, out_paths = set(), []
    for p in paths:
        p = p.replace("\\", "/")
        if p not in seen:
            seen.add(p)
            out_paths.append(p)
    return out_paths


def matches(path, globs):
    return any(fnmatch.fnmatchcase(path, g.replace("\\", "/")) for g in globs if isinstance(g, str) and g)


def parse_config_z(out):
    """[(key, value)] from `git config --list -z` (value None for a bare boolean key)."""
    pairs = []
    for rec in out.split("\0"):
        if rec:
            key, sep, val = rec.partition("\n")
            pairs.append((key, val if sep else None))
    return pairs


def _is_false(val):
    return val is not None and val.strip().lower() in ("false", "no", "off", "0", "")


def key_class(low):
    """`section.<x>.name` for a three-part key (the subsection may carry a url or credentials)."""
    parts = low.split(".")
    return low if len(parts) < 3 else "%s.<x>.%s" % (parts[0], parts[-1])


def risky_config(root):
    """(rule names, error) for repo-local and worktree config (includes followed) outside ALLOWED_KEYS
    or failing its value rule, and for an alternates file. Key classes and rule names only: key
    subsections and values are never reported."""
    dirs = {}
    for flag in ("--git-dir", "--git-common-dir"):
        code, out, err = git(["rev-parse", flag], root)
        if code != 0 or not out.strip():
            return [], "git rev-parse %s failed (%s)" % (flag, first_line(err))
        dirs[flag] = os.path.join(root, out.strip())
    code, out, err = git(["config", "--local", "--includes", "--list", "-z"], root)
    if code != 0:
        return [], "unreadable git config (%s)" % first_line(err)
    sets = [(parse_config_z(out), dirs["--git-common-dir"])]
    if any(k.lower() == "extensions.worktreeconfig" and not _is_false(v) for k, v in sets[0][0]):
        code, out, err = git(["config", "--worktree", "--includes", "--list", "-z"], root)
        if code != 0:
            return [], "unreadable git worktree config (%s)" % first_line(err)
        sets.append((parse_config_z(out), dirs["--git-dir"]))
    hits = []
    remotes = {k[7:-4] for pairs, _ in sets for k, _v in pairs if k.lower().startswith("remote.") and k.lower().endswith(".url")}
    for pairs, base in sets:
        for key, val in pairs:
            low = key.lower()
            rule = next((r for rx, r in ALLOWED_KEYS if rx.fullmatch(low)), False)
            if rule is False:
                hits.append("not allowlisted: %s" % key_class(low))
            elif rule == "false" and not _is_false(val):
                hits.append("%s (not false)" % low)
            elif rule == "remote" and (val or "") not in remotes:
                hits.append("%s (not a configured remote)" % key_class(low))
            elif rule == "url" and not url_ok(val):
                hits.append("remote.<x>.url (not https/ssh/git or scp-like)")
            elif rule == "include":
                target = os.path.expanduser(val or "")
                if not target or not safe_ops.is_inside(os.path.realpath(dirs["--git-common-dir"]),
                                                        os.path.realpath(os.path.join(base, target))):
                    hits.append("include.path/includeIf.*.path (outside the git dir)")
    if os.path.lexists(os.path.join(dirs["--git-common-dir"], "objects", "info", "alternates")):
        hits.append("objects/info/alternates present")
    code, out, err = git(["ls-files", "--stage", "-z"], root)
    if code != 0:
        return [], "git ls-files failed (%s)" % first_line(err)
    if any(rec.startswith("160000 ") for rec in out.split("\0")):
        hits.append("gitlink (submodule) in the index")
    return sorted(set(hits)), None


def secret_hit(root, rel):
    """Rule name when the file's name or content looks like a secret, it is a link, or it is too
    large to scan; else None. The whole file is scanned as bytes, in overlapping chunks."""
    base = rel.rsplit("/", 1)[-1].lower()
    for pat in SECRET_NAMES:
        if fnmatch.fnmatchcase(base, pat):
            return "name matches %s" % pat
    full = os.path.join(root, *rel.split("/"))
    try:
        st = os.lstat(full)
    except OSError:
        return None
    if stat.S_ISLNK(st.st_mode):
        return "symlink (not committed)"
    if not stat.S_ISREG(st.st_mode):
        return None
    if st.st_nlink > 1:
        return "hard link (not committed)"
    if st.st_size > SCAN_MAX:
        return "too large to scan (> %d MiB)" % (SCAN_MAX // (1024 * 1024))
    try:
        with open(full, "rb") as fh:
            tail = b""
            while True:
                chunk = fh.read(SCAN_CHUNK)
                if not chunk:
                    return None
                buf = tail + chunk
                for name, rx in SECRET_CONTENT:
                    if rx.search(buf):
                        return "content: %s" % name
                tail = buf[-SCAN_OVERLAP:]
                if fh.tell() > SCAN_MAX:
                    return "too large to scan (> %d MiB)" % (SCAN_MAX // (1024 * 1024))
    except OSError:
        return None


def commit_paths(root, files, message):
    for i in range(0, len(files), CHUNK):
        code, _, err = git(["add", "--"] + files[i:i + CHUNK], root)
        if code != 0:
            return "git add failed: %s" % first_line(err)
    if sum(len(f) + 1 for f in files) < 20000:
        code, _, err = git(["commit", "-m", message, "--"] + files, root)
    else:
        spec = ("\0".join(files) + "\0").encode("utf-8", "surrogateescape")
        code, _, err = git(["commit", "-m", message, "--pathspec-from-file=-", "--pathspec-file-nul"], root, stdin=spec)
    return None if code == 0 else "git commit failed: %s" % first_line(err)


# ------------------------------------------------------------------ one repo

def recheck(root, rep, prefix):
    """Run the full repo check (config, alternates, gitlinks); on a hit set rep refused and return False."""
    risky, err = risky_config(root)
    if err or risky:
        rep["status"] = "refused"
        rep["detail"] = prefix + (err or "repo config sets code-running or redirecting keys: %s" % ", ".join(risky))
        return False
    return True


def sync_repo(entry, ctx):
    raw = entry.get("path") if isinstance(entry, dict) else None
    rep = {"path": raw, "status": "refused", "detail": "", "files": [], "secrets": []}
    if not isinstance(raw, str) or not raw.strip() or not isinstance(entry.get("branch"), str) \
            or not isinstance(entry.get("paths"), list):
        rep["detail"] = "invalid sync.repos entry (needs path, branch, paths)"
        return rep
    path = os.path.abspath(os.path.expanduser(raw))
    rep["path"] = path
    if not os.path.isdir(path):
        rep["detail"] = "not a directory"
        return rep
    code, top, err = git(["rev-parse", "--show-toplevel"], path)
    if code != 0 or not same_path(top.strip(), path):
        rep["detail"] = "not a git work tree root"
        return rep
    root = path
    if not recheck(root, rep, ""):
        return rep
    code, out, _ = git(["symbolic-ref", "-q", "--short", "HEAD"], root)
    branch = out.strip()
    if code != 0 or not branch:
        rep["detail"] = "detached HEAD"
        return rep
    rep["branch"] = branch
    op = in_progress(root)
    if op:
        rep["detail"] = "%s in progress" % op
        return rep
    owner = branch == entry["branch"]
    if not owner and not session_created(ctx["created"], root, branch, ctx["session"]):
        rep["detail"] = "on %s: not pushed (branch not owner-listed or session-created)" % branch
        return rep
    code, up, _ = git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], root)
    has_upstream = code == 0 and bool(up.strip())
    notes = []
    if has_upstream and not ctx["dry_run"]:
        code, _, err = git(["pull", "--ff-only", "--no-rebase"], root)
        if code != 0:
            rep["status"] = "skipped"
            rep["detail"] = "pull --ff-only failed (diverged?): %s" % first_line(err)
            return rep
    elif not has_upstream:
        notes.append("no upstream, pull skipped")
    try:
        files = [p for p in status_paths(root) if matches(p, entry["paths"])]
    except RuntimeError as exc:
        rep["status"] = "skipped"
        rep["detail"] = str(exc)
        return rep
    hits = [(f, secret_hit(root, f)) for f in files]
    hits = [(f, h) for f, h in hits if h]
    if hits:
        rep["detail"] = "possible secrets, nothing committed"
        rep["secrets"] = [{"file": f, "rule": h} for f, h in hits]
        return rep
    rep["files"] = files
    if ctx["dry_run"]:
        rep["status"] = "dry-run"
        rep["detail"] = "would pull, commit %d file(s), push %s" % (len(files), branch)
        return rep
    committed = False
    if files:
        if not recheck(root, rep, "before commit: "):
            return rep
        err = commit_paths(root, files, "chore(sync): %s %s" % (ctx["date"], ctx["session"][:8]))
        if err:
            rep["status"] = "skipped"
            rep["detail"] = err
            return rep
        committed = True
    remote = ""
    code, out, _ = git(["config", "--get", "branch.%s.remote" % branch], root)
    if code == 0 and out.strip() and not out.strip().startswith("-"):
        remote = out.strip()
    remote = remote or "origin"
    code, out, _ = git(["config", "--get", "remote.%s.url" % remote], root)
    if code != 0 or not out.strip():
        rep["status"] = "skipped"
        rep["detail"] = "%sremote %s has no configured url, not pushed" % ("committed, " if committed else "", remote)
        return rep
    ahead = True
    if has_upstream:
        code, out, _ = git(["rev-list", "--count", "@{u}..HEAD"], root)
        ahead = code != 0 or out.strip() != "0"
    if not ahead:
        rep["status"] = "committed" if committed else "clean"
        rep["detail"] = "; ".join(notes + ["nothing to push"])
        return rep
    if not recheck(root, rep, "%sbefore push: " % ("committed, " if committed else "")):
        return rep
    code, _, err = git(["push", remote, "%s:refs/heads/%s" % (branch, branch)], root)
    if code != 0:
        rep["status"] = "skipped"
        rep["detail"] = "%spush to %s failed: %s" % ("committed, " if committed else "", remote, first_line(err))
        return rep
    rep["status"] = "pushed"
    rep["detail"] = "; ".join(notes + ["%d file(s) committed, pushed to %s" % (len(files), remote)])
    return rep


# ------------------------------------------------------------------ retro and output

def run_retro(args, agent_dir):
    cmd = [sys.executable, "-E", "-s", os.path.join(HERE, "foreman_retro.py"), "--agent-dir", agent_dir]
    for flag, val in (("--session", args.session_file), ("--trace", args.trace), ("--usage", args.usage),
                      ("--review-log", args.review_log)):
        if val:
            cmd += [flag, val]
    try:
        r = subprocess.run(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120)
    except (OSError, subprocess.SubprocessError) as exc:
        return "retro failed: %s" % exc
    text = r.stdout.decode("utf-8", "replace").strip() or r.stderr.decode("utf-8", "replace").strip()
    return text or "retro produced no output"


def render(reps, retro):
    lines = ["pi-foreman sync"]
    if not reps:
        lines.append("no sync.repos configured")
    for r in reps:
        lines.append("%s: %s%s" % (r["path"], r["status"], (" (%s)" % r["detail"]) if r["detail"] else ""))
        for s in r["secrets"]:
            lines.append("  secret? %s: %s" % (s["file"], s["rule"]))
    if retro:
        lines.append("retro:")
        lines.extend("  " + ln for ln in retro.splitlines() if ln.strip())
    if len(lines) > MAX_LINES:
        lines = lines[:MAX_LINES - 1] + ["... (%d more lines)" % (len(lines) - MAX_LINES + 1)]
    return "\n".join(lines)


def build_parser():
    p = argparse.ArgumentParser(prog="foreman_sync")
    p.add_argument("--cwd", required=True)
    p.add_argument("--state", required=True)
    p.add_argument("--session", required=True)
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--json", action="store_true")
    p.add_argument("--trusted-project", action="store_true")
    p.add_argument("--agent-dir")
    p.add_argument("--session-file")
    p.add_argument("--trace")
    p.add_argument("--usage")
    p.add_argument("--review-log")
    return p


def main(argv=None):
    try:
        args = build_parser().parse_args(argv)
    except SystemExit as exc:
        return 2 if exc.code else 0
    if not args.session.strip():
        print("foreman_sync: --session is empty", file=sys.stderr)
        return 2
    state = os.path.abspath(os.path.expanduser(args.state))
    agent_dir = args.agent_dir or os.path.dirname(os.path.dirname(state))
    try:
        res = fc.load_config(agent_dir, os.path.abspath(args.cwd), args.trusted_project)
    except fc.ConfigError as exc:
        print("foreman_sync: %s" % exc, file=sys.stderr)
        return 2
    if res["errors"]:
        print("foreman_sync: config errors: %s" % "; ".join(res["errors"]), file=sys.stderr)
        return 2
    sync = res["config"].get("sync") or {}
    repos = sync.get("repos") or []
    ctx = {"session": args.session.strip(), "dry_run": args.dry_run, "created": read_created(state),
           "date": datetime.date.today().isoformat()}
    reps = [sync_repo(e, ctx) for e in repos]
    retro = run_retro(args, agent_dir) if sync.get("runRetro") else ""
    code = 0 if all(r["status"] in OK_STATUSES for r in reps) else 1
    if args.json:
        print(json.dumps({"repos": reps, "retro": retro.splitlines()[:MAX_LINES], "exit": code}, separators=(",", ":")))
    else:
        print(render(reps, retro))
    return code


if __name__ == "__main__":
    sys.exit(main())
