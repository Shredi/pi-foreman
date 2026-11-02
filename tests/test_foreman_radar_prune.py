"""The radar may delete only presence files of sessions that are provably closed, and presence tests never touch
the real agent dir."""
import json
import re
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "scripts"))

import foreman_radar as fr  # noqa: E402

NOW = 1_800_000_000.0


def iso(ago):
    import datetime
    return datetime.datetime.fromtimestamp(NOW - ago, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def presence(sid, pid, pane=None, state="done"):
    d = {"v": 1, "sessionId": sid, "intercomId": "fm-" + sid, "label": sid, "cwd": "/w", "pid": pid, "mode": "tui",
         "startedAt": iso(7200), "heartbeatAt": iso(3600), "lastEventAt": iso(3600), "state": state, "runs": []}
    if pane:
        d["paneId"] = pane
    return d


class PruneOnlyProvablyClosed(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.adir = Path(self.tmp) / "agent"

    def put(self, d):
        p = self.adir / "pi-foreman" / "state" / "live" / (d["sessionId"] + ".json")
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(d), "utf-8")
        return p

    def snap(self, dead, panes):
        with mock.patch.object(fr, "pid_dead", side_effect=lambda pid: pid in dead), \
                mock.patch.object(fr, "herdr_panes", return_value=panes):
            return fr.snapshot(self.adir, NOW, 24.0, None, 30.0, closed=fr.provably_closed)

    def test_prune_only_provably_closed(self):
        closed = self.put(presence("closed", 101, "w1:p1"))
        pane_open = self.put(presence("pane-open", 102, "w1:p2"))
        pid_alive = self.put(presence("pid-alive", 103, "w1:p3"))
        no_pid = self.put(presence("no-pid", None, "w1:p4"))
        working = self.put(presence("working", 101, "w1:p5", state="working"))
        self.snap({101, 102}, {"w1:p2", "w1:p3"})
        self.assertFalse(closed.exists())
        for kept in (pane_open, pid_alive, no_pid, working):
            self.assertTrue(kept.exists(), kept.name)

    def test_herdr_unreachable_keeps_every_file(self):
        p = self.put(presence("a", 101, "w1:p1"))
        self.snap({101}, None)
        self.assertTrue(p.exists())

    def test_without_a_pane_id_pid_dead_and_herdr_answering_is_enough(self):
        p = self.put(presence("a", 101))
        self.snap({101}, set())
        self.assertFalse(p.exists())

    def test_cli_entry_points_pass_the_guard(self):
        p = self.put(presence("a", 101, "w1:p1"))
        with mock.patch.object(fr, "pid_dead", return_value=False), \
                mock.patch.object(fr, "herdr_panes", return_value=set()), \
                mock.patch.object(fr.time, "time", return_value=NOW), \
                mock.patch("sys.stdout"):
            fr.main(["--once", "--agent-dir", str(self.adir), "--done-ttl", "1"])
        self.assertTrue(p.exists())


class PresenceTestsUseTempDirs(unittest.TestCase):
    """Guard: a presence/stale-prune test must not resolve the real agent dir."""

    PY = ["test_foreman_radar.py", "test_foreman_radar_tree.py", "test_herdr_sidebar.py",
          "test_herdr_cross_workspace.py", "test_foreman_radar_prune.py"]
    TS = ["livestate", "sidebarlive", "footer", "wait", "bg", "runs"]

    def test_python_presence_tests_never_resolve_the_real_agent_dir(self):
        bad = re.compile(r"Path\.home\(\)|expanduser|os\.environ\[.PI_CODING_AGENT_DIR|\"\.pi\"|'\.pi'")
        for name in self.PY:
            text = (HERE / name).read_text("utf-8")
            code = "\n".join(l for l in text.splitlines() if "PresenceTestsUseTempDirs" not in l and not l.lstrip().startswith("bad = "))
            if name == "test_foreman_radar_prune.py":
                continue
            self.assertIsNone(bad.search(code), name)
            for line in code.splitlines():
                if re.search(r"\bfr\.main\(\[", line):
                    self.assertIn("--agent-dir", line, "%s: %s" % (name, line.strip()))

    def test_ts_presence_tests_never_resolve_the_real_agent_dir(self):
        tdir = HERE.parent / "extensions" / "core-adapter" / "test"
        bad = re.compile(r"homedir\(\)|\"\.pi\", \"agent\"|process\.env\.HOME\b")
        for name in self.TS:
            f = tdir / (name + ".test.ts")
            if f.exists():
                self.assertIsNone(bad.search(f.read_text("utf-8")), f.name)

    def test_every_cli_mode_passes_a_closed_predicate(self):
        # replaces a source-text count of "provably_closed": check the behaviour of each mode instead
        seen = {}
        adir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, adir, True)

        def snap(*a, **kw):
            seen.setdefault("snapshot", []).append(kw.get("closed"))
            return {}

        def follow(*a, **kw):
            seen["follow"] = kw.get("closed", a[8] if len(a) > 8 else None)

        def loop(*a, **kw):
            seen["loop"] = kw.get("closed", a[6] if len(a) > 6 else None)

        tty = mock.MagicMock()
        tty.isatty.return_value = True
        for argv, tty_out in ((["--json"], False), (["--once"], False), ([], False), (["--follow"], False), ([], True)):
            seen.clear()
            with mock.patch.object(fr, "snapshot", snap), mock.patch.object(fr, "follow", follow), \
                    mock.patch.object(fr, "loop", loop), mock.patch.object(fr, "json_line", return_value=""), \
                    mock.patch.object(fr, "render", return_value=[]), mock.patch.object(fr, "render_footer", return_value=""), \
                    mock.patch("sys.stdout", tty if tty_out else mock.MagicMock(**{"isatty.return_value": False})):
                fr.main(argv + ["--agent-dir", adir])
            got = seen.get("snapshot", []) + [seen[k] for k in ("follow", "loop") if k in seen]
            self.assertTrue(got, argv)
            for closed in got:
                self.assertIsNotNone(closed, "%s tty=%s" % (argv, tty_out))


if __name__ == "__main__":
    unittest.main()
