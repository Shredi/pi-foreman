#!/usr/bin/env python3
"""Count permission decisions per session from the permission system's review log (stdlib, 3.9+).

    python scripts/review_log_stats.py [LOG] [--agent-dir DIR] [--json]

LOG defaults to <agent dir>/extensions/pi-permission-system/logs/
pi-permission-system-permission-review.jsonl (agent dir: --agent-dir, else
$PI_CODING_AGENT_DIR, else ~/.pi/agent).

Per session it counts each ask (requestId) once:
  human_approved / human_denied  the terminal permission_request.approved|denied was decided by
                                 the user (directly, or nested inside a forwarded decision)
  review_allow / review_deny / review_defer
                                 a reviewer model gave that verdict (foreman_review.decision with
                                 a model, or ai_guard.decision)
  forwarded                      the ask came from a subagent (child and parent lines join on
                                 requestId, so it counts once)
The session of an ask is the sessionId of its foreman_review.decision line, else the
targetSessionId of its forwarded_permission.* line, else "unknown". Commands, paths and
reasons are never printed.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

LOG_REL = Path("extensions") / "pi-permission-system" / "logs" / "pi-permission-system-permission-review.jsonl"
FIELDS = ["asks", "human_approved", "human_denied", "review_allow", "review_deny", "review_defer", "forwarded"]


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


def human_kind(decided):
    """'user' if the decision (or the decision nested in a forwarded one) came from the user."""
    if not isinstance(decided, dict):
        return None
    if decided.get("kind") == "forwarded":
        return human_kind(decided.get("decision"))
    return decided.get("kind")


def stats(records):
    asks = {}
    for rec in records:
        rid = rec.get("requestId")
        if not isinstance(rid, str) or not rid:
            continue
        a = asks.setdefault(rid, {"session": None, "fallback": None, "human": None, "review": None, "forwarded": False, "ask": False})
        ev = str(rec.get("event", ""))
        if ev.startswith("permission_request.") or ev.startswith("forwarded_permission."):
            a["ask"] = True
        if ev.startswith("forwarded_permission.") or rec.get("forwarded") is True or (isinstance(rec.get("decidedBy"), dict) and rec["decidedBy"].get("kind") == "forwarded"):
            a["forwarded"] = True
        if ev.startswith("forwarded_permission.") and isinstance(rec.get("targetSessionId"), str):
            a["fallback"] = rec["targetSessionId"]
        if ev == "foreman_review.decision":
            if isinstance(rec.get("sessionId"), str):
                a["session"] = rec["sessionId"]
            if rec.get("model") and rec.get("verdict") in ("allow", "deny", "defer"):
                a["review"] = rec["verdict"]
        elif ev == "ai_guard.decision" and rec.get("verdict") in ("allow", "deny", "defer"):
            a["review"] = rec["verdict"]
        if ev in ("permission_request.approved", "permission_request.denied") and human_kind(rec.get("decidedBy")) == "user":
            a["human"] = "approved" if ev.endswith("approved") else "denied"
    out = {}
    for a in asks.values():
        if not a["ask"]:
            continue
        sid = a["session"] or a["fallback"] or "unknown"
        row = out.setdefault(sid, dict.fromkeys(FIELDS, 0))
        row["asks"] += 1
        if a["human"]:
            row["human_" + a["human"]] += 1
        if a["review"]:
            row["review_" + a["review"]] += 1
        if a["forwarded"]:
            row["forwarded"] += 1
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
