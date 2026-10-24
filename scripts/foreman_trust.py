#!/usr/bin/env python3
"""Pi's project-trust store for round worktrees (stdlib, 3.13+).

Pi asks "Trust project folder?" when it starts in a folder with project resources (`.pi/*`, `.agents/skills`)
and no decision is stored. The store is `<agent dir>/trust.json`: absolute path -> true / false / null, looked up
from the cwd upwards (nearest entry wins). `grant` writes `{<exact path>: true}` for a session's fresh worktree,
keeping every other entry; it never writes a parent folder. `release` removes that exact entry again, only when
pi-foreman added it (the session registry entry records `trusted: <path>`), so a user's own entry stays.

Both are best effort: a missing, unreadable or malformed store is left alone and reported as not changed.
"""
from __future__ import annotations

import json
import os
import tempfile
import time
from pathlib import Path

LOCK_TRIES = 10
LOCK_DELAY = 0.02
LOCK_STALE = 10.0


def trust_path(adir):
    return Path(adir) / "trust.json"


def _read(path):
    """The store as a dict ({} when absent); None when unreadable or invalid (never overwritten then)."""
    try:
        raw = Path(path).read_text("utf-8-sig")
    except FileNotFoundError:
        return {}
    except (OSError, UnicodeDecodeError):
        return None
    try:
        data = json.loads(raw)
    except ValueError:
        return None
    if not isinstance(data, dict) or any(v not in (True, False, None) for v in data.values()):
        return None
    return data


def _write(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".trust-", suffix=".json", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump({k: data[k] for k in sorted(data)}, f, indent=2)
            f.write("\n")
        os.replace(tmp, str(path))
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _locked(path, fn):
    """Run fn under the same directory lock Pi takes (`trust.json.lock`); None when the lock is not obtained."""
    lock = str(path) + ".lock"
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    for _ in range(LOCK_TRIES):
        try:
            os.mkdir(lock)
            break
        except FileExistsError:
            try:
                if time.time() - os.stat(lock).st_mtime > LOCK_STALE:
                    os.rmdir(lock)
                    continue
            except OSError:
                pass
            time.sleep(LOCK_DELAY)
        except OSError:
            return None
    else:
        return None
    try:
        return fn()
    finally:
        try:
            os.rmdir(lock)
        except OSError:
            pass


def decision(adir, cwd):
    """The stored decision for `cwd`: the nearest entry of the store from its realpath upwards (Pi's lookup).
    True, False, or None when there is no entry, a null entry or an unreadable store."""
    data = _read(trust_path(adir))
    if not data:
        return None
    keys = {os.path.normcase(k): v for k, v in data.items()}
    path = os.path.realpath(str(cwd))
    while True:
        if os.path.normcase(path) in keys:
            return keys[os.path.normcase(path)]
        parent = os.path.dirname(path)
        if parent == path:
            return None
        path = parent


def grant(adir, cwd):
    """Trust exactly `cwd` (its realpath). True when this call added the entry, False when it changed nothing."""
    path = trust_path(adir)
    key = os.path.realpath(str(cwd))

    def run():
        data = _read(path)
        if data is None or data.get(key) is not None:
            return False  # unreadable store, or an exact decision (the user's) already exists
        data[key] = True
        _write(path, data)
        return True

    try:
        return bool(_locked(path, run))
    except OSError:
        return False


def revoke(adir, cwd):
    """Remove the exact entry for `cwd` when it is `true`. True when it was removed."""
    path = trust_path(adir)
    key = os.path.realpath(str(cwd))

    def run():
        data = _read(path)
        if data is None or data.get(key) is not True:
            return False
        del data[key]
        _write(path, data)
        return True

    try:
        return bool(_locked(path, run))
    except OSError:
        return False


def release(path, adir=None):
    """Called when a worktree is removed: revoke the entry pi-foreman recorded for it in the session registry
    and clear the record. Never raises; a path no session recorded is left alone."""
    try:
        import foreman_session as fsn
        adir = adir or fsn.agent_dir()
        key = os.path.realpath(str(path))
        reg = fsn.read_registry(adir)
        hit = [s for s in reg["sessions"] if isinstance(s, dict) and s.get("trusted") == key]
        if not hit:
            return False
        done = revoke(adir, key)
        for s in hit:
            s.pop("trusted", None)
        fsn.write_registry(adir, reg)
        return done
    except Exception:  # noqa: BLE001 - housekeeping never blocks a worktree removal
        return False
