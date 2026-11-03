#!/usr/bin/env python3
"""Fake `hc` (herdr-core CLI) for the test rig. Stdlib only; runs on POSIX and Windows.

Installed by tests/fakes/hc_install.py (script on POSIX, hc.cmd + hc.py on win32). Every call appends its argv as a
JSON line to $FAKE_HC_LOG. State lives in the $FAKE_HC_STATE dir as JSON files (terminals.json, events.jsonl).

Environment:
  FAKE_HC_LOG                 argv log file (optional)
  FAKE_HC_STATE               state dir (required except for `machine ls`, `server status` and `exec`)
  FAKE_HC_MACHINES            JSON list for `machine ls --json`: each item a machine name or a full row (default: `[]`)
  FAKE_HC_CORE_DOWN           any non-empty value: `server status` exits 1 (no core answering)
  FAKE_HC_EXEC_MODE           exec failure modes: `timed_out` (hc's own timeout: the reply says timed_out), `spawn_failed`
                              (exit 1, JSON error on stderr), `garbage` (the verb's stdout is not JSON), `cp850` (the reply's
                              stderr is cp850 bytes)
  FAKE_HC_EXEC_LOG            file: every exec appends {"argv", "stdin"} as a JSON line
  FAKE_REMOTE_AGENT           the "remote" agent dir; FAKE_SCRIPTS the scripts dir holding foreman_session.py;
  FAKE_REMOTE_PATH, FAKE_CLI, FAKE_SSH_PROTOCOL (the remote's
  REMOTE_PROTOCOL) and FAKE_REMOTE_HC_DOWN (the remote's `server status` fails) configure the remote side of `exec`
  FAKE_HC_FAIL                any non-empty value: every call exits 3 with `boom` on stderr

Subcommands:
  machine ls --json            prints {"machines": [{host, id, name, session, state, target, temporary, version, via}]}
  server status --json         prints {"state": "up", "version": "0.0.0-fake"}; exits 1 when FAKE_HC_CORE_DOWN
  exec --on M [-i] [--timeout S] [--json] -- ARGV...   never runs ARGV: finds `session remote <verb>` in it and runs
      that verb in-process against the remote agent dir, so a Windows-style argv works on POSIX. stdin is the request.
      --json prints the real reply {code, ms, signal, stderr, stdout, timed_out, truncated}: stdout and stderr base64,
      code the verb's exit code. A `pi-intercom ...` ARGV (no `session`) runs as a subprocess, stdin
      passed through, code its exit code. A failure of hc itself prints {"error": {"hint", "kind", "message"}} on stderr (exit 1).
  run [--on M] [--name N] [--label K=V]... [flags] -- ARGV...   prints {address, agent, cwd, name, parent, state, turn};
      the address is `tN` (`M/tN` with --on)
  get T [--json]                prints the terminal record
  label T K=V...                sets labels, appends one event per label
  events [--json] [--label K=V] prints the recorded label changes as JSON lines, then exits
  wait T [--json] [--timeout S] returns at once with the current record
  file read --on M PATH [--json] PATH relative to, and confined to, $FAKE_HC_STATE; --json prints {first, last, lines, text}
  kill T / rm T
"""
from __future__ import annotations

import base64
import contextlib
import io
import json
import os
import shutil
import subprocess
import sys
import time
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


def machine_row(item):
    if isinstance(item, dict):
        return item
    return {"host": item + ".example.invalid", "id": "m-" + item, "name": item, "session": "s1", "state": "up",
            "target": item, "temporary": False, "version": "0.0.0-fake", "via": "ssh"}


def cmd_machine(args):
    if args[:1] != ["ls"]:
        die("unsupported: machine " + " ".join(args), 2)
    emit({"machines": [machine_row(i) for i in json.loads(os.environ.get("FAKE_HC_MACHINES", "[]"))]})


def cmd_server(args):
    if args[:1] != ["status"]:
        die("unsupported: server " + " ".join(args), 2)
    if os.environ.get("FAKE_HC_CORE_DOWN"):
        die("no herdr-core answering", 1)
    emit({"state": "up", "version": "0.0.0-fake"})


