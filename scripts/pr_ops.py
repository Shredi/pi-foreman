#!/usr/bin/env python3
"""PR operations of the git tool pack (design/pr-ops.md section 2). Stdlib only, 3.13+.

Loaded by scripts/safe_ops.py for the ops pr_create, pr_status, pr_checks, pr_comments, pr_repo, pr_find,
pr_search, pr_batch, pr_poll and pr_login (the last four need no work tree); the
request and answer envelopes are the ones documented there. `config` is the `safety.ops` object
plus one key, `prHost` (the effective tools.prHost: "auto", "gh", "glab" or a templates object).

The host CLI (gh, glab or an overlay's own program) is found on PATH outside the workspace and
run without a shell, with its own login; pi-foreman never reads or asks for a token. Nothing
here pushes. Host text is data: it is redacted, stripped of control characters and capped.
"""
from __future__ import annotations

import datetime
import json
import os
import re
import shlex
import subprocess
import sys
import tempfile
import unicodedata
import urllib.parse

import safe_ops
from safe_ops import ActionError, Precondition, git_read, is_inside, read_args, redact, workspace_root

PR_TIMEOUT = 30
BODY_CUT = 500
MAX_LIST = 200
MAX_FIND = 50
MAX_POLL_BYTES = 64 * 1024
MAX_POLL_ITEMS = 200
MAX_BATCH = 50
MAX_NAMES = 10
PLACEHOLDERS = ("{repo}", "{number}", "{since}", "{base}", "{head}", "{title}", "{bodyFile}", "{draft}",
                "{host}", "{mode}", "{author}", "{state}")
HOST_RE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?(?::\d{1,5})?$")
AUTHOR_RE = re.compile(r"^(?:@me|[A-Za-z0-9][A-Za-z0-9-]{0,38}(?:\[bot\])?)$")
LOGIN_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9-]{0,38}(?:\[bot\])?$")
HTTPS_RE = re.compile(r"^https://[\x21-\x7e]+$")
SINCE_IMF_RE = re.compile(r"^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$")
ETAG_RE = re.compile(r'^(?:W/)?"[\x21\x23-\x7e]{1,128}"$')
FAILED_CONCLUSIONS = ("FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE")
POLL_EVENT_TYPES = ("PullRequestEvent", "PullRequestReviewEvent", "PullRequestReviewCommentEvent", "IssueCommentEvent")
CMD_SAFE = re.compile(r"^[A-Za-z0-9 ._/:@+,=#~-]*$")
SINCE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$")
REPO_PATH_RE = re.compile(r"^(?!-)[A-Za-z0-9._-]+(/(?!-)[A-Za-z0-9._-]+)+$")
CONTROL_RX = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")
UTC = datetime.timezone.utc
HINT_NONE = ("no PR host CLI found: install gh or glab outside the workspace, or set tools.prHost "
             "(docs/tools.md#pr-tools)")
HOST_ENV = {"GH_PROMPT_DISABLED": "1", "GH_NO_UPDATE_NOTIFIER": "1", "NO_COLOR": "1", "GIT_TERMINAL_PROMPT": "0"}


# ------------------------------------------------------------ host resolution

def find_program(name, root, env=None, platform=None):
    """First regular file `name` on PATH outside `root` (not shutil.which: on Windows that looks in the cwd)."""
    env = os.environ if env is None else env
    platform = sys.platform if platform is None else platform
    if platform == "win32":
        exts = [e for e in (env.get("PATHEXT") or ".COM;.EXE;.BAT;.CMD").split(";") if e] or [".EXE"]
    else:
        exts = [""]
    for raw in (env.get("PATH") or "").split(os.pathsep):
        d = raw.strip().strip('"').strip("'")
        if not d or d == "." or not os.path.isabs(d):
            continue
        try:
            if is_inside(root, os.path.realpath(d), allow_equal=True):
                continue
        except (OSError, ValueError):
            continue
        for ext in exts:
            cand = os.path.join(d, name + ext)
            if not os.path.isfile(cand):
                continue
            if platform != "win32" and not os.access(cand, os.X_OK):
                continue
            if is_inside(root, os.path.realpath(cand), allow_equal=True):
                continue
            return cand
    return None


class Host(object):
    def __init__(self, kind, program, words=None):
        self.kind, self.program, self.words = kind, program, words

    @property
    def label(self):
        return self.kind if self.kind != "template" else os.path.basename(self.program)


def _missing_explicit(name):
    return Precondition("pr_host_missing", "%s not found on PATH outside the workspace; install it or change tools.prHost" % name)


def resolve_host(pr_host, op_key, root):
    if pr_host is None:
        pr_host = "auto"
    if isinstance(pr_host, str):
        if pr_host == "auto":
            for name in ("gh", "glab"):
                p = find_program(name, root)
                if p:
                    return Host(name, p)
            raise Precondition("pr_host_missing", HINT_NONE)
        if pr_host in ("gh", "glab"):
            p = find_program(pr_host, root)
            if not p:
                raise _missing_explicit(pr_host)
            return Host(pr_host, p)
        raise Precondition("pr_template_invalid", "tools.prHost must be auto, gh, glab or an object of templates")
    if not isinstance(pr_host, dict):
        raise Precondition("pr_template_invalid", "tools.prHost must be auto, gh, glab or an object of templates")
    line = pr_host.get(op_key)
    if line is None:
        raise Precondition("pr_host_missing", "tools.prHost has no '%s' template" % op_key)
    try:
        words = shlex.split(line, posix=True) if isinstance(line, str) else []
    except ValueError:
        words = []
    if not words or words[0] in PLACEHOLDERS:
        raise Precondition("pr_template_invalid", "the '%s' template has no program as its first word" % op_key)
    first = words[0]
    if "/" in first or "\\" in first:
        if not os.path.isabs(first) or not os.path.isfile(first) or is_inside(root, os.path.realpath(first), allow_equal=True):
            raise Precondition("pr_template_invalid", "the '%s' template program must be a bare name or an absolute file outside the workspace" % op_key)
        program = first
    else:
        program = find_program(first, root)
        if not program:
            raise Precondition("pr_host_missing", "%s not found on PATH outside the workspace; install it or change tools.prHost" % first)
    return Host("template", program, words[1:])


def run_host(argv, root, subst=()):
    """(code, stdout, stderr) of one host call: no shell, no stdin, 30 s, prompts disabled."""
    if argv[0].lower().endswith((".cmd", ".bat")):
        for v in subst:
            if not CMD_SAFE.match(v):
                raise Precondition("unsafe_for_cmd_shim", "%s has characters cmd.exe would interpret; use the .exe" % _short(v))
    env = dict(os.environ)
    env.update(HOST_ENV)
    name = os.path.basename(argv[0])
    try:
        r = subprocess.run(argv, cwd=root, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                           stderr=subprocess.PIPE, timeout=PR_TIMEOUT)
    except subprocess.TimeoutExpired:
        raise ActionError("timeout", "%s did not answer within %d s" % (name, PR_TIMEOUT))
    except OSError as exc:
        raise ActionError("pr_host_failed", "%s: %s" % (name, redact(str(exc))[:160]))
    return r.returncode, r.stdout.decode("utf-8", "replace"), r.stderr.decode("utf-8", "replace")


