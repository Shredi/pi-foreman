#!/usr/bin/env python3
"""Probe: what `hc` (herdr-core) and `herdr-app` do for a remote machine, before pi-foreman relies on them.

Usage: remote_hc_probe.py --machine NAME --root REMOTE_PI_FOREMAN_ROOT [--out FILE] [--only P1,P3]
Run from the parent machine (macOS/Linux) against one machine of `hc machine ls`. NAME is that hc machine name;
REMOTE_PI_FOREMAN_ROOT is the pi-foreman checkout on the remote (for example C:/Program Files/pi-foreman).
Probes (design/probes/remote-hc.md has the steps and the pass criteria):
  P1 stdin and the Windows foremanArgv form through `hc exec -i --json`, `hc run`/`hc events` flags, foreman.cmd
     (`hc exec --json` returns stdout/stderr base64; each such step gets a `decoded` copy next to the raw)
  P2 remote PATH: python, pi          P3 remote labels in the local `hc events` stream, `:` and 200-byte values (the probe terminal starts through the
     first `hc run` form that returns an address: --bg, no --json, short --timeout; every attempt is recorded)
  P4 `hc wait` returns on a label change   P5 `hc file read` bytes exact (UTF-8, CRLF)
  P6 herdr-app `ls` text (no --json form), commands, a terminal labelled only herdr.space (skipped without herdr-app)
  P7 `hc machine ls` fields, upstream default branch, npm install of pi-intercom v0.18.1 (skipped without git/npm)
Per probe the JSON holds `verdict` (pass, fail, info, skip) and `steps`, each {argv, exit, stdout, stderr, seconds}.
All remote output is data: it is parsed or printed, never executed. Everything this script creates (a probe terminal,
a remote temp dir, a local temp dir) is removed in a finally block; it writes nowhere else. Stdlib only, Python 3.9+.
"""
import argparse
import base64
import hashlib
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import threading
import time

CAP = 20000
SLEEPER = ["python", "-c", "import time; time.sleep(120)"]
P5_BYTES = b"caf\xc3\xa9 \xe2\x9c\x93 line one\r\nline two\r\n"
P5_WRITE = ("import os, tempfile; d = tempfile.mkdtemp(prefix='fm-probe-'); p = os.path.join(d, 'probe.txt'); "
            "open(p, 'wb').write(b'caf\\xc3\\xa9 \\xe2\\x9c\\x93 line one\\r\\nline two\\r\\n'); print(p)")
P5_RM = "import shutil, sys; shutil.rmtree(sys.argv[1], True)"


def clip(s):
    return s if len(s) <= CAP else s[:CAP] + "...[cut]"


def text(b):
    return b.decode("utf-8", "replace") if isinstance(b, bytes) else (b or "")


def run(argv, stdin=None, timeout=60, binary=False):
    """One subprocess call (argv list, no shell) -> step record. Never raises."""
    t = time.perf_counter()
    try:
        r = subprocess.run(argv, input=stdin.encode() if stdin is not None else None, capture_output=True,
                           timeout=timeout)
        code, out, err = r.returncode, r.stdout, r.stderr
    except subprocess.TimeoutExpired as e:
        code, out, err = "timeout", e.stdout or b"", e.stderr or b""
    except OSError as e:
        code, out, err = "oserror", b"", str(e).encode()
    rec = {"argv": argv, "exit": code, "stdout": clip(text(out)), "stderr": clip(text(err)),
           "seconds": round(time.perf_counter() - t, 2)}
    if binary:
        rec["_raw"] = out
    return rec


def parse_json(s):
    try:
        return json.loads(s)
    except ValueError:
        return None


def decode_bytes(b):
    """Windows console output is not always UTF-8 (German OEM code page 850): try UTF-8, then cp850."""
    try:
        return b.decode("utf-8"), "utf-8"
    except UnicodeDecodeError:
        return b.decode("cp850", "replace"), "cp850"


def decode_exec(rec):
    """`hc exec --json` replies carry stdout and stderr base64: add a readable `decoded` copy, keep the raw."""
    reply = parse_json(rec["stdout"])
    if not isinstance(reply, dict):
        return rec
    dec = {}
    for k, v in reply.items():
        if k in ("stdout", "stderr") and isinstance(v, str):
            try:
                dec[k], dec[k + "_encoding"] = decode_bytes(base64.b64decode(v, validate=True))
            except ValueError:
                dec[k] = v
        else:
            dec[k] = v
    rec["decoded"] = dec
    return rec