def cmd_exec(args):
    head, argv = split_dashdash(args)
    machine = opt(head, "--on")
    if not machine or not argv:
        die("usage: exec --on M [-i] [--timeout S] [--json] -- ARGV...", 2)
    data = sys.stdin.buffer.read()
    if os.environ.get("FAKE_HC_EXEC_LOG"):
        with open(os.environ["FAKE_HC_EXEC_LOG"], "ab") as f:
            f.write((json.dumps({"argv": argv, "stdin": data.decode("utf-8", "replace")}) + "\n").encode("utf-8"))
    mode = os.environ.get("FAKE_HC_EXEC_MODE", "")
    if mode == "spawn_failed":
        sys.stderr.write(json.dumps({"error": {"hint": "check the path", "kind": "spawn_failed",
                                               "message": "cannot start %s on %s" % (argv[0], machine)}}) + "\n")
        sys.exit(1)
    started = time.time()
    if mode == "timed_out":
        out, err, code, timed_out = b"", b"", None, True
    else:
        timed_out = False
        if "session" not in argv and Path(argv[0]).stem == "pi-intercom":
            out, err, code = run_program(argv, data)
        else:
            try:
                verb = argv[argv.index("remote", argv.index("session")) + 1]
            except (ValueError, IndexError):
                die("exec: no `session remote <verb>` in argv: " + " ".join(argv), 2)
            out, err, code = run_verb(verb, data)
        if mode == "garbage":
            out = b"not json at all\n"
        if mode == "cp850":
            err = "caf\u00e9 failed".encode("cp850")
    reply = {"code": code, "ms": int((time.time() - started) * 1000), "signal": None,
             "stderr": base64.b64encode(err).decode("ascii"), "stdout": base64.b64encode(out).decode("ascii"),
             "timed_out": timed_out, "truncated": False}
    if "--json" in head:
        emit(reply)
        return
    sys.stdout.buffer.write(out)
    sys.stderr.buffer.write(err)
    sys.stdout.flush()
    sys.exit(code or 0)


def run_program(argv, data):
    """Run a program that is not a `session` verb (e.g. `pi-intercom relay`) as a subprocess, stdin passed through."""
    exe = shutil.which(argv[0]) or argv[0]
    try:
        r = subprocess.run([exe, *argv[1:]], input=data, capture_output=True)
    except OSError as e:
        return b"", str(e).encode("utf-8"), 127
    return r.stdout, r.stderr, r.returncode


def run_verb(verb, data):
    """Run `session remote <verb> --json` in-process against the remote agent dir; (stdout, stderr, exit code)."""
    os.environ["PI_CODING_AGENT_DIR"] = os.environ["FAKE_REMOTE_AGENT"]
    os.environ.pop("FAKE_HC_CORE_DOWN", None)
    if os.environ.get("FAKE_REMOTE_HC_DOWN"):
        os.environ["FAKE_HC_CORE_DOWN"] = "1"
    os.environ.pop("HERDR_PANE_ID", None)
    for k in ("HC_TERMINAL_ID", "HC_SCOPE", "HC_TERMINAL_SOCKET", "HC_BIN"):
        os.environ.pop(k, None)
    if os.environ.get("FAKE_REMOTE_PATH"):
        os.environ["PATH"] = os.environ["FAKE_REMOTE_PATH"]
    sys.path.insert(0, os.environ["FAKE_SCRIPTS"])
    import foreman_session as fsn
    if os.environ.get("FAKE_CLI"):
        fsn.intercom_cli = lambda: Path(os.environ["FAKE_CLI"])
    if os.environ.get("FAKE_SSH_PROTOCOL"):
        fsn.REMOTE_PROTOCOL = int(os.environ["FAKE_SSH_PROTOCOL"])
    sys.stdin = io.TextIOWrapper(io.BytesIO(data), encoding="utf-8")
    buf, errbuf = io.StringIO(), io.StringIO()
    try:
        with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(errbuf):
            code = fsn.main(["remote", verb, "--json"])
    except SystemExit as e:
        code = e.code if isinstance(e.code, int) else (0 if e.code is None else 1)
    return buf.getvalue().encode("utf-8"), errbuf.getvalue().encode("utf-8"), code or 0


def cmd_run(args):
    head, argv = split_dashdash(args)
    machine = opt(head, "--on")
    sd = state_dir()
    terminals = load_terminals(sd)
    address = f"t{len(terminals) + 1}"
    if machine:
        address = f"{machine}/{address}"
    name = opt(head, "--name") or address
    labels = {}
    for i, a in enumerate(head):
        if a == "--label" and i + 1 < len(head) and "=" in head[i + 1]:
            k, v = head[i + 1].split("=", 1)
            labels[k] = v
    terminals[address] = {"address": address, "name": name, "machine": machine, "argv": argv,
                          "labels": labels, "status": "working"}
    save_terminals(sd, terminals)
    emit({"address": address, "agent": None, "cwd": opt(head, "--cwd"), "name": name, "parent": None,
          "state": "working", "turn": 0})


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
        text = data.decode("utf-8", "replace")
        n = len(text.splitlines())
        emit({"first": 1 if n else 0, "last": n, "lines": n, "text": text})
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


COMMANDS = {"machine": cmd_machine, "server": cmd_server, "exec": cmd_exec, "run": cmd_run, "get": cmd_get,
            "label": cmd_label, "events": cmd_events, "wait": cmd_wait, "file": cmd_file, "kill": cmd_kill, "rm": cmd_rm}


def main(argv):
    log_argv(argv)
    if os.environ.get("FAKE_HC_FAIL"):
        die("boom", 3)
    if not argv or argv[0] not in COMMANDS:
        die("unsupported: " + " ".join(argv), 2)
    COMMANDS[argv[0]](argv[1:])


if __name__ == "__main__":
    main(sys.argv[1:])