def _short(v):
    return "an argument" if len(v) > 40 else repr(v)


def first_line(text):
    for line in (text or "").splitlines():
        if line.strip():
            return redact(line.strip())[:160]
    return "no detail"


def host_error(host, op, code, err):
    """Raise the precondition or error for a failed host call (never returns)."""
    low = (err or "").lower()
    if host.kind == "template":
        if code == 4:
            raise Precondition("pr_auth_missing", first_line(err))
        if code == 3:
            raise Precondition("pr_not_found", first_line(err))
    elif host.kind == "gh":
        if code == 4 or "gh auth login" in low:
            raise _auth("gh")
        if "no pull requests found" in low or "could not resolve to a pullrequest" in low:
            raise Precondition("pr_not_found", "no pull request for this branch or number")
    else:
        if re.search(r"glab auth login|401|unauthorized", low):
            raise _auth("glab")
        if "404" in low or "no open merge request" in low:
            raise Precondition("pr_not_found", "no merge request for this branch or number")
    raise ActionError("pr_host_failed", "%s: %s" % (host.label, first_line(err)))


def _auth(name):
    return Precondition("pr_auth_missing", "%s is not logged in: run `%s auth login` yourself; pi-foreman never reads or asks for tokens" % (name, name))


def host_json(host, code, out, err, op):
    if code != 0:
        host_error(host, op, code, err)
    try:
        return json.loads(out)
    except ValueError:
        raise ActionError("pr_host_failed", "%s: printed no JSON" % host.label)


# --------------------------------------------------------------- arguments

def _bad(detail):
    return Precondition("bad_request", detail)


def arg_number(args):
    n = args.get("number")
    if n is None:
        return None
    if not isinstance(n, int) or isinstance(n, bool) or not 1 <= n <= 10 ** 9:
        raise _bad("number must be an integer from 1 to 1000000000")
    return n


def arg_since(args):
    v = args.get("since")
    if v is None:
        return None
    if not isinstance(v, str) or not SINCE_RE.match(v) or parse_dt(v) is None:
        raise _bad("since must be an ISO 8601 timestamp such as 2026-01-31T12:00:00Z")
    return v


def arg_text(args, key, lo, hi, line_only):
    v = args.get(key)
    if not isinstance(v, str) or not lo <= len(v) <= hi or "\0" in v:
        raise _bad("%s must be a string of %d to %d characters" % (key, lo, hi))
    if line_only and ("\r" in v or "\n" in v or v.startswith("-")):
        raise _bad("%s must be one line and must not start with -" % key)
    return v


def arg_branch(args, key, root):
    v = args.get(key)
    if v is None:
        return None
    return check_branch(v, key, root)


def check_branch(v, key, root):
    if not isinstance(v, str) or not 1 <= len(v) <= 200 or not safe_ops.BRANCH_RE.match(v) \
            or git_read(["check-ref-format", "--branch", v], root)[0] != 0:
        raise _bad("%s must be a plain branch name" % key)
    return v


def arg_repo(args):
    """Optional `owner/name` (more segments for GitLab groups): no leading -, no empty, . or .. segment."""
    v = args.get("repo")
    if v is None:
        return None
    if not isinstance(v, str) or len(v) > 200 or not REPO_PATH_RE.match(v) or any(s in (".", "..") for s in v.split("/")):
        raise _bad("repo must be owner/name")
    return v


def arg_host(args):
    v = args.get("host")
    if v is None:
        return None
    if not isinstance(v, str) or not HOST_RE.match(v):
        raise _bad("host must be a host name")
    return v


def arg_author(args, key="author"):
    v = args.get(key)
    if v is None:
        return None
    if not isinstance(v, str) or not AUTHOR_RE.match(v):
        raise _bad("%s must be @me or a user name" % key)
    return v


def arg_login(args):
    v = args.get("login")
    if v is None:
        return None
    if not isinstance(v, str) or not LOGIN_RE.match(v):
        raise _bad("login must be a user name")
    return v


def two_part(repo):
    """(owner, name) of an `owner/name` string, or None."""
    parts = repo.split("/")
    return (parts[0], parts[1]) if len(parts) == 2 else None


def repo_flag(host, repo, hostname):
    """gh/glab `-R` argv for the optional repo and host arguments (a host alone is refused)."""
    if hostname and not repo:
        raise _bad("host needs repo")
    if not repo:
        return []
    return ["-R", (hostname + "/" if hostname and host.kind == "gh" else "") + repo]


def glab_foreign(host, hostname):
    if host.kind == "glab" and hostname:
        raise ActionError("pr_host_failed", "glab: a host other than the CLI's own is not supported")


# ------------------------------------------------------------ date and text

def parse_dt(s):
    if not isinstance(s, str):
        return None
    s = s.strip()
    if s[-1:] in ("Z", "z"):
        s = s[:-1] + "+00:00"
    m = re.match(r"^(.*?T\d{2}:\d{2}:\d{2})(\.\d+)?(.*)$", s)
    if not m:
        return None
    frac = ("." + m.group(2)[1:7].ljust(6, "0")) if m.group(2) else ""
    try:
        d = datetime.datetime.fromisoformat(m.group(1) + frac + m.group(3))
    except ValueError:
        return None
    return d if d.tzinfo else d.replace(tzinfo=UTC)


def clean_text(v, limit):
    """Redacted, control characters (but newline and tab) dropped, cut to `limit`. (text, was_cut)."""
    t = CONTROL_RX.sub("", redact(v if isinstance(v, str) else ""))
    return (t[:limit], True) if len(t) > limit else (t, False)


def clean_title(v):
    """clean_text plus every Unicode Cc and Cf code point removed, cut to 200: titles and check names."""
    t = "".join(c for c in clean_text(v, 10000)[0] if unicodedata.category(c) not in ("Cc", "Cf"))
    return t[:200]


def s_or_none(v, limit):
    return clean_text(v, limit)[0] if isinstance(v, str) else None


def title_or_none(v):
    return clean_title(v) if isinstance(v, str) else None


def login(v):
    if isinstance(v, dict):
        v = v.get("login") or v.get("username") or v.get("name")
    return s_or_none(v, 100)


# ------------------------------------------------------------- normalisers

def norm_entry(e):
    """One check object: {name, status, conclusion, url, startedAt, completedAt}."""
    if not isinstance(e, dict):
        raise ValueError("entry")
    return {"name": title_or_none(e.get("name")), "status": s_or_none(e.get("status"), 40),
            "conclusion": s_or_none(e.get("conclusion"), 40), "url": s_or_none(e.get("url"), 1024),
            "startedAt": s_or_none(e.get("startedAt"), 40), "completedAt": s_or_none(e.get("completedAt"), 40)}


def finish_checks(pending, failed, passed, required=False):
    p, f, q = ([norm_entry(e) for e in lst] for lst in (pending, failed, passed))
    total = len(p) + len(f) + len(q)
    if not total:
        summary = "no checks reported"
    else:
        names = [e["name"] or "?" for e in f[:5]]
        more = ", +%d" % (len(f) - 5) if len(f) > 5 else ""
        failed_txt = "%d failed (%s%s)" % (len(f), ", ".join(names), more) if f else "0 failed"
        summary = "%d passed, %s, %d pending" % (len(q), failed_txt, len(p))
    return cap_lists({"action": "pr_checks", "pending": p, "failed": f, "passed": q, "summary": summary,
                      "required": bool(required)}, ["failed", "pending", "passed"])


