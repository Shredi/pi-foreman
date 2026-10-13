import json
import os
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import foreman_pressure as fp  # noqa: E402

LIMITS = {"maxLoadPerCore": 1.5, "minFreeMemMB": 1024, "minFreeDiskGB": 5, "sampleSeconds": 30}
OK_HOST = {"loadPerCore": 0.5, "freeMemMB": 8000, "freeDiskGB": 100.0}
NOW = datetime(2026, 1, 1, 12, 0, 0, tzinfo=timezone.utc)


def host(**kw):
    return dict(OK_HOST, **kw)


class ClassifyTest(unittest.TestCase):
    def test_ok(self):
        rec = fp.classify(OK_HOST, LIMITS, NOW)
        self.assertEqual((rec["level"], rec["reasons"]), ("ok", []))
        self.assertEqual(rec["at"], "2026-01-01T12:00:00Z")
        self.assertEqual(rec["host"], OK_HOST)

    def test_high_each_limit(self):
        for key, val, token in (("loadPerCore", 2.0, "load"), ("freeMemMB", 800, "mem"), ("freeDiskGB", 4.0, "disk")):
            rec = fp.classify(host(**{key: val}), LIMITS, NOW)
            self.assertEqual((rec["level"], rec["reasons"]), ("high", [token]), key)

    def test_critical_each_limit(self):
        for key, val, token in (("loadPerCore", 3.0, "load"), ("freeMemMB", 511, "mem"), ("freeDiskGB", 2.4, "disk")):
            rec = fp.classify(host(**{key: val}), LIMITS, NOW)
            self.assertEqual((rec["level"], rec["reasons"]), ("critical", [token]), key)

    def test_boundaries(self):
        self.assertEqual(fp.classify(host(loadPerCore=1.5), LIMITS, NOW)["level"], "ok")
        self.assertEqual(fp.classify(host(freeMemMB=1024), LIMITS, NOW)["level"], "ok")
        self.assertEqual(fp.classify(host(freeMemMB=512), LIMITS, NOW)["level"], "high")

    def test_mixed_takes_worst(self):
        rec = fp.classify(host(loadPerCore=2.0, freeDiskGB=1.0), LIMITS, NOW)
        self.assertEqual((rec["level"], rec["reasons"]), ("critical", ["load", "disk"]))

    def test_none_fields_add_no_reason(self):
        rec = fp.classify({"loadPerCore": None, "freeMemMB": None, "freeDiskGB": None}, LIMITS, NOW)
        self.assertEqual((rec["level"], rec["reasons"]), ("ok", []))


class StateTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = os.path.join(self.tmp.name, "a", "b", "pressure.json")

    def test_atomic_write_leaves_no_tmp(self):
        rec = fp.classify(host(loadPerCore=2.0), LIMITS, NOW)
        fp.write_state(self.path, rec)
        fp.write_state(self.path, rec)
        self.assertEqual(os.listdir(os.path.dirname(self.path)), ["pressure.json"])
        self.assertEqual(json.load(open(self.path)), rec)

    def test_failed_write_leaves_no_tmp(self):
        os.makedirs(os.path.dirname(self.path))
        with mock.patch("os.replace", side_effect=OSError("boom")):
            with self.assertRaises(OSError):
                fp.write_state(self.path, {"level": "ok"})
        self.assertEqual(os.listdir(os.path.dirname(self.path)), [])

    def test_read_fresh(self):
        rec = fp.classify(host(freeMemMB=800), LIMITS, NOW)
        fp.write_state(self.path, rec)
        got = fp.read_state(self.path, 30, NOW + timedelta(seconds=89))
        self.assertEqual(got, rec)

    def test_read_stale_is_ok(self):
        fp.write_state(self.path, fp.classify(host(freeMemMB=800), LIMITS, NOW))
        got = fp.read_state(self.path, 30, NOW + timedelta(seconds=91))
        self.assertEqual((got["level"], got["reasons"]), ("ok", ["stale"]))

    def test_read_missing_and_garbage(self):
        got = fp.read_state(self.path, 30, NOW)
        self.assertEqual((got["level"], got["reasons"]), ("ok", ["missing"]))
        os.makedirs(os.path.dirname(self.path))
        for text in ("not json", "[]", '{"level": "bogus", "at": "2026-01-01T12:00:00Z"}', '{"level": "high"}'):
            Path(self.path).write_text(text)
            got = fp.read_state(self.path, 30, NOW)
            self.assertEqual((got["level"], got["reasons"]), ("ok", ["missing"]), text)


