#!/usr/bin/env python3
"""Report newer versions of the pinned packages (stdlib, 3.9+). Changes nothing.

    python scripts/foreman_update_check.py [--lock FILE] [--json]

Reads packages.lock.json, asks the npm registry (10 s timeout) for each package and prints the
pinned version, the latest version, up to five newer versions with publish dates and the release
notes URL of the latest. Offline or an HTTP error gives one line per package and exit 0; exit 2
only when the lock is unreadable. Packages that are not pinned in the lock (the Claude bridge) are
listed as "not pinned" with their latest version.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REGISTRY = "https://registry.npmjs.org/"
TIMEOUT = 10
FOOTER = "Nothing was changed. To update, re-run the installer (setup.mjs) after raising the pin."

# Packages the harness works with but does not pin in the lock.
UNPINNED = [
    {"name": "pi-claude-bridge", "notes": "https://github.com/elidickinson/pi-claude-bridge/tree/v{version}"},
]


def vkey(v):
    return [int(x) if x.isdigit() else 0 for x in re.split(r"[.\-+]", v.split("-", 1)[0])] + [1 if "-" not in v else 0]


def is_stable(v):
    return re.fullmatch(r"\d+\.\d+\.\d+", v) is not None


def fetch(name):
    url = REGISTRY + urllib.parse.quote(name, safe="@").replace("/", "%2F")  # scoped: @scope%2Fname
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:  # noqa: S310 (fixed https registry)
        return json.loads(resp.read().decode("utf-8"))


def check(entry, fetcher=fetch):
    name, pinned, tmpl = entry["name"], entry.get("version"), entry.get("notes")
    row = {"name": name, "pinned": pinned, "latest": None, "newer": [], "notes": None, "error": None}
    try:
        doc = fetcher(name)
    except Exception as exc:  # offline, DNS, HTTP error, bad JSON: one line, exit 0
        code = getattr(exc, "code", None)
        row["error"] = "HTTP %s" % code if code else "registry unreachable (%s)" % type(exc).__name__
        return row
    tags = doc.get("dist-tags") if isinstance(doc, dict) else None
    latest = tags.get("latest") if isinstance(tags, dict) else None
    if not isinstance(latest, str):
        row["error"] = "no latest version in the registry answer"
        return row
    row["latest"] = latest
    times = doc.get("time") if isinstance(doc.get("time"), dict) else {}
    versions = doc.get("versions") if isinstance(doc.get("versions"), dict) else {}
    if pinned:
        newer = [v for v in (versions or times) if is_stable(v) and vkey(v) > vkey(pinned)]
        newer.sort(key=vkey)
        row["newer"] = [{"version": v, "published": str(times.get(v, ""))[:10] or None} for v in newer]
    if tmpl:
        row["notes"] = tmpl.replace("{version}", latest)
    return row


def entries(lock):
    out = []
    pi = lock.get("pi")
    if isinstance(pi, dict) and pi.get("name"):
        out.append(pi)
    out += [p for p in lock.get("packages") or [] if isinstance(p, dict) and p.get("mode") != "local" and p.get("name")]
    return out


def render(rows):
    lines = []
    for r in rows:
        if r["error"]:
            lines.append("%s: could not check (%s)" % (r["name"], r["error"]))
            continue
        lines.append("%s: %s, latest %s" % (r["name"], "pinned " + r["pinned"] if r["pinned"] else "not pinned", r["latest"]))
        n = r["newer"]
        if n:
            shown = ", ".join("%s (%s)" % (x["version"], x["published"] or "?") for x in n[-5:])
            lines.append("  %d newer: %s%s" % (len(n), "... " if len(n) > 5 else "", shown))
        elif r["pinned"]:
            lines.append("  up to date")
        if r["notes"]:
            lines.append("  notes: " + r["notes"])
    lines.append(FOOTER)
    return "\n".join(lines)


def main(argv=None, fetcher=fetch):
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("--lock", default=str(ROOT / "packages.lock.json"))
    p.add_argument("--json", action="store_true")
    args = p.parse_args(argv)
    try:
        lock = json.loads(Path(args.lock).read_text(encoding="utf-8"))
        if not isinstance(lock, dict):
            raise ValueError("not an object")
    except (OSError, ValueError) as exc:
        print("cannot read %s: %s" % (args.lock, getattr(exc, "strerror", None) or exc), file=sys.stderr)
        return 2
    pinned = entries(lock)
    names = {e.get("name") for e in pinned}
    rows = [check(e, fetcher) for e in pinned] + [check(e, fetcher) for e in UNPINNED if e["name"] not in names]
    if args.json:
        print(json.dumps({"packages": rows, "note": FOOTER}, indent=2))
    else:
        print(render(rows))
    return 0


if __name__ == "__main__":
    sys.exit(main())