def cap_lists(result, keys, limit=MAX_LIST):
    """`limit` entries in priority order, then drop from the back until the JSON fits 16 KB."""
    total = sum(len(result[k]) for k in keys)
    left = limit
    for k in keys:
        result[k] = result[k][:left]
        left -= len(result[k])
    result["total"], result["truncated"] = total, False
    for k in reversed(keys):
        while result[k] and len(json.dumps(result)) > safe_ops.MAX_BYTES:
            result[k].pop()
    result["truncated"] = sum(len(result[k]) for k in keys) < total
    return result


def norm_comment(c):
    if not isinstance(c, dict):
        raise ValueError("comment")
    body, was_cut = clean_text(c.get("body"), BODY_CUT)
    kind = c.get("kind") if c.get("kind") in ("issue", "review", "review_summary") else "issue"
    out = {"id": str(c.get("id")) if c.get("id") is not None else "", "kind": kind,
           "author": s_or_none(c.get("author"), 100), "createdAt": s_or_none(c.get("createdAt"), 40), "body": body}
    if was_cut:
        out["bodyCut"] = True
    if isinstance(c.get("path"), str):
        out["path"] = c["path"][:1024]
        out["path"] = clean_text(out["path"], 1024)[0]
    ln = c.get("line")
    if isinstance(ln, int) and not isinstance(ln, bool):
        out["line"] = ln
    if isinstance(c.get("resolved"), bool):
        out["resolved"] = c["resolved"]
    if isinstance(c.get("state"), str):
        out["state"] = s_or_none(c["state"], 40)
    return out


def finish_comments(items, since):
    cs = [norm_comment(c) for c in items]
    if since:
        cut = parse_dt(since)
        cs = [c for c in cs if (parse_dt(c["createdAt"]) or cut) > cut]
    floor = datetime.datetime.min.replace(tzinfo=UTC)
    cs.sort(key=lambda c: parse_dt(c["createdAt"]) or floor, reverse=True)
    return safe_ops.cap({"action": "pr_comments", "comments": cs}, "comments")


STATUS_KEYS = ("number", "url", "state", "draft", "mergeable", "reviewDecision", "headSha", "baseRef", "updatedAt")


def finish_status(d):
    def enum(v, allowed):
        return v if v in allowed else None
    out = {"action": "pr_status"}
    n = d.get("number")
    out["number"] = n if isinstance(n, int) and not isinstance(n, bool) else None
    out["url"] = s_or_none(d.get("url"), 1024)
    out["title"] = title_or_none(d.get("title"))
    out["state"] = enum(d.get("state"), ("open", "closed", "merged"))
    out["draft"] = d.get("draft") if isinstance(d.get("draft"), bool) else None
    out["mergeable"] = enum(d.get("mergeable"), ("mergeable", "conflicting", "unknown"))
    out["reviewDecision"] = enum(d.get("reviewDecision"), ("approved", "changes_requested", "review_required"))
    out["headSha"] = s_or_none(d.get("headSha"), 64)
    out["baseRef"] = s_or_none(d.get("baseRef"), 200)
    out["updatedAt"] = s_or_none(d.get("updatedAt"), 40)
    return out


def gh_status(d):
    mer = str(d.get("mergeable") or "").upper()
    return finish_status({
        "number": d.get("number"), "url": d.get("url"), "title": d.get("title"), "state": str(d.get("state") or "").lower(),
        "draft": d.get("isDraft"),
        "mergeable": "mergeable" if mer == "MERGEABLE" else "conflicting" if mer == "CONFLICTING" else "unknown",
        "reviewDecision": str(d.get("reviewDecision") or "").lower() or None,
        "headSha": d.get("headRefOid"), "baseRef": d.get("baseRefName"), "updatedAt": d.get("updatedAt")})


def glab_status(d):
    st = str(d.get("state") or "").lower()
    ds = d.get("detailed_merge_status")
    return finish_status({
        "number": d.get("iid"), "url": d.get("web_url"), "title": d.get("title"),
        "state": {"opened": "open", "locked": "closed"}.get(st, st),
        "draft": d.get("draft"),
        "mergeable": "mergeable" if ds == "mergeable" else "conflicting" if ds == "conflict" else "unknown",
        "reviewDecision": "review_required" if ds == "not_approved" else None,
        "headSha": d.get("sha"), "baseRef": d.get("target_branch"), "updatedAt": d.get("updated_at")})


def gh_check(e):
    return e if isinstance(e, dict) else {}


def gh_checks(items):
    pending, failed, passed = [], [], []
    for e in items:
        e = gh_check(e)
        bucket = str(e.get("bucket") or "").lower()
        state = str(e.get("state") or "").lower() or None
        done = bucket != "pending"
        entry = {"name": e.get("name"), "status": "completed" if done else state,
                 "conclusion": state if done else None, "url": e.get("link"),
                 "startedAt": e.get("startedAt"), "completedAt": e.get("completedAt")}
        (pending if bucket == "pending" else failed if bucket in ("fail", "cancel") else passed).append(entry)
    return finish_checks(pending, failed, passed)


def glab_checks(items):
    pending, failed, passed = [], [], []
    for e in items:
        e = e if isinstance(e, dict) else {}
        st = str(e.get("status") or "").lower()
        entry = {"name": e.get("name"), "status": st or None, "conclusion": None, "url": e.get("web_url"),
                 "startedAt": e.get("started_at"), "completedAt": e.get("finished_at")}
        if st == "failed" and e.get("allow_failure"):
            entry["status"], entry["conclusion"] = "completed", "allowed_failure"
            passed.append(entry)
        elif st in ("failed", "canceled"):
            entry["status"], entry["conclusion"] = "completed", st
            failed.append(entry)
        elif st in ("success", "skipped", "manual"):
            entry["status"], entry["conclusion"] = "completed", st
            passed.append(entry)
        else:
            pending.append(entry)
    return finish_checks(pending, failed, passed)


def gh_comment_list(view, inline):
    out = []
    for c in (view.get("comments") if isinstance(view, dict) else None) or []:
        if isinstance(c, dict):
            out.append({"id": c.get("id"), "kind": "issue", "author": login(c.get("author")),
                        "createdAt": c.get("createdAt"), "body": c.get("body")})
    for r in (view.get("reviews") if isinstance(view, dict) else None) or []:
        if not isinstance(r, dict):
            continue
        state = str(r.get("state") or "").upper()
        if state == "PENDING" or (state == "COMMENTED" and not (r.get("body") or "").strip()):
            continue
        out.append({"id": r.get("id"), "kind": "review_summary", "author": login(r.get("author")),
                    "createdAt": r.get("submittedAt") or r.get("createdAt"), "body": r.get("body"), "state": state.lower()})
    for c in inline if isinstance(inline, list) else []:
        if isinstance(c, dict):
            out.append({"id": c.get("id"), "kind": "review", "author": login(c.get("user")),
                        "createdAt": c.get("created_at"), "body": c.get("body"), "path": c.get("path"),
                        "line": c.get("line") if c.get("line") is not None else c.get("original_line")})
    return out


