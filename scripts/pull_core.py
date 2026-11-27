#!/usr/bin/env python3
"""Check or re-hash core/MANIFEST.

    python scripts/pull_core.py --check           (verify core/ against MANIFEST)
    python scripts/pull_core.py --write-manifest  (re-hash core/ after a hand edit)

core/ is pi-foreman's own legacy Python, changed by hand. Every edit must
update the MANIFEST hashes: run --write-manifest, and --check (also
tests/test_core_pin.py) fails until it matches. Bytes are hashed as stored;
the repo-root .gitattributes marks core/** as -text so hashes match on every OS.

Both modes ignore MANIFEST itself, __pycache__/ and .pytest_cache/ and *.pyc files.
"""
from __future__ import annotations

import argparse
import hashlib
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CORE = ROOT / "core"

GENERATED = ("MANIFEST",)
IGNORED_PARTS = ("__pycache__", ".pytest_cache")


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def manifest_lines(base: Path):
    """Sorted '<sha256>  <posix path>' lines for every file under base."""
    out = []
    for p in base.rglob("*"):
        rel = p.relative_to(base)
        if not p.is_file() or rel.as_posix() in GENERATED:
            continue
        if any(part in IGNORED_PARTS for part in rel.parts) or p.suffix == ".pyc":
            continue
        out.append("%s  %s" % (sha256(p.read_bytes()), rel.as_posix()))
    return sorted(out, key=lambda line: line.split("  ", 1)[1])


def write_manifest() -> int:
    lines = manifest_lines(CORE)
    (CORE / "MANIFEST").write_bytes(("\n".join(lines) + "\n").encode())
    print("wrote core/MANIFEST (%d files)" % len(lines))
    return 0


def check() -> int:
    mf = CORE / "MANIFEST"
    if not mf.is_file():
        print("core/MANIFEST missing")
        return 1
    want = {}
    for line in mf.read_text(encoding="utf-8").splitlines():
        digest, _, rel = line.partition("  ")
        want[rel] = digest
    have = {}
    for line in manifest_lines(CORE):
        digest, _, rel = line.partition("  ")
        have[rel] = digest
    problems = (
        ["missing: " + r for r in sorted(set(want) - set(have))]
        + ["extra: " + r for r in sorted(set(have) - set(want))]
        + ["changed: " + r for r in sorted(set(want) & set(have)) if want[r] != have[r]]
    )
    for p in problems:
        print(p)
    if problems:
        return 1
    print("core/ matches MANIFEST (%d files)" % len(want))
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--check", action="store_true", help="verify core/ against MANIFEST")
    g.add_argument("--write-manifest", action="store_true", help="re-hash core/ into MANIFEST")
    a = ap.parse_args(argv)
    return check() if a.check else write_manifest()


if __name__ == "__main__":
    sys.exit(main())
