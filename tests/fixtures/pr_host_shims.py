"""gh/glab shims for tests: make_bin(tmp, kinds) writes them into a new directory under `tmp`."""
import os
import stat
import sys
from pathlib import Path

FAKE = str(Path(__file__).resolve().parent / "fake_pr_host.py").replace("\\", "/")
EXE = sys.executable.replace("\\", "/")


def make_bin(tmp, kinds, name="bin"):
    """Directory holding `<kind>` (sh) and `<kind>.cmd` shims that run the fake host with sys.executable."""
    d = os.path.join(tmp, name)
    os.makedirs(d, exist_ok=True)
    for kind in kinds:
        sh = os.path.join(d, kind)
        with open(sh, "w", encoding="utf-8", newline="\n") as f:
            f.write('#!/bin/sh\nexec "%s" "%s" %s "$@"\n' % (EXE, FAKE, kind))
        os.chmod(sh, os.stat(sh).st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
        with open(sh + ".cmd", "w", encoding="utf-8", newline="\r\n") as f:
            f.write('@echo off\n"%s" "%s" %s %%*\n' % (EXE, FAKE, kind))
    return d