def glab_comment_list(discussions):
    out = []
    for disc in discussions if isinstance(discussions, list) else []:
        for n in (disc.get("notes") if isinstance(disc, dict) else None) or []:
            if not isinstance(n, dict) or n.get("system"):
                continue
            c = {"id": n.get("id"), "kind": "issue", "author": login(n.get("author")),
                 "createdAt": n.get("created_at"), "body": n.get("body")}
            if n.get("type") == "DiffNote":
                pos = n.get("position") if isinstance(n.get("position"), dict) else {}
                c.update(kind="review", path=pos.get("new_path"), line=pos.get("new_line"))
            if n.get("resolvable"):
                c["resolved"] = bool(n.get("resolved"))
            out.append(c)
    return out


# ------------------------------------------------------------ templates

def expand(words, values):
    """argv for a template: whole-word placeholders, an absent value drops its word and a preceding option."""
    out = []  # (text, literal option candidate)
    subst = []
    for w in words:
        if w in PLACEHOLDERS:
            key = w[1:-1]
            v = values.get(key)
            if callable(v):
                v = v()
            if v is None or v is False:
                if out and out[-1][1]:
                    out.pop()
                continue
            if v is True:
                out.append(("--draft", False))
                continue
            out.append((v, False))
            subst.append(v)
        else:
            out.append((w, w.startswith("-") and "=" not in w))
    return [t for t, _ in out], subst


def uses(words, key):
    return "{%s}" % key in words


def run_template(host, op, values, root):
    argv, subst = expand(host.words, values)
    code, out, err = run_host([host.program] + argv, root, subst)
    if code != 0:
        host_error(host, op, code, err)
    return out


def template_json(out, op, kinds):
    try:
        d = json.loads(out)
    except ValueError:
        d = None
    if not isinstance(d, kinds):
        raise ActionError("pr_host_failed", "the tools.prHost %s template printed no JSON of the documented shape" % op)
    return d


def shape_error(op):
    return ActionError("pr_host_failed", "the tools.prHost %s template printed no JSON of the documented shape" % op)


# ----------------------------------------------------------------- repo

def current_branch(root):
    code, out, _ = git_read(["symbolic-ref", "--quiet", "--short", "HEAD"], root)
    return out.strip() if code == 0 and out.strip() else None


def remote_of(root, head):
    r = None
    if head:
        code, out, _ = git_read(["config", "--get", "branch.%s.remote" % head], root)
        r = out.strip() if code == 0 else None
    if not r or r == "." or r.startswith("-") or not re.match(r"^[A-Za-z0-9._/-]+$", r):
        r = "origin"
    return r


def derive_remote(root, head):
    """(host, owner/name) of the branch's remote (else origin)."""
    remote = remote_of(root, head)
    code, out, _ = git_read(["remote", "get-url", remote], root)
    url = out.strip()
    m = re.match(r"^[A-Za-z][A-Za-z0-9+.-]*://(?:[^/@]*@)?([^/]+)/(.+)$", url) if code == 0 else None
    if not m and code == 0 and "://" not in url:
        m = re.match(r"^(?:[^@/\s]+@)?([^/:\s]+):(.+)$", url)
    path = m.group(2).strip("/") if m else ""
    hostname = m.group(1) if m else ""
    if path.endswith(".git"):
        path = path[:-4]
    if any(seg.startswith("-") for seg in path.split("/")):
        raise _bad("repo must not start with -")
    if not REPO_PATH_RE.match(path):
        raise Precondition("pr_repo_unknown", "cannot derive owner/name from the %s remote URL" % remote)
    return hostname, path


def derive_repo(root, head):
    return derive_remote(root, head)[1]


# -------------------------------------------------------------- builtins

def gh_view(host, root, number, fields, rflag=()):
    argv = [host.program, "pr", "view"] + ([str(number)] if number else []) + list(rflag) + ["--json", fields]
    code, out, err = run_host(argv, root, [str(number)] if number else [])
    return host_json(host, code, out, err, "status")


def glab_view(host, root, number, rflag=()):
    argv = [host.program, "mr", "view"] + ([str(number)] if number else []) + list(rflag) + ["--output", "json"]
    code, out, err = run_host(argv, root, [str(number)] if number else [])
    return host_json(host, code, out, err, "status")


def glab_project(repo):
    """`projects/<owner%2Fname>` for a repo, `projects/:id` for the current one."""
    return "projects/" + urllib.parse.quote(repo, safe="") if repo else "projects/:id"


def glab_api(host, root, path, extra=(), subst=()):
    code, out, err = run_host([host.program, "api"] + list(extra) + [path], root, subst)
    return host_json(host, code, out, err, "api")


# -------------------------------------------------------------- ops

def _setup(req, allowed):
    args = read_args(req, allowed)
    cfg = req.get("config") if isinstance(req.get("config"), dict) else {}
    return args, cfg, cfg.get("prHost", "auto")


def op_pr_status(req):
    args, cfg, pr_host = _setup(req, ("number", "repo", "host"))
    number = arg_number(args)
    repo, hostname = arg_repo(args), arg_host(args)
    root = workspace_root(req.get("cwd"))
    host = resolve_host(pr_host, "status", root)
    if host.kind == "template":
        out = run_template(host, "status", _values(root, number=number, repo=repo, host=hostname), root)
        d = template_json(out, "status", dict)
        return finish_status(d)
    glab_foreign(host, hostname)
    rflag = repo_flag(host, repo, hostname)
    if host.kind == "gh":
        return gh_status(gh_view(host, root, number,
                                 "number,url,title,state,isDraft,mergeable,reviewDecision,headRefOid,baseRefName,updatedAt",
                                 rflag))
    return glab_status(glab_view(host, root, number, rflag))


def op_pr_checks(req):
    args, cfg, pr_host = _setup(req, ("number", "repo", "host", "required"))
    number = arg_number(args)
    repo, hostname = arg_repo(args), arg_host(args)
    required = args.get("required", False)
    if not isinstance(required, bool):
        raise _bad("required must be a boolean")
    root = workspace_root(req.get("cwd"))
    host = resolve_host(pr_host, "checks", root)
    if host.kind == "template":
        out = run_template(host, "checks", _values(root, number=number, repo=repo, host=hostname), root)
        d = template_json(out, "checks", dict)
        lists = []
        for k in ("pending", "failed", "passed"):
            v = d.get(k, [])
            if not isinstance(v, list) or not all(isinstance(e, dict) for e in v):
                raise shape_error("checks")
            lists.append(v)
        return finish_checks(*lists)
    glab_foreign(host, hostname)
    rflag = repo_flag(host, repo, hostname)
    if host.kind == "gh":
        argv = [host.program, "pr", "checks"] + ([str(number)] if number else []) + rflag + \
            (["--required"] if required else []) + ["--json", "name,state,bucket,link,startedAt,completedAt"]
        code, out, err = run_host(argv, root, [str(number)] if number else [])
        try:
            items = json.loads(out)
        except ValueError:
            items = None
        if isinstance(items, list):
            res = gh_checks(items)  # gh exits 8 while checks are pending and 1 on a failure
            res["required"] = required
            return res
        if "no checks reported" in err.lower() or "no required checks reported" in err.lower():
            return finish_checks([], [], [], required)
        if code == 0:
            raise ActionError("pr_host_failed", "gh: printed no JSON")
        host_error(host, "checks", code, err)
    mr = glab_view(host, root, number, rflag)
    pipe = mr.get("head_pipeline") if isinstance(mr, dict) else None
    pid = pipe.get("id") if isinstance(pipe, dict) else None
    if not isinstance(pid, int) or isinstance(pid, bool):
        return finish_checks([], [], [])
    jobs = glab_api(host, root, "%s/pipelines/%d/jobs?per_page=100" % (glab_project(repo), pid))
    return glab_checks(jobs if isinstance(jobs, list) else [])