def find_address(rec):
    """Terminal address (`<machine>/t<n>`) from an `hc run --json` reply, tolerant of the field name."""
    m = re.search(r"[\w.-]+/t\d+", rec["stdout"])
    return m.group(0) if m else None


def find_by_name(obj, names):
    """Address of the first dict named in `names` anywhere in a parsed `hc ls --json` reply."""
    if isinstance(obj, dict):
        if obj.get("name") in names:
            m = re.search(r"[\w.-]+/t\d+", json.dumps(obj))
            if m:
                return m.group(0)
        for v in obj.values():
            a = find_by_name(v, names)
            if a:
                return a
    elif isinstance(obj, list):
        for v in obj:
            a = find_by_name(v, names)
            if a:
                return a
    return None


class Ctx:
    def __init__(self, machine, root):
        self.machine, self.root = machine, root
        self.terminals = []
        self.run_form = None
        self.remote_dirs = []
        self.tmp = tempfile.mkdtemp(prefix="fm-remote-probe-")

    def hc(self, *args, **kw):
        step = run(["hc", *args], **kw)
        return decode_exec(step) if args[:1] == ("exec",) and "--json" in args else step

    def start_terminal(self, name_hint, labels=()):
        """Start the sleeper through the first `hc run` form that returns an address.

        Plain `hc run` is a foreground run that waits (default 180 s), so a detached start needs --bg, or a reply
        without --json, or a short --timeout (the wait checks in and leaves it running). The form that worked is
        tried first by later calls. Returns (step, address); step["attempts"] lists every try.
        """
        forms = [("bg-json", ["--json", "--bg"]), ("bg-text", ["--bg"]), ("timeout-json", ["--json", "--timeout", "5"])]
        forms.sort(key=lambda f: f[0] != self.run_form)
        attempts, names = [], []
        for form, flags in forms:
            name = f"fm-probe-{name_hint}-{secrets.token_hex(3)}"
            names.append(name)
            argv = ["run", *flags, "--on", self.machine, "--name", name]
            for lab in labels:
                argv += ["--label", lab]
            step = self.hc(*argv, "--", *SLEEPER, timeout=20)
            step["form"] = form
            attempts.append(step)
            addr = find_address(step)
            if addr:
                self.terminals.append(addr)
                self.run_form = form
                return dict(step, attempts=attempts), addr
        ls = self.hc("ls", "--json", timeout=30)
        addr = find_by_name(parse_json(ls["stdout"]), names)
        if addr:
            self.terminals.append(addr)
        return dict(attempts[-1], attempts=attempts + [ls]), addr

    def cleanup(self):
        for addr in self.terminals:
            self.hc("kill", addr, timeout=30)
            self.hc("rm", addr, timeout=30)
        for d in self.remote_dirs:
            self.hc("exec", "--on", self.machine, "--timeout", "30", "--", "python", "-c", P5_RM, d, timeout=60)
        shutil.rmtree(self.tmp, ignore_errors=True)


def p1(c):
    argv = ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", f"{c.root}/bin/foreman.ps1"]
    tail = ["session", "remote", "probe", "--json"]
    ps = c.hc("exec", "--on", c.machine, "-i", "--json", "--timeout", "30", "--", *argv, *tail, stdin="{}")
    cmd = c.hc("exec", "--on", c.machine, "-i", "--json", "--timeout", "30", "--", f"{c.root}/bin/foreman.cmd", *tail,
               stdin="{}")
    run_help = c.hc("run", "--help")
    ev_help = c.hc("events", "--help")
    flags = {"run --no-parent": "--no-parent" in run_help["stdout"], "run --label": "--label" in run_help["stdout"],
             "events --label": "--label" in ev_help["stdout"]}
    def said(rec):
        return "bad_request" in json.dumps(rec.get("decoded", {})) or "bad_request" in rec["stdout"]

    reply = parse_json(ps["stdout"])
    return {"verdict": "pass" if said(ps) else "fail", "steps": [ps, cmd, run_help, ev_help],
            "facts": {"exec_json_keys": sorted(reply) if isinstance(reply, dict) else None, "flags": flags,
                      "foreman_cmd_resolves": said(cmd)}}


def p2(c):
    py = c.hc("exec", "--on", c.machine, "--timeout", "30", "--", "python", "-c",
              "import sys;print(sys.executable, sys.platform)")
    pi = c.hc("exec", "--on", c.machine, "--timeout", "30", "--", "pi", "--version")
    return {"verdict": "pass" if py["exit"] == 0 and pi["exit"] == 0 else "fail", "steps": [py, pi]}


def collect(proc, lines):
    for raw in proc.stdout:
        lines.append(raw.decode("utf-8", "replace"))