class SampleTest(unittest.TestCase):
    def test_real_sample_never_raises_and_has_keys(self):
        got = fp.sample(tempfile.gettempdir())
        self.assertEqual(set(got), {"loadPerCore", "freeMemMB", "freeDiskGB"})

    def test_each_probe_none(self):
        with mock.patch.object(fp.os, "getloadavg", side_effect=OSError, create=True), \
                mock.patch.object(fp, "_mem_linux", side_effect=RuntimeError), \
                mock.patch.object(fp, "_mem_macos", side_effect=RuntimeError), \
                mock.patch.object(fp, "_mem_windows", side_effect=RuntimeError), \
                mock.patch.object(fp.shutil, "disk_usage", side_effect=OSError):
            self.assertEqual(fp.sample("/nonexistent"),
                             {"loadPerCore": None, "freeMemMB": None, "freeDiskGB": None})

    def test_load_attribute_error_and_zero_cpus(self):
        with mock.patch.object(fp.os, "getloadavg", side_effect=AttributeError, create=True):
            self.assertIsNone(fp._load_per_core())
        with mock.patch.object(fp.os, "cpu_count", return_value=None):
            self.assertIsNone(fp._load_per_core())

    def test_windows_shape(self):
        with mock.patch.object(fp.sys, "platform", "win32"), \
                mock.patch.object(fp, "_mem_windows", return_value=4096), \
                mock.patch.object(fp.shutil, "disk_usage", return_value=mock.Mock(free=20 * 1024 ** 3)):
            if hasattr(fp.os, "getloadavg"):
                mock.patch.object(fp.os, "getloadavg", side_effect=AttributeError).start()
                self.addCleanup(mock.patch.stopall)
            got = fp.sample("C:\\work")
        self.assertIsNone(got["loadPerCore"])
        self.assertEqual(got["freeMemMB"], 4096)
        self.assertEqual(got["freeDiskGB"], 20.0)

    def test_macos_vm_stat_parse(self):
        out = ("Mach Virtual Memory Statistics: (page size of 16384 bytes)\n"
               "Pages free:                               1000.\n"
               "Pages active:                             5000.\n"
               "Pages inactive:                           2000.\n"
               "Pages speculative:                        500.\n")
        with mock.patch.object(fp.subprocess, "run", return_value=mock.Mock(stdout=out)):
            self.assertEqual(fp._mem_macos(), 3500 * 16384 // (1024 * 1024))

    def test_linux_meminfo_parse(self):
        data = "MemTotal: 16000000 kB\nMemFree: 100 kB\nMemAvailable: 2097152 kB\n"
        with mock.patch("builtins.open", mock.mock_open(read_data=data)):
            self.assertEqual(fp._mem_linux(), 2048)


class CliTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.state = os.path.join(self.tmp.name, "state", "pressure.json")

    def run_cli(self, *args):
        return subprocess.run([sys.executable, "-E", "-s", str(ROOT / "scripts" / "foreman_pressure.py")] + list(args),
                              stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              universal_newlines=True, timeout=60)

    def test_sample_with_fixture_then_read(self):
        fixture = os.path.join(self.tmp.name, "host.json")
        Path(fixture).write_text(json.dumps(host(freeDiskGB=1.0)))
        p = self.run_cli("sample", "--workspace", self.tmp.name, "--state", self.state,
                         "--limits", json.dumps(LIMITS), "--fixture", fixture)
        self.assertEqual(p.returncode, 0, p.stderr)
        rec = json.loads(p.stdout)
        self.assertEqual((rec["level"], rec["reasons"]), ("critical", ["disk"]))
        self.assertEqual(json.load(open(self.state)), rec)
        p = self.run_cli("read", "--state", self.state, "--sample-seconds", "30")
        self.assertEqual(json.loads(p.stdout), rec)

    def test_sample_probes_real_host(self):
        p = self.run_cli("sample", "--workspace", self.tmp.name, "--state", self.state,
                         "--limits", json.dumps(LIMITS))
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIn(json.loads(p.stdout)["level"], ("ok", "high", "critical"))

    def test_read_missing(self):
        p = self.run_cli("read", "--state", self.state, "--sample-seconds", "30")
        self.assertEqual(json.loads(p.stdout)["reasons"], ["missing"])

    def test_bad_limits(self):
        p = self.run_cli("sample", "--state", self.state, "--limits", "nope")
        self.assertEqual(p.returncode, 2)


if __name__ == "__main__":
    unittest.main()