def op_pr_comments(req):
    args, cfg, pr_host = _setup(req, ("number", "since", "repo", "host"))
    number = arg_number(args)
    since = arg_since(args)
    repo, hostname = arg_repo(args), arg_host(args)
    root = workspace_root(req.get("cwd"))
    host = resolve_host(pr_host, "comments", root)
    if host.kind == "template":
        out = run_template(host, "comments", _values(root, number=number, since=since, repo=repo, host=hostname), root)
        d = template_json(out, "comments", list)
        if not all(isinstance(c, dict) for c in d):
            raise shape_error("comments")
        return finish_comments(d, since)
    glab_foreign(host, hostname)
    rflag = repo_flag(host, repo, hostname)
    if host.kind == "gh":
        if number is None:
            number = gh_view(host, root, None, "number", rflag).get("number")
            if not isinstance(number, int):
                raise ActionError("pr_host_failed", "gh: printed no pull request number")
        view = gh_view(host, root, number, "comments,reviews", rflag)
        path = "repos/%s/pulls/%d/comments?per_page=100" % (repo, number) if repo else \
            "repos/{owner}/{repo}/pulls/%d/comments?per_page=100" % number
        extra = ["--hostname", hostname] if hostname else []
        code, out, err = run_host([host.program, "api", "--method", "GET"] + extra + [path], root)
        inline = host_json(host, code, out, err, "comments")
        return finish_comments(gh_comment_list(view, inline), since)
    if number is None:
        number = glab_view(host, root, None, rflag).get("iid")
        if not isinstance(number, int):
            raise ActionError("pr_host_failed", "glab: printed no merge request number")
    disc = glab_api(host, root, "%s/merge_requests/%d/discussions?per_page=100" % (glab_project(repo), number))
    return finish_comments(glab_comment_list(disc), since)


def _values(root, **kw):
    """Placeholder values for a template; {repo} is derived only when the template uses it."""
    v = {"number": str(kw["number"]) if kw.get("number") else None, "since": kw.get("since"),
         "base": kw.get("base"), "head": kw.get("head"), "title": kw.get("title"),
         "bodyFile": kw.get("bodyFile"), "draft": kw.get("draft") or None, "host": kw.get("host"),
         "mode": kw.get("mode"), "author": kw.get("author"), "state": kw.get("state")}
    v["repo"] = kw.get("repo") or (lambda: _no_dash("repo", derive_repo(root, kw.get("head") or current_branch(root))))
    return v


def _no_dash(key, value):
    if value.startswith("-"):
        raise _bad("%s must not start with -" % key)
    return value


def _body_file(text):
    fd, path = tempfile.mkstemp(prefix="pf-pr-body-", suffix=".md")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(text.encode("utf-8"))
    except BaseException:
        _unlink(path)
        raise
    return path


def _unlink(path):
    try:
        os.unlink(path)
    except OSError:
        pass


def _argpath(path):
    return path.replace("\\", "/") if os.sep == "\\" else path


def _resolve_base(root, head, arg, cfg):
    if arg:
        return arg
    remote = remote_of(root, head)
    conf = safe_ops.ops_config(cfg)["baseBranch"]
    if conf:
        for pre in ("refs/heads/", "refs/remotes/%s/" % remote, remote + "/"):
            if conf.startswith(pre):
                return conf[len(pre):]
        return conf
    code, out, _ = git_read(["symbolic-ref", "--quiet", "--short", "refs/remotes/%s/HEAD" % remote], root)
    out = out.strip()
    if code == 0 and out:
        return out[len(remote) + 1:] if out.startswith(remote + "/") else out
    return None


def op_pr_create(req):
    args, cfg, pr_host = _setup(req, ("title", "body", "base", "head", "draft"))
    title = arg_text(args, "title", 1, 256, True)
    body = arg_text(args, "body", 0, 65536, False)
    if len(body.encode("utf-8")) > 65536:
        raise _bad("body must be at most 65536 bytes")
    draft = args.get("draft", False)
    if not isinstance(draft, bool):
        raise _bad("draft must be a boolean")
    root = workspace_root(req.get("cwd"))
    base_arg = arg_branch(args, "base", root)
    head_arg = arg_branch(args, "head", root)
    cur = current_branch(root)
    if not cur:
        raise Precondition("detached_head", "HEAD is not on a branch")
    head = head_arg or check_branch(cur, "head", root)
    code, sha, _ = git_read(["rev-parse", "--verify", "--quiet", "refs/heads/%s^{commit}" % head], root)
    if code != 0:
        raise Precondition("unknown_branch", "%s is not a local branch" % head)
    base = _resolve_base(root, head, base_arg, cfg)
    if base == head:
        raise Precondition("base_is_head", "base %s is the branch the PR comes from" % base)
    code, up, _ = git_read(["rev-parse", "--abbrev-ref", "--symbolic-full-name", head + "@{upstream}"], root)
    up = up.strip()
    if code != 0 or not up:
        raise Precondition("unpushed", "%s has no upstream; push it first, pi-foreman does not push" % head)
    code, upsha, _ = git_read(["rev-parse", "--verify", "--quiet", up + "^{commit}"], root)
    if code != 0 or upsha.strip() != sha.strip():
        raise Precondition("unpushed", "%s differs from its upstream %s; push first" % (head, up))
    host = resolve_host(pr_host, "create", root)
    path = None
    try:
        if host.kind == "template":
            if uses(host.words, "bodyFile"):
                path = _body_file(body)
            values = _values(root, base=base, head=head, title=title, draft=draft,
                             bodyFile=_argpath(path) if path else None)
            out = run_template(host, "create", values, root)
            return _create_answer(out, head, base, True)
        if host.kind == "gh":
            path = _body_file(body)
            argv = [host.program, "pr", "create", "--title", title, "--body-file", _argpath(path), "--head", head]
            subst = [title, _argpath(path), head]
            if base:
                argv += ["--base", base]
                subst.append(base)
            if draft:
                argv.append("--draft")
            code, out, err = run_host(argv, root, subst)
            if code != 0:
                host_error(host, "create", code, err)
            return _create_answer(out, head, base, False)
        if not base:
            raise Precondition("base_branch_unknown", "no base branch: pass base or set safety.ops.baseBranch")
        payload = {"source_branch": head, "target_branch": base, "title": ("Draft: " + title) if draft else title,
                   "description": body}
        path = _body_file(json.dumps(payload))
        argv = [host.program, "api", "--method", "POST", "projects/:id/merge_requests", "--header",
                "Content-Type:application/json", "--input", _argpath(path)]
        code, out, err = run_host(argv, root, [_argpath(path)])
        d = host_json(host, code, out, err, "create")
        if not isinstance(d, dict) or not isinstance(d.get("iid"), int) or not isinstance(d.get("web_url"), str):
            raise ActionError("pr_host_failed", "glab: printed no merge request")
        return {"action": "pr_create", "number": d["iid"], "url": s_or_none(d["web_url"], 1024),
                "head": s_or_none(d.get("source_branch"), 200) or head,
                "base": s_or_none(d.get("target_branch"), 200) or base}
    finally:
        if path:
            _unlink(path)


