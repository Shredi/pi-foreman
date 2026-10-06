#!/usr/bin/env python3
"""Vendor the upstream Python core into core/ at a pinned commit.

    python scripts/pull_core.py --sha <full 40-hex sha> [--release 0.22.0]
    python scripts/pull_core.py --check        (offline: verify core/ vs MANIFEST)
    python scripts/pull_core.py --conformance  (run upstream tests against core/)

core/ is written ONLY by this script, never edited by hand. Bytes are stored
as extracted (nothing normalised); the repo-root .gitattributes marks core/**
as -text so hashes match on every OS.

Upstream allowlist: only what pi-foreman runs (scripts/, bin/,
instructions/, LICENSE). The upstream tests are NOT vendored: --conformance
fetches the full tarball at the pinned sha into a temp dir, proves every
vendored file is byte-identical to it, overlays core/ onto it and runs the
upstream pytest suite there. Its output is reduced to the summary line, so
no test id or fixture text reaches this repo or a CI log.

--check ignores __pycache__/ and .pytest_cache/ (created by running the
conformance suite inside core/) and *.pyc files.
"""
from __future__ import annotations

import argparse
import datetime
import hashlib
import io
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
from pathlib import Path, PurePosixPath

REPO = "Shredi/fable5-opus5-orchestrator"
DEFAULT_RELEASE = "0.22.0"
ROOT = Path(__file__).resolve().parent.parent
CORE = ROOT / "core"

# Directory prefixes and exact files taken from upstream (POSIX, repo-relative).
ALLOW_DIRS = (
    "scripts/",
    "bin/",
    "instructions/",
)
ALLOW_FILES = ("LICENSE",)
GENERATED = ("VERSION", "MANIFEST")
IGNORED_PARTS = ("__pycache__", ".pytest_cache")


def allowed(rel: str) -> bool:
    return rel in ALLOW_FILES or rel.startswith(ALLOW_DIRS)


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def manifest_lines(base: Path):
    """Sorted '<sha256>  <posix path>' lines for every vendored file."""
    out = []
    for p in base.rglob("*"):
        rel = p.relative_to(base)
        if not p.is_file() or rel.as_posix() in GENERATED:
            continue
        if any(part in IGNORED_PARTS for part in rel.parts) or p.suffix == ".pyc":
            continue
        out.append("%s  %s" % (sha256(p.read_bytes()), rel.as_posix()))
    return sorted(out, key=lambda line: line.split("  ", 1)[1])


def safe_rel(name: str) -> str:
    """Return the member path without its top-level dir; refuse unsafe paths."""
    if name.startswith(("/", "\\")) or re.match(r"^[A-Za-z]:", name):
        raise SystemExit("refusing absolute tar member: %r" % name)
    parts = PurePosixPath(name).parts
    if ".." in parts or "\\" in name:
        raise SystemExit("refusing unsafe tar member: %r" % name)
    return "/".join(parts[1:])


def extract(sha: str, dest: Path, keep) -> int:
    """Download the tarball at `sha` and write members with keep(rel) to dest."""
    if not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise SystemExit("--sha must be a full 40-hex commit sha")
    url = "https://codeload.github.com/%s/tar.gz/%s" % (REPO, sha)
    with urllib.request.urlopen(url, timeout=60) as resp:
        blob = resp.read()
    n = 0
    with tarfile.open(fileobj=io.BytesIO(blob), mode="r:gz") as tf:
        for m in tf.getmembers():
            if m.name == "pax_global_header":
                continue
            rel = safe_rel(m.name)  # validates every member, kept or not
            if not rel or not keep(rel):
                continue
            if not m.isfile():
                if m.isdir() or m.issym():
                    continue
                raise SystemExit("refusing non-regular tar member: %r" % m.name)
            out = dest / rel
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_bytes(tf.extractfile(m).read())
            if m.mode & 0o111:
                out.chmod(0o755)
            n += 1
    return n


def pull(sha: str, release: str) -> int:
    work = Path(tempfile.mkdtemp(prefix="pull-core-"))
    stage = work / "new"
    stage.mkdir()
    n = extract(sha, stage, allowed)
    missing = [f for f in ALLOW_FILES if not (stage / f).is_file()]
    if missing or not (stage / "scripts").is_dir():
        raise SystemExit("upstream is missing allowlisted paths: %s" % missing)
    lines = manifest_lines(stage)
    fetched = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d")
    (stage / "VERSION").write_bytes(
        ("repo: %s\nsha: %s\nrelease: %s\nfetched: %s\n" % (REPO, sha, release, fetched)).encode()
    )
    (stage / "MANIFEST").write_bytes(("\n".join(lines) + "\n").encode())
    # Swap: move the old tree aside into the temp dir (kept, not deleted).
    if CORE.exists():
        shutil.move(str(CORE), str(work / "old"))
    shutil.move(str(stage), str(CORE))
    print("vendored %d files into core/ (previous tree, if any: %s)" % (n, work / "old"))
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


def pinned_sha() -> str:
    for line in (CORE / "VERSION").read_text(encoding="utf-8").splitlines():
        if line.startswith("sha: "):
            return line[5:].strip()
    raise SystemExit("core/VERSION has no sha line")


def failed_names(lines) -> list:
    """Node ids from pytest `-rf` lines ("FAILED <id> - message"); names only."""
    return [l[len("FAILED "):].split(" - ", 1)[0].strip() for l in lines if l.startswith("FAILED ")]


def conformance() -> int:
    if check() != 0:
        return 1
    sha = pinned_sha()
    work = Path(tempfile.mkdtemp(prefix="core-conformance-"))
    extract(sha, work, lambda rel: True)
    for line in (CORE / "MANIFEST").read_text(encoding="utf-8").splitlines():
        digest, _, rel = line.partition("  ")
        up = work / rel
        if not up.is_file() or sha256(up.read_bytes()) != digest:
            print("vendored file differs from upstream %s: %s" % (sha[:7], rel))
            return 1
        shutil.copyfile(str(CORE / rel), str(up))  # run against the vendored bytes
    proc = subprocess.run(
        [sys.executable, "-m", "pytest", "tests", "-q", "-rf", "--tb=no",
         "-p", "no:cacheprovider"],
        cwd=str(work), stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    )
    lines = [l for l in proc.stdout.decode("utf-8", "replace").splitlines() if l.strip()]
    for name in failed_names(lines):
        print("FAILED " + name)
    print("core conformance @ %s: %s" % (sha[:7], lines[-1] if lines else "no output"))
    if proc.returncode != 0:
        print("failed; run it locally for details (output is reduced on purpose)")
    return proc.returncode


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--sha", help="full upstream commit sha to vendor")
    ap.add_argument("--release", default=DEFAULT_RELEASE, help="release label for VERSION")
    ap.add_argument("--check", action="store_true", help="verify core/ against MANIFEST (offline)")
    ap.add_argument("--conformance", action="store_true",
                    help="run the upstream tests at the pinned sha against core/")
    a = ap.parse_args(argv)
    if a.check:
        return check()
    if a.conformance:
        return conformance()
    if not a.sha:
        ap.error("--sha or --check required")
    return pull(a.sha, a.release)


if __name__ == "__main__":
    sys.exit(main())
