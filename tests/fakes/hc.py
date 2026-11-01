#!/usr/bin/env python3
"""Fake `hc` (herdr-core CLI) for the test rig. Stdlib only; runs on POSIX and Windows.

Installed by tests/fakes/hc_install.py (script on POSIX, hc.cmd + hc.py on win32). Every call appends its argv as a
JSON line to $FAKE_HC_LOG. State lives in the $FAKE_HC_STATE dir as JSON files (terminals.json, events.jsonl).

Environment:
  FAKE_HC_LOG                 argv log file (optional)
  FAKE_HC_STATE               state dir (required except for `machine ls`)
  FAKE_HC_MACHINES            JSON for `machine ls --json` (default: `[]`)
  FAKE_REMOTE_AGENT           the "remote" agent dir; FAKE_SCRIPTS the scripts dir holding foreman_session.py;
  FAKE_REMOTE_HERDR_MACHINES/_AGENTS/_DOWN, FAKE_REMOTE_PATH, FAKE_NO_INTERCOM, FAKE_CLI as for FAKE_SSH in
  tests/test_foreman_session_remote.py
  FAKE_HC_FAIL                any non-empty value: every call exits 3 with `boom` on stderr

Subcommands:
  machine ls --json
  exec --on M [-i] [--timeout S] [--json] -- ARGV...   never runs ARGV: finds `session remote <verb>` in it and runs
      that verb in-process against the remote agent dir (like FAKE_SSH), so a Windows-style argv works on POSIX.
      stdin is the envelope; --json reports {machine, exit, stdout, stderr}.
      PLACEHOLDER names. Settled by the P1 run (Windows remote, hc 0.1.16): the real reply is
      {code, ms, signal, stderr, stdout, timed_out, truncated}, stdout and stderr base64 (bytes in the remote's
      console code page, not always UTF-8), code the exit code. The fake keeps its names until PR 2 swaps them.
      A non-JSON failure prints {"error": {"hint", "kind", "message"}} on stderr (kind e.g. spawn_failed).
  run --on M [--name N] [--label K=V]... [flags] -- ARGV...   prints {"address": "M/tN", "name": N}
  get T [--json]                prints the terminal record
  label T K=V...                sets labels, appends one event per label
  events [--json] [--label K=V] prints the recorded label changes as JSON lines, then exits
  wait T [--json] [--timeout S] returns at once with the current record
  file read --on M PATH [--json] bytes of PATH (relative to, and confined to, $FAKE_HC_STATE)
  kill T / rm T
"""
from __future__ import annotations

import base64
import contextlib
import io
import json
import os
import sys
from pathlib import Path


def log_argv(argv):
    path = os.environ.get("FAKE_HC_LOG")
    if path:
        with open(path, "ab") as f:
            f.write((json.dumps(argv) + "\n").encode("utf-8"))


def state_dir():
    raw = os.environ.get("FAKE_HC_STATE")
    if not raw:
        die("FAKE_HC_STATE not set", 2)
    p = Path(raw)
    p.mkdir(parents=True, exist_ok=True)
    return p


def die(msg, code=1):
    sys.stderr.write(msg + "\n")
    sys.exit(code)


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")


def load_terminals(sd):
    p = sd / "terminals.json"
    return json.loads(p.read_text("utf-8")) if p.exists() else {}


def save_terminals(sd, terminals):
    (sd / "terminals.json").write_text(json.dumps(terminals), "utf-8")


def append_event(sd, event):
    with open(sd / "events.jsonl", "ab") as f:
        f.write((json.dumps(event) + "\n").encode("utf-8"))


def split_dashdash(args):
    if "--" in args:
        i = args.index("--")
        return args[:i], args[i + 1:]
    return args, []


def opt(args, name):
    """Value after `name` (first occurrence), or None."""
    return args[args.index(name) + 1] if name in args and args.index(name) + 1 < len(args) else None


def cmd_machine(args):
    if args[:1] != ["ls"]:
        die("unsupported: machine " + " ".join(args), 2)
    print(os.environ.get("FAKE_HC_MACHINES", "[]"))