def _create_answer(out, head, base, template):
    """{number, url, head, base} from JSON or from a last line URL ending in /<digits>."""
    d = None
    try:
        d = json.loads(out)
    except ValueError:
        pass
    if template and isinstance(d, dict):
        n, url = d.get("number"), d.get("url")
        if isinstance(n, int) and not isinstance(n, bool) and isinstance(url, str):
            return {"action": "pr_create", "number": n, "url": s_or_none(url, 1024),
                    "head": s_or_none(d.get("head"), 200) or head, "base": s_or_none(d.get("base"), 200) or base}
    lines = [x.strip() for x in out.splitlines() if x.strip()]
    m = re.search(r"/(\d+)/?$", lines[-1]) if lines else None
    if not m or not re.match(r"^https?://", lines[-1]):
        if template:
            raise shape_error("create")
        raise ActionError("pr_host_failed", "gh: printed no pull request URL")
    return {"action": "pr_create", "number": int(m.group(1)), "url": s_or_none(lines[-1], 1024),
            "head": head, "base": base}


# ------------------------------------------------- repo, find, search, batch, poll, login

def _repoless_root(req):
    """The process cwd of an op that needs no work tree: realpath of an existing directory."""
    cwd = req.get("cwd")
    if not isinstance(cwd, str) or not cwd or not os.path.isdir(cwd):
        raise _bad("cwd is not a directory")
    return os.path.realpath(cwd)


def _gh_only(pr_host, root, key):
    if isinstance(pr_host, dict):
        raise Precondition("pr_unsupported", "%s needs gh; tools.prHost templates have no '%s' key" % (key, key))
    host = resolve_host(pr_host, key, root)
    if host.kind != "gh":
        raise Precondition("pr_unsupported", "%s needs gh; %s is not supported" % (key, host.label))
    return host


def _url_host(url):
    """The host (with port) of an https URL without user info, else None."""
    if not isinstance(url, str) or not HTTPS_RE.match(url):
        return None
    netloc = urllib.parse.urlsplit(url).netloc
    return netloc if netloc and "@" not in netloc and HOST_RE.match(netloc) else None


def _repo_answer(hostname, repo, url):
    if not hostname or not isinstance(repo, str) or not REPO_PATH_RE.match(repo):
        raise ActionError("pr_host_failed", "the host gave no usable repository")
    return {"action": "pr_repo", "host": hostname, "repo": repo, "url": s_or_none(url, 1024)}


def op_pr_repo(req):
    args, cfg, pr_host = _setup(req, ())
    root = workspace_root(req.get("cwd"))
    if isinstance(pr_host, dict):
        hostname, repo = derive_remote(root, current_branch(root))
        return _repo_answer(hostname, repo, "https://%s/%s" % (hostname, repo))
    host = resolve_host(pr_host, "repo", root)
    if host.kind == "gh":
        code, out, err = run_host([host.program, "repo", "view", "--json", "nameWithOwner,url"], root)
        d = host_json(host, code, out, err, "repo")
        d = d if isinstance(d, dict) else {}
        return _repo_answer(_url_host(d.get("url")), d.get("nameWithOwner"), d.get("url"))
    code, out, err = run_host([host.program, "repo", "view", "--output", "json"], root)
    d = host_json(host, code, out, err, "repo")
    d = d if isinstance(d, dict) else {}
    return _repo_answer(_url_host(d.get("web_url")), d.get("path_with_namespace"), d.get("web_url"))


def norm_find(items):
    out = []
    for e in items:
        if not isinstance(e, dict) or not isinstance(e.get("number"), int) or isinstance(e.get("number"), bool):
            continue
        st = str(e.get("state") or "").lower()
        out.append({"number": e["number"], "url": s_or_none(e.get("url"), 1024),
                    "state": {"opened": "open", "locked": "closed"}.get(st, st) or None,
                    "title": title_or_none(e.get("title")), "headRefName": s_or_none(e.get("headRefName"), 200),
                    "author": login(e.get("author"))})
    return cap_lists({"action": "pr_find", "prs": out}, ["prs"], MAX_FIND)


def op_pr_find(req):
    args, cfg, pr_host = _setup(req, ("head", "author", "state", "repo", "host"))
    author = arg_author(args)
    if (args.get("head") is None) == (author is None):
        raise _bad("exactly one of head and author")
    state = args.get("state", "open")
    if state not in ("open", "all"):
        raise _bad("state must be open or all")
    repo, hostname = arg_repo(args), arg_host(args)
    root = workspace_root(req.get("cwd"))
    head = check_branch(args["head"], "head", root) if args.get("head") is not None else None
    host = resolve_host(pr_host, "find", root)
    if host.kind == "template":
        values = _values(root, head=head, author=author, state=state, mode="head" if head else "author",
                         repo=repo, host=hostname)
        d = template_json(run_template(host, "find", values, root), "find", list)
        return norm_find(d)
    glab_foreign(host, hostname)
    rflag = repo_flag(host, repo, hostname)
    sel = ["--head", head] if head else ["--author", author]
    if host.kind == "gh":
        argv = [host.program, "pr", "list"] + rflag + sel + ["--state", state, "--limit", str(MAX_FIND + 1),
                "--json", "number,url,state,title,headRefName,author"]
    else:
        sel = ["--source-branch", head] if head else ["--author", author]
        argv = [host.program, "mr", "list"] + rflag + sel + (["--all"] if state == "all" else []) + \
            ["--per-page", str(MAX_FIND + 1), "--output", "json"]
    code, out, err = run_host(argv, root, [head or author])
    d = host_json(host, code, out, err, "find")
    if not isinstance(d, list):
        raise ActionError("pr_host_failed", "%s: printed no JSON list" % host.label)
    if host.kind == "glab":
        d = [{"number": e.get("iid"), "url": e.get("web_url"), "state": e.get("state"), "title": e.get("title"),
              "headRefName": e.get("source_branch"), "author": e.get("author")} for e in d if isinstance(e, dict)]
    return norm_find(d)


def norm_search(items, template):
    out = []
    for e in items:
        if not isinstance(e, dict) or not isinstance(e.get("number"), int) or isinstance(e.get("number"), bool):
            continue
        url = e.get("url")
        if not isinstance(url, str) or not HTTPS_RE.match(url):
            continue
        r = e.get("repository")
        if isinstance(r, dict):
            r = r.get("nameWithOwner") or r.get("full_name")
        item = {"number": e["number"], "url": url[:1024], "title": title_or_none(e.get("title")),
                "repository": r if isinstance(r, str) and REPO_PATH_RE.match(r) else None}
        if template and e.get("reviewRequested") is True:
            item["reviewRequested"] = True
        out.append(item)
    return cap_lists({"action": "pr_search", "prs": out}, ["prs"], MAX_FIND)