def p3(c):
    start, addr = c.start_terminal("p3")
    if not addr:
        return {"verdict": "fail", "steps": [start], "note": "no terminal address in the hc run reply"}
    digest = secrets.token_hex(32)
    short = f"1:plan:{digest}:12345"
    long = "a" * 200
    lines = []
    ev = subprocess.Popen(["hc", "events", "--json"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    th = threading.Thread(target=collect, args=(ev, lines), daemon=True)
    th.start()
    try:
        time.sleep(2)
        l1 = c.hc("label", addr, f"fm.probe={short}")
        time.sleep(2)
        l2 = c.hc("label", addr, f"fm.probe2={long}")
        time.sleep(3)
        got = c.hc("get", addr, "--json")
    finally:
        ev.terminate()
        ev.wait()
        th.join(5)
    stream = "".join(lines)
    facts = {"short_label_in_events": short in stream, "long_label_in_events": long in stream,
             "short_label_in_get": short in got["stdout"], "long_label_in_get": long in got["stdout"],
             "event_lines": len(lines)}
    ok = all(facts[k] for k in ("short_label_in_events", "long_label_in_events"))
    verdict = "pass" if ok else ("info" if facts["short_label_in_get"] and facts["long_label_in_get"] else "fail")
    return {"verdict": verdict, "steps": [start, l1, l2, got], "facts": facts,
            "events_stream": clip(stream), "note": "info = labels kept on the terminal but absent from local events"}


def p4(c):
    start, addr = c.start_terminal("p4")
    if not addr:
        return {"verdict": "fail", "steps": [start], "note": "no terminal address in the hc run reply"}
    t0 = time.perf_counter()
    w = subprocess.Popen(["hc", "wait", addr, "--json", "--timeout", "20"], stdout=subprocess.PIPE,
                         stderr=subprocess.PIPE)
    time.sleep(3)
    lab = c.hc("label", addr, "fm.probe=wait-" + secrets.token_hex(3))
    t_label = time.perf_counter() - t0
    try:
        out, err = w.communicate(timeout=25)
    except subprocess.TimeoutExpired:
        w.kill()
        out, err = w.communicate()
    took = time.perf_counter() - t0
    wait = {"argv": w.args, "exit": w.returncode, "stdout": clip(text(out)), "stderr": clip(text(err)),
            "seconds": round(took, 2)}
    early = took < 15
    return {"verdict": "pass" if early else "fail", "steps": [start, lab, wait],
            "facts": {"label_set_at_s": round(t_label, 2), "returned_at_s": round(took, 2)},
            "note": "pass = hc wait returned well before its 20 s timeout after the label change"}


def p5(c):
    mk = c.hc("exec", "--on", c.machine, "--timeout", "30", "--", "python", "-c", P5_WRITE)
    lines = mk["stdout"].strip().splitlines()
    if mk["exit"] != 0 or not lines:
        return {"verdict": "fail", "steps": [mk], "note": "could not create the remote file"}
    path = lines[-1].strip()
    c.remote_dirs.append(re.sub(r"[\\/][^\\/]*$", "", path))
    rd = c.hc("file", "read", "--on", c.machine, path, binary=True, timeout=60)
    raw = rd.pop("_raw", b"")
    rj = c.hc("file", "read", "--json", "--on", c.machine, path, timeout=60)
    rjd = parse_json(rj["stdout"])
    want = hashlib.sha256(P5_BYTES).hexdigest()
    got = hashlib.sha256(raw).hexdigest()
    return {"verdict": "pass" if raw == P5_BYTES else "fail", "steps": [mk, rd, rj],
            "facts": {"file_read_json_keys": sorted(rjd) if isinstance(rjd, dict) else None, "expected_sha256": want, "got_sha256": got, "expected_len": len(P5_BYTES), "got_len": len(raw),
                      "got_hex_head": raw[:64].hex(), "crlf_kept": b"\r\n" in raw}}


def find_spaces(obj, machine, out):
    if isinstance(obj, dict):
        if obj.get("machine") == machine:
            out.append(obj)
        for v in obj.values():
            find_spaces(v, machine, out)
    elif isinstance(obj, list):
        for v in obj:
            find_spaces(v, machine, out)
    return out


def p6(c):
    if not shutil.which("herdr-app"):
        return {"verdict": "skip", "steps": [], "note": "herdr-app not on PATH"}
    ls = run(["herdr-app", "ls"])  # usage: herdr-app ls | commands | status | shot | do; no --json
    cmds = run(["herdr-app", "commands"])
    wanted = [ln for ln in cmds["stdout"].splitlines() if re.search(r"space\.new|tab\.new|agent\.focus", ln)]
    parsed = parse_json(ls["stdout"])
    spaces = find_spaces(parsed, c.machine, [])
    lines = [ln for ln in ls["stdout"].splitlines() if c.machine in ln]
    res = {"verdict": "info", "steps": [ls, cmds],
           "facts": {"spaces_for_machine": spaces, "ls_lines_naming_machine": lines, "command_lines": wanted}}
    sid = next((s.get("id") for s in spaces if s.get("id")), None)
    if not sid and parsed is None and lines:  # text output: the first word of the line is a guess at the id
        sid = lines[0].split()[0].lstrip("*>-")
        res["facts"]["space_id_guess"] = sid
    if not sid:
        res["note"] = "no `herdr-app ls` line names the machine; create a space on it in the app, then rerun --only P6"
        return res
    start, addr = c.start_terminal("p6", [f"herdr.space={sid}"])
    res["steps"].append(start)
    if addr:
        time.sleep(4)
        res["steps"].append(run(["herdr-app", "ls"]))
    res["note"] = ("look in the app: does a terminal labelled only herdr.space=<id> appear in a tab of that space "
                   "(the sheet asks you to write yes/no)")
    return res


def p7(c):
    ml = c.hc("machine", "ls", "--json")
    data = parse_json(ml["stdout"])
    items = data if isinstance(data, list) else (data.get("machines") if isinstance(data, dict) else None)
    first = items[0] if isinstance(items, list) and items and isinstance(items[0], dict) else {}
    res = {"verdict": "info", "steps": [ml], "facts": {"machine_ls_fields": sorted(first)}}
    if shutil.which("git"):
        res["steps"].append(run(["git", "ls-remote", "--symref", "https://github.com/nicobailon/pi-intercom", "HEAD"],
                                timeout=60))
    else:
        res["facts"]["git"] = "missing, default branch not probed"
    if shutil.which("npm"):
        d = os.path.join(c.tmp, "npm")
        os.mkdir(d)
        inst = run(["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", d,
                    "github:nicobailon/pi-intercom#v0.18.1"], timeout=300)
        hits = []
        for base, _dirs, files in os.walk(os.path.join(d, "node_modules")):
            if "cli.mjs" in files:
                hits.append(os.path.relpath(os.path.join(base, "cli.mjs"), d))
            if base.count(os.sep) - d.count(os.sep) > 4:
                _dirs[:] = []
        res["steps"].append(inst)
        res["facts"]["cli_mjs_without_build"] = hits
    else:
        res["facts"]["npm"] = "missing, install not probed"
    return res


PROBES = {"P1": p1, "P2": p2, "P3": p3, "P4": p4, "P5": p5, "P6": p6, "P7": p7}


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--machine", required=True)
    ap.add_argument("--root", required=True, help="pi-foreman root on the remote")
    ap.add_argument("--out", default=None, help="results file (default: a new temp dir; the path is printed)")
    ap.add_argument("--only", default="", help="comma list, e.g. P1,P3")
    a = ap.parse_args()
    names = [n.strip().upper() for n in a.only.split(",") if n.strip()] or list(PROBES)
    bad = [n for n in names if n not in PROBES]
    if bad:
        sys.exit("unknown probe: " + ",".join(bad))
    if not shutil.which("hc"):
        sys.exit("hc not on PATH")
    c = Ctx(a.machine, a.root)
    results = {"machine": a.machine, "root": a.root, "probes": {}}
    try:
        for n in names:
            t = time.perf_counter()
            try:
                r = PROBES[n](c)
            except Exception as e:  # a probe bug must not skip the cleanup or the other probes
                r = {"verdict": "fail", "steps": [], "note": f"probe error: {e!r}"}
            r["seconds"] = round(time.perf_counter() - t, 2)
            for s in r["steps"]:
                s.pop("_raw", None)
            results["probes"][n] = r
    finally:
        c.cleanup()
    if not a.out:
        a.out = os.path.join(tempfile.mkdtemp(prefix="remote-hc-probe-"), "results.json")
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(results, f, indent=2, ensure_ascii=False)
    print(f"{'probe':<6}{'verdict':<9}{'seconds':>8}  note")
    for n, r in results["probes"].items():
        print(f"{n:<6}{r['verdict']:<9}{r['seconds']:>8}  {r.get('note', '')[:60]}")
    print(f"results: {os.path.abspath(a.out)} (paste into the plan under '## Addendum: probe results')")


if __name__ == "__main__":
    main()