def cmd_exec(args):
    head, argv = split_dashdash(args)
    machine = opt(head, "--on")
    if not machine or not argv:
        die("usage: exec --on M [-i] [--timeout S] [--json] -- ARGV...", 2)
    try:
        verb = argv[argv.index("remote", argv.index("session")) + 1]
    except (ValueError, IndexError):
        die("exec: no `session remote <verb>` in argv: " + " ".join(argv), 2)
    data = sys.stdin.buffer.read()
    os.environ["PI_CODING_AGENT_DIR"] = os.environ["FAKE_REMOTE_AGENT"]
    os.environ["FAKE_HERDR_MACHINES"] = os.environ.get("FAKE_REMOTE_HERDR_MACHINES", "[]")
    os.environ["FAKE_HERDR_AGENTS"] = os.environ.get("FAKE_REMOTE_HERDR_AGENTS", "[]")
    os.environ.pop("FAKE_HERDR_DOWN", None)
    if os.environ.get("FAKE_REMOTE_HERDR_DOWN"):
        os.environ["FAKE_HERDR_DOWN"] = "1"
    os.environ.pop("HERDR_PANE_ID", None)
    for k in ("HC_TERMINAL_ID", "HC_SCOPE", "HC_TERMINAL_SOCKET", "HC_BIN"):
        os.environ.pop(k, None)
    if os.environ.get("FAKE_REMOTE_PATH"):
        os.environ["PATH"] = os.environ["FAKE_REMOTE_PATH"]
    sys.path.insert(0, os.environ["FAKE_SCRIPTS"])
    import foreman_session as fsn
    if os.environ.get("FAKE_NO_INTERCOM"):
        fsn.intercom_cli = lambda: None
    elif os.environ.get("FAKE_CLI"):
        fsn.intercom_cli = lambda: Path(os.environ["FAKE_CLI"])
    sys.stdin = io.TextIOWrapper(io.BytesIO(data), encoding="utf-8")
    buf, errbuf = io.StringIO(), io.StringIO()
    try:
        with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(errbuf):
            code = fsn.main(["remote", verb, "--json"])
    except SystemExit as e:
        code = e.code if isinstance(e.code, int) else (0 if e.code is None else 1)
    code = code or 0
    out, err = buf.getvalue().encode("utf-8"), errbuf.getvalue().encode("utf-8")
    if "--json" in head:
        emit({"machine": machine, "exit": code, "stdout": out.decode("utf-8", "replace"),
              "stderr": err.decode("utf-8", "replace")})
        return
    sys.stdout.buffer.write(out)
    sys.stderr.buffer.write(err)
    sys.stdout.flush()
    sys.exit(code)


def cmd_run(args):
    head, argv = split_dashdash(args)
    machine = opt(head, "--on")
    if not machine:
        die("usage: run --on M ... -- ARGV...", 2)
    sd = state_dir()
    terminals = load_terminals(sd)
    address = f"{machine}/t{len(terminals) + 1}"
    name = opt(head, "--name") or address
    labels = {}
    for i, a in enumerate(head):
        if a == "--label" and i + 1 < len(head) and "=" in head[i + 1]:
            k, v = head[i + 1].split("=", 1)
            labels[k] = v
    terminals[address] = {"address": address, "name": name, "machine": machine, "argv": argv,
                          "labels": labels, "status": "working"}
    save_terminals(sd, terminals)
    emit({"address": address, "name": name})


def find(terminals, address):
    if address not in terminals:
        die(f"no such terminal: {address}", 4)
    return terminals[address]


def cmd_get(args):
    terminals = load_terminals(state_dir())
    emit(find(terminals, args[0]))


def cmd_label(args):
    sd = state_dir()
    terminals = load_terminals(sd)
    rec = find(terminals, args[0])
    for kv in args[1:]:
        if "=" not in kv:
            die("label needs K=V: " + kv, 2)
        k, v = kv.split("=", 1)
        rec["labels"][k] = v
        append_event(sd, {"terminal": rec["address"], "label": k, "value": v})
    save_terminals(sd, terminals)
    emit({"address": rec["address"], "labels": rec["labels"]})


def cmd_events(args):
    sd = state_dir()
    want = opt(args, "--label")
    terminals = load_terminals(sd)
    p = sd / "events.jsonl"
    if not p.exists():
        return
    for line in p.read_text("utf-8").splitlines():
        ev = json.loads(line)
        if want:
            k, _, v = want.partition("=")
            if terminals.get(ev["terminal"], {}).get("labels", {}).get(k) != v:
                continue
        sys.stdout.write(line + "\n")


def cmd_wait(args):
    emit(find(load_terminals(state_dir()), args[0]))


def cmd_file(args):
    if args[:1] != ["read"]:
        die("unsupported: file " + " ".join(args), 2)
    rest = args[1:]
    machine = opt(rest, "--on")
    positional = [a for i, a in enumerate(rest) if not a.startswith("--") and (i == 0 or rest[i - 1] != "--on")]
    if not machine or not positional:
        die("usage: file read --on M PATH [--json]", 2)
    sd = state_dir().resolve()
    p = (sd / positional[0]).resolve()
    if sd != p and sd not in p.parents:
        die("path outside FAKE_HC_STATE", 2)
    if not p.is_file():
        die("no such file: " + positional[0], 4)
    data = p.read_bytes()
    if "--json" in rest:
        # PLACEHOLDER shape; the P5 run only read the raw bytes (exact, CRLF kept), `--json` is probed on the rerun.
        emit({"machine": machine, "path": positional[0], "size": len(data),
              "base64": base64.b64encode(data).decode("ascii")})
        return
    sys.stdout.buffer.write(data)
    sys.stdout.flush()


def cmd_kill(args):
    sd = state_dir()
    terminals = load_terminals(sd)
    find(terminals, args[0])["status"] = "finished"
    save_terminals(sd, terminals)


def cmd_rm(args):
    sd = state_dir()
    terminals = load_terminals(sd)
    find(terminals, args[0])
    del terminals[args[0]]
    save_terminals(sd, terminals)


COMMANDS = {"machine": cmd_machine, "exec": cmd_exec, "run": cmd_run, "get": cmd_get, "label": cmd_label,
            "events": cmd_events, "wait": cmd_wait, "file": cmd_file, "kill": cmd_kill, "rm": cmd_rm}


def main(argv):
    log_argv(argv)
    if os.environ.get("FAKE_HC_FAIL"):
        die("boom", 3)
    if not argv or argv[0] not in COMMANDS:
        die("unsupported: " + " ".join(argv), 2)
    COMMANDS[argv[0]](argv[1:])


if __name__ == "__main__":
    main(sys.argv[1:])