def op_pr_search(req):
    args, cfg, pr_host = _setup(req, ("author", "reviewRequested", "host"))
    author = arg_author(args)
    rr = args.get("reviewRequested")
    if rr is not None and rr is not True and not (isinstance(rr, str) and AUTHOR_RE.match(rr)):
        raise _bad("reviewRequested must be true or a user name")
    if (author is None) == (rr is None):
        raise _bad("exactly one of author and reviewRequested")
    hostname = arg_host(args)
    root = _repoless_root(req)
    if isinstance(pr_host, dict):
        host = resolve_host(pr_host, "search", root)
        values = {"author": author, "host": hostname}
        d = template_json(run_template(host, "search", values, root), "search", list)
        return norm_search(d, True)
    host = _gh_only(pr_host, root, "search")
    if hostname:
        raise _bad("gh search prs has no host option; host is for templates only")
    sel = ["--author", author] if author else ["--review-requested", "@me" if rr is True else rr]
    argv = [host.program, "search", "prs", "--state", "open", "--limit", str(MAX_FIND + 1),
            "--json", "number,title,url,repository"] + sel
    code, out, err = run_host(argv, root, [author or str(rr)])
    d = host_json(host, code, out, err, "search")
    if not isinstance(d, list):
        raise ActionError("pr_host_failed", "gh: printed no JSON list")
    return norm_search(d, False)


ZERO_TIME = ("0001-01-01T00:00:00Z", "0001-01-01T00:00:00")


def map_rollup(roll):
    """{pending, failed, passed, missing (names, <= 10 each), counts, truncated} of one statusCheckRollup."""
    names = {"pending": [], "failed": [], "passed": [], "missing": []}
    counts = dict.fromkeys(names, 0)
    ctx = roll.get("contexts") if isinstance(roll, dict) else None
    nodes = ctx.get("nodes") if isinstance(ctx, dict) else None
    total = ctx.get("totalCount") if isinstance(ctx, dict) else 0
    for nd in nodes if isinstance(nodes, list) else []:
        if not isinstance(nd, dict):
            continue
        if nd.get("__typename") == "StatusContext":
            name, st = nd.get("context"), str(nd.get("state") or "").upper()
            group = "failed" if st in ("FAILURE", "ERROR") else "missing" if st == "EXPECTED" else \
                "passed" if st == "SUCCESS" else "pending"
        else:
            name, st = nd.get("name"), str(nd.get("status") or "").upper()
            concl = str(nd.get("conclusion") or "").upper()
            if concl in FAILED_CONCLUSIONS:
                group = "failed"
            elif st != "COMPLETED":
                group = "missing" if nd.get("isRequired") is True and (not nd.get("startedAt") or nd.get("startedAt") in ZERO_TIME) else "pending"
            else:
                group = "passed"
        counts[group] += 1
        if len(names[group]) < MAX_NAMES:
            names[group].append(title_or_none(name) or "?")
    out = dict(names)
    out["counts"] = counts
    out["truncated"] = isinstance(total, int) and not isinstance(total, bool) and total > 100
    return out


def _pr_query(count):
    decl = ", ".join("$owner%d: String!, $name%d: String!, $n%d: Int!" % (i, i, i) for i in range(count))
    parts = []
    for i in range(count):
        parts.append(
            "r%d: repository(owner: $owner%d, name: $name%d) { pullRequest(number: $n%d) { number url title state "
            "isDraft mergeable reviewDecision headRefName commits(last: 1) { nodes { commit { statusCheckRollup { state "
            "contexts(first: 100) { totalCount nodes { __typename ... on CheckRun { name status conclusion startedAt "
            "isRequired(pullRequestNumber: $n%d) } ... on StatusContext { context state "
            "isRequired(pullRequestNumber: $n%d) } } } } } } } } }" % (i, i, i, i, i, i))
    return "query(%s) { %s }" % (decl, " ".join(parts))


def _batch_args(args):
    prs = args.get("prs")
    if not isinstance(prs, list) or not 1 <= len(prs) <= MAX_BATCH:
        raise _bad("prs must be a list of 1 to %d entries" % MAX_BATCH)
    out = []
    for e in prs:
        if not isinstance(e, dict) or set(e) != {"repo", "n"}:
            raise _bad("each pr is {repo, n}")
        repo, n = e["repo"], e["n"]
        if not isinstance(repo, str) or len(repo) > 200 or not REPO_PATH_RE.match(repo) \
                or any(s in (".", "..") for s in repo.split("/")) or two_part(repo) is None:
            raise _bad("repo must be owner/name")
        if not isinstance(n, int) or isinstance(n, bool) or not 1 <= n <= 10 ** 9:
            raise _bad("n must be an integer from 1 to 1000000000")
        out.append((repo, n))
    return out


def _enum(v, allowed):
    v = str(v or "").lower()
    return v if v in allowed else None


def op_pr_batch(req):
    args, cfg, pr_host = _setup(req, ("host", "prs"))
    hostname = arg_host(args)
    entries = _batch_args(args)
    root = _repoless_root(req)
    host = _gh_only(pr_host, root, "batch")
    argv = [host.program, "api", "graphql"] + (["--hostname", hostname] if hostname else []) + \
        ["-f", "query=" + _pr_query(len(entries))]
    subst = []
    for i, (repo, n) in enumerate(entries):
        owner, name = two_part(repo)
        argv += ["-f", "owner%d=%s" % (i, owner), "-f", "name%d=%s" % (i, name), "-F", "n%d=%d" % (i, n)]
        subst += [owner, name]
    code, out, err = run_host(argv, root, subst)
    try:
        d = json.loads(out)
    except ValueError:
        d = None
    if not isinstance(d, dict):
        if code != 0:
            host_error(host, "batch", code, err)
        raise ActionError("pr_host_failed", "gh: printed no JSON")
    errs = [x for x in d.get("errors") if isinstance(x, dict)] if isinstance(d.get("errors"), list) else []
    if any(x.get("type") == "RATE_LIMITED" for x in errs):
        raise ActionError("pr_host_failed", "gh: GraphQL RATE_LIMITED")
    data = d.get("data")
    if not isinstance(data, dict):
        if code != 0:
            host_error(host, "batch", code, err)
        msg = first_line(str(errs[0].get("message"))) if errs else "no data"
        raise ActionError("pr_host_failed", "gh: %s" % msg)
    prs, errors = [], []
    for i, (repo, n) in enumerate(entries):
        alias = "r%d" % i
        node = data.get(alias)
        pr = node.get("pullRequest") if isinstance(node, dict) else None
        if not isinstance(pr, dict):
            mine = [x for x in errs if isinstance(x.get("path"), list) and x["path"][:1] == [alias]]
            kind = "pr_host_failed" if mine and not any(x.get("type") == "NOT_FOUND" for x in mine) else "pr_not_found"
            errors.append({"repo": repo, "number": n, "kind": kind})
            continue
        commits = pr.get("commits")
        nodes = commits.get("nodes") if isinstance(commits, dict) else None
        commit = nodes[0].get("commit") if isinstance(nodes, list) and nodes and isinstance(nodes[0], dict) else None
        roll = commit.get("statusCheckRollup") if isinstance(commit, dict) else None
        mer = str(pr.get("mergeable") or "").upper()
        prs.append({"repo": repo, "number": n, "url": s_or_none(pr.get("url"), 1024), "title": title_or_none(pr.get("title")),
                    "state": _enum(pr.get("state"), ("open", "closed", "merged")),
                    "draft": pr.get("isDraft") if isinstance(pr.get("isDraft"), bool) else None,
                    "mergeable": "mergeable" if mer == "MERGEABLE" else "conflicting" if mer == "CONFLICTING" else "unknown",
                    "reviewDecision": _enum(pr.get("reviewDecision"), ("approved", "changes_requested", "review_required")),
                    "headRefName": s_or_none(pr.get("headRefName"), 200), "checks": map_rollup(roll)})
    return {"action": "pr_batch", "prs": prs, "errors": errors}


