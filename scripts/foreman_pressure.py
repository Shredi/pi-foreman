#!/usr/bin/env python3
"""Host pressure sampler: load per core, free memory, free workspace disk. Stdlib only, Python 3.13+.

sample() never raises: a probe that fails yields None. classify() turns a sample and the
resources limits into {level, reasons, at, host}; write_state()/read_state() keep it in
<agentDir>/pi-foreman/state/pressure.json.
"""
import argparse
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta, timezone


def _load_per_core(window=1):
    """Load average per core; `window` indexes os.getloadavg(): 0 = 1 minute, 1 = 5 minutes (the gate)."""
    try:
        cores = os.cpu_count() or 0
        if cores < 1:
            return None
        return os.getloadavg()[window] / cores
    except (AttributeError, OSError):
        return None


def _mem_linux():
    with open("/proc/meminfo", "r", encoding="ascii", errors="replace") as fh:
        for line in fh:
            if line.startswith("MemAvailable:"):
                return int(line.split()[1]) // 1024  # kB -> MB
    return None


def _mem_macos():
    out = subprocess.run(["vm_stat"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                         stdin=subprocess.DEVNULL, timeout=5, universal_newlines=True).stdout
    size = re.search(r"page size of (\d+) bytes", out)
    page = int(size.group(1)) if size else 4096
    pages = 0
    for name in ("Pages free", "Pages inactive", "Pages speculative"):
        m = re.search(r"^%s:\s+(\d+)" % name, out, re.M)
        if m:
            pages += int(m.group(1))
    return pages * page // (1024 * 1024)


def _mem_windows():
    import ctypes

    class Status(ctypes.Structure):
        _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                    ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                    ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                    ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                    ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]

    st = Status()
    st.dwLength = ctypes.sizeof(Status)
    if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(st)):
        return None
    return int(st.ullAvailPhys // (1024 * 1024))


def _free_mem_mb():
    try:
        if sys.platform.startswith("linux"):
            return _mem_linux()
        if sys.platform == "darwin":
            return _mem_macos()
        if sys.platform == "win32":
            return _mem_windows()
    except Exception:
        pass
    return None


def _free_disk_gb(workspace):
    try:
        return shutil.disk_usage(workspace).free / float(1024 ** 3)
    except Exception:
        return None


def sample(workspace):
    """Probe the host. Each field is None when its probe is unavailable; never raises."""
    return {"loadPerCore": _load_per_core(1), "load1PerCore": _load_per_core(0), "freeMemMB": _free_mem_mb(),
            "freeDiskGB": _free_disk_gb(workspace)}


def _iso(now):
    return now.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def classify(host, limits, now=None):
    """{level, reasons, at, host} from a sample and the resources limits."""
    now = now or datetime.now(timezone.utc)
    reasons, level = [], "ok"

    def hit(token, crossed, severe):
        nonlocal level
        if not crossed:
            return
        reasons.append(token)
        if severe:
            level = "critical"
        elif level == "ok":
            level = "high"

    load, mem, disk = host.get("loadPerCore"), host.get("freeMemMB"), host.get("freeDiskGB")
    max_load, min_mem, min_disk = (limits.get(k) for k in ("maxLoadPerCore", "minFreeMemMB", "minFreeDiskGB"))
    if load is not None and max_load is not None:
        hit("load", load > max_load, load >= 2 * max_load)
    if mem is not None and min_mem is not None:
        hit("mem", mem < min_mem, mem < min_mem / 2.0)
    if disk is not None and min_disk is not None:
        hit("disk", disk < min_disk, disk < min_disk / 2.0)
    return {"level": level, "reasons": reasons, "at": _iso(now), "host": host}


def write_state(path, rec):
    """Atomic write: temp file in the same directory, then os.replace."""
    d = os.path.dirname(os.path.abspath(path))
    os.makedirs(d, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=os.path.basename(path) + ".", suffix=".tmp", dir=d)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(rec, fh)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def read_state(path, sample_seconds, now=None):
    """The stored record; ok/missing when unreadable, ok/stale when older than 3x sample_seconds."""
    now = now or datetime.now(timezone.utc)
    try:
        with open(path, "r", encoding="utf-8") as fh:
            rec = json.load(fh)
        at = datetime.strptime(rec["at"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
        if rec["level"] not in ("ok", "high", "critical"):
            raise ValueError("level")
    except Exception:
        return {"level": "ok", "reasons": ["missing"], "at": _iso(now), "host": {}}
    if now - at > timedelta(seconds=3 * sample_seconds):
        return dict(rec, level="ok", reasons=["stale"])
    return rec


def main(argv=None):
    p = argparse.ArgumentParser(prog="foreman_pressure")
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("sample")
    s.add_argument("--workspace", default=".")
    s.add_argument("--state", required=True)
    s.add_argument("--limits", required=True)
    s.add_argument("--fixture")
    r = sub.add_parser("read")
    r.add_argument("--state", required=True)
    r.add_argument("--sample-seconds", type=int, default=30)
    args = p.parse_args(argv)
    if args.cmd == "sample":
        try:
            limits = json.loads(args.limits)
            if not isinstance(limits, dict):
                raise ValueError("limits")
            if args.fixture:
                with open(args.fixture, "r", encoding="utf-8") as fh:
                    host = json.load(fh)
            else:
                host = sample(args.workspace)
        except (ValueError, OSError) as exc:
            print("foreman_pressure: %s" % exc, file=sys.stderr)
            return 2
        rec = classify(host, limits)
        if hasattr(signal, "SIGTERM"):
            # A stop kills the sampler: unwind through write_state so its temp file is unlinked.
            signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))
        write_state(args.state, rec)
    else:
        rec = read_state(args.state, args.sample_seconds)
    print(json.dumps(rec))
    return 0


if __name__ == "__main__":
    sys.exit(main())
