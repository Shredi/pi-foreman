#!/usr/bin/env python3
"""Count gate decisions per session from the gate log (stdlib, 3.13+).

    python scripts/review_log_stats.py [LOG] [--agent-dir DIR] [--json]

LOG defaults to <agent dir>/pi-foreman/state/gate/log.jsonl (agent dir: --agent-dir, else
$PI_CODING_AGENT_DIR, else ~/.pi/agent).

Per session it counts each decision record (gatelog.ts; the record's own id counts once):
  decisions                      every gate record
  floor_deny / default_allow     a floor denied, or a default policy entry allowed
  review_allow / review_deny / review_ask
                                 the reviewer model decided that verdict (layer review)
  review_unreachable             the reviewer gave no usable verdict (layer review, verdict
                                 unreachable; the call then asked or denied)
  cached                         the verdict came from the decision cache (layer cache or cached)
  human_approved / human_denied  a dialog was answered by the user (layer dialog)
  no_dialog                      a dialog was due but none could open (reason no-dialog)
  child                          the call came from a child or headless session (kind child, headless)
The session of a decision is its `session` field, else "unknown". Commands, paths and reasons
are never printed.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

LOG_REL = Path("pi-foreman") / "state" / "gate" / "log.jsonl"
FIELDS = ["decisions", "floor_deny", "default_allow", "review_allow", "review_deny", "review_ask", "review_unreachable", "cached", "human_approved", "human_denied", "no_dialog", "child"]


def agent_dir(arg):
    if arg:
        return Path(arg)
    env = os.environ.get("PI_CODING_AGENT_DIR")
    return Path(env) if env else Path.home() / ".pi" / "agent"


def read_records(lines):
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        if isinstance(rec, dict):
            yield rec


def stats(records):
    out = {}
    seen = set()
    for rec in records:
        rid = rec.get("id")
        if isinstance(rid, str) and rid:
            if rid in seen:
                continue
            seen.add(rid)
        sid = rec.get("session")
        row = out.setdefault(sid if isinstance(sid, str) and sid else "unknown", dict.fromkeys(FIELDS, 0))
        layer, verdict = rec.get("layer"), rec.get("verdict")
        row["decisions"] += 1
        if rec.get("kind") in ("child", "headless"):
            row["child"] += 1
        if rec.get("cached") is True or layer == "cache":
            row["cached"] += 1
        elif layer == "floor" and verdict == "deny":
            row["floor_deny"] += 1
        elif layer == "default" and verdict == "allow":
            row["default_allow"] += 1
        elif layer == "review" and verdict in ("allow", "deny", "ask", "unreachable"):
            row["review_" + verdict] += 1
        elif layer == "dialog":
            if rec.get("reason") == "no-dialog":
                row["no_dialog"] += 1
            elif verdict == "allow":
                row["human_approved"] += 1
            elif verdict == "deny":
                row["human_denied"] += 1
    return out


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("log", nargs="?")
    p.add_argument("--agent-dir")
    p.add_argument("--json", action="store_true")
    args = p.parse_args(argv)
    path = Path(args.log) if args.log else agent_dir(args.agent_dir) / LOG_REL
    try:
        with open(path, encoding="utf-8") as f:
            result = stats(read_records(f))
    except OSError as exc:
        print("cannot read %s: %s" % (path, exc.strerror), file=sys.stderr)
        return 2
    if args.json:
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0
    print("session\t" + "\t".join(FIELDS))
    for sid in sorted(result):
        print(sid + "\t" + "\t".join(str(result[sid][k]) for k in FIELDS))
    return 0


if __name__ == "__main__":
    sys.exit(main())