def parse_http(out):
    """(status, headers (lower-case names), body) of `gh api -i` output, or None."""
    head, sep, body = out.partition("\r\n\r\n")
    if not sep:
        head, sep, body = out.partition("\n\n")
    lines = head.splitlines()
    m = re.match(r"^HTTP/\S+\s+(\d{3})", lines[0]) if lines else None
    if not m:
        return None
    headers = {}
    for ln in lines[1:]:
        k, _, v = ln.partition(":")
        headers[k.strip().lower()] = v.strip()
    return int(m.group(1)), headers, body


def reduce_notifications(items):
    out = []
    for t in items:
        subj = t.get("subject") if isinstance(t, dict) else None
        repo = t.get("repository") if isinstance(t, dict) else None
        if not isinstance(subj, dict) or not isinstance(repo, dict) or t.get("reason") != "review_requested" \
                or subj.get("type") != "PullRequest":
            continue
        m = re.search(r"/pulls/(\d+)$", str(subj.get("url") or ""))
        full, html = repo.get("full_name"), repo.get("html_url")
        if not m or not isinstance(full, str) or not REPO_PATH_RE.match(full) or not isinstance(html, str):
            continue
        url = html.rstrip("/") + "/pull/%s" % m.group(1)
        if _url_host(url) is None or not url.endswith("/%s/pull/%s" % (full, m.group(1))):
            continue
        out.append({"repo": full, "n": int(m.group(1)), "title": title_or_none(subj.get("title")), "url": url})
    return out


def reduce_events(items, hostname):
    default = hostname or (os.environ.get("GH_HOST") if HOST_RE.match(os.environ.get("GH_HOST") or "") else None) or "github.com"
    out = []
    for ev in items:
        if not isinstance(ev, dict) or ev.get("type") not in POLL_EVENT_TYPES:
            continue
        r = ev.get("repo")
        name = r.get("name") if isinstance(r, dict) else None
        pl = ev.get("payload") if isinstance(ev.get("payload"), dict) else {}
        if ev["type"] == "IssueCommentEvent":
            src = pl.get("issue") if isinstance(pl.get("issue"), dict) else {}
            if not src.get("pull_request"):
                continue
            n = src.get("number")
        else:
            src = pl.get("pull_request") if isinstance(pl.get("pull_request"), dict) else {}
            n = src.get("number", pl.get("number"))
        if not isinstance(name, str) or not REPO_PATH_RE.match(name) or two_part(name) is None \
                or not isinstance(n, int) or isinstance(n, bool) or n < 1:
            continue
        h = _url_host(src.get("html_url"))
        url = "https://%s/%s/pull/%d" % (h or default, name, n)
        if h and src.get("html_url") != url:
            url = "https://%s/%s/pull/%d" % (default, name, n)
        out.append({"repo": name, "n": n, "url": url, "at": s_or_none(ev.get("created_at"), 40)})
    return out


def op_pr_poll(req):
    args, cfg, pr_host = _setup(req, ("endpoint", "host", "since", "etag", "login", "page"))
    endpoint = args.get("endpoint")
    if endpoint not in ("notifications", "events"):
        raise _bad("endpoint must be notifications or events")
    hostname = arg_host(args)
    since, etag, lg, page = args.get("since"), args.get("etag"), arg_login(args), args.get("page")
    if since is not None and (not isinstance(since, str) or not SINCE_IMF_RE.match(since)):
        raise _bad("since must be an HTTP date such as Sat, 31 Jan 2026 12:00:00 GMT")
    if etag is not None and (not isinstance(etag, str) or not ETAG_RE.match(etag)):
        raise _bad("etag must be a quoted entity tag")
    if page is not None and (not isinstance(page, int) or isinstance(page, bool) or not 1 <= page <= 3):
        raise _bad("page must be 1 to 3")
    if endpoint == "events" and (lg is None or page is not None):
        raise _bad("events need login and take no page")
    if endpoint == "notifications" and lg is not None:
        raise _bad("notifications take no login")
    root = _repoless_root(req)
    host = _gh_only(pr_host, root, "poll")
    path = "notifications?all=false&participating=false&per_page=100&page=%d" % (page or 1) \
        if endpoint == "notifications" else "users/%s/events?per_page=100" % lg
    argv = [host.program, "api", "-i", "--method", "GET"] + (["--hostname", hostname] if hostname else [])
    if since:
        argv += ["-H", "If-Modified-Since: " + since]
    if etag:
        argv += ["-H", "If-None-Match: " + etag]
    code, out, err = run_host(argv + [path], root)
    parsed = parse_http(out)  # gh exits 1 on 304, 403 and 404 but still prints the status line and headers
    if parsed is None:
        if code != 0:
            host_error(host, "poll", code, err)
        raise ActionError("pr_host_failed", "gh: printed no HTTP response")
    status, headers, body = parsed
    items = None
    if status == 200:
        try:
            data = json.loads(body)
        except ValueError:
            data = None
        if not isinstance(data, list):
            raise ActionError("pr_host_failed", "gh: printed no JSON list")
        items = reduce_notifications(data) if endpoint == "notifications" else reduce_events(data, hostname)
        items = items[:MAX_POLL_ITEMS]
    iv = headers.get("x-poll-interval", "")
    res = {"action": "pr_poll", "status": status, "lastModified": s_or_none(headers.get("last-modified"), 64),
           "etag": headers.get("etag") if ETAG_RE.match(headers.get("etag", "")) else None,
           "pollInterval": int(iv) if iv.isdigit() and 0 < int(iv) <= 86400 else None, "items": items}
    while items and len(json.dumps(res)) > MAX_POLL_BYTES:
        items.pop()
    return res


def op_pr_login(req):
    args, cfg, pr_host = _setup(req, ("host",))
    hostname = arg_host(args)
    root = _repoless_root(req)
    host = _gh_only(pr_host, root, "login")
    argv = [host.program, "api"] + (["--hostname", hostname] if hostname else []) + ["user", "--jq", ".login"]
    code, out, err = run_host(argv, root)
    if code != 0:
        host_error(host, "login", code, err)
    v = out.strip()
    if not LOGIN_RE.match(v):
        raise ActionError("pr_host_failed", "gh: printed no user name")
    return {"action": "pr_login", "login": v}


OPS = {"pr_create": op_pr_create, "pr_status": op_pr_status, "pr_checks": op_pr_checks, "pr_comments": op_pr_comments,
       "pr_repo": op_pr_repo, "pr_find": op_pr_find, "pr_search": op_pr_search, "pr_batch": op_pr_batch,
       "pr_poll": op_pr_poll, "pr_login": op_pr_login}
