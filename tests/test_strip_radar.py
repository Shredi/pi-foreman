"""Status strip, Python side: `foreman radar --json` passes state/strip.json on as `strip` (without `samples`; stale; absent when
disabled), and the config block `sidebar.strip` has defaults, is user or overlay only and rejects unknown keys."""
from __future__ import annotations

import contextlib
import datetime
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "scripts"))

from test_foreman_radar import NOW, Fixture  # noqa: E402
import foreman_config as fc  # noqa: E402
import foreman_radar as fr  # noqa: E402


def stamp(ts):
    return datetime.datetime.fromtimestamp(ts, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def strip_doc(at, **extra):
    d = {"version": 1, "at": stamp(at), "sampleSeconds": 10, "cpu": {"pct": 42, "history": [1, 2], "tone": "neutral"},
         "samples": {"claude:7d": [[1, 0.1]]}}
    d.update(extra)
    return d


class RadarStripTests(Fixture):
    def put_strip(self, doc):
        p = self.base / "state" / "strip.json"
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(doc) if not isinstance(doc, str) else doc, "utf-8")

    def configure(self, enabled=None):
        self.adir.mkdir(parents=True, exist_ok=True)
        cfg = {} if enabled is None else {"sidebar": {"strip": {"enabled": enabled}}}
        (self.adir / "foreman.json").write_text(json.dumps(cfg), "utf-8")

    def doc(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out), mock.patch.object(fr.time, "time", return_value=NOW):
            self.assertEqual(fr.main(["--agent-dir", str(self.adir), "--json"]), 0)
        return json.loads(out.getvalue())

    def test_strip_is_passed_on_without_samples(self):
        self.configure()
        self.put_strip(strip_doc(NOW - 5))
        got = self.doc()["strip"]
        self.assertEqual(got["cpu"]["pct"], 42)
        self.assertEqual(got["version"], 1)
        self.assertNotIn("samples", got)

    def test_disk_auto_flag_is_passed_on(self):
        self.configure()
        self.put_strip(strip_doc(NOW - 5, disks=[{"label": "/work", "usedPct": 5, "freeGB": 1, "tone": "neutral", "auto": True}]))
        self.assertIs(self.doc()["strip"]["disks"][0]["auto"], True)

    def test_old_file_is_stale(self):
        self.configure()
        self.put_strip(strip_doc(NOW - 31))
        self.assertEqual(self.doc()["strip"], {"stale": True})

    def test_file_within_three_intervals_is_fresh(self):
        self.configure()
        self.put_strip(strip_doc(NOW - 29))
        self.assertNotIn("stale", self.doc()["strip"])

    def test_missing_or_bad_file_is_stale(self):
        self.configure()
        self.assertEqual(self.doc()["strip"], {"stale": True})
        self.put_strip("{not json")
        self.assertEqual(self.doc()["strip"], {"stale": True})
        self.put_strip(strip_doc(NOW, version=2))
        self.assertEqual(self.doc()["strip"], {"stale": True})
        self.put_strip({**strip_doc(NOW), "at": "yesterday"})
        self.assertEqual(self.doc()["strip"], {"stale": True})

    def test_disabled_removes_strip(self):
        self.configure(False)
        self.put_strip(strip_doc(NOW))
        self.assertNotIn("strip", self.doc())

    def test_follow_carries_the_strip(self):
        self.put_strip(strip_doc(NOW))
        out = io.StringIO()
        with contextlib.redirect_stdout(out), mock.patch.object(fr.time, "time", return_value=NOW):
            fr.follow(self.adir, 0, 24, 3600, "unicode", fr.load_symbols("unicode"), max_ticks=1, strip=True)
        self.assertNotIn("samples", json.loads(out.getvalue().splitlines()[0])["strip"])

    def test_json_doc_without_strip_is_unchanged(self):
        self.assertNotIn("strip", fr.json_doc([], NOW, "unicode", fr.load_symbols("unicode")))


class StripConfigTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.agent = Path(self.tmp.name) / "agent"
        self.agent.mkdir()
        self.project = Path(self.tmp.name) / "proj"
        (self.project / ".pi").mkdir(parents=True)
        self._env = os.environ.get("PI_CODING_AGENT_DIR")
        os.environ["PI_CODING_AGENT_DIR"] = str(self.agent)
        self.addCleanup(lambda: os.environ.pop("PI_CODING_AGENT_DIR", None) if self._env is None else os.environ.update(PI_CODING_AGENT_DIR=self._env))

    def load(self, **kw):
        return fc.load_config(project_dir=str(self.project), **kw)

    def test_defaults(self):
        strip = self.load()["config"]["sidebar"]["strip"]
        self.assertEqual(strip, {"enabled": True, "cpu": True, "memory": True, "level": True, "disks": None, "sampleSeconds": 10,
                                 "sparkline": 12, "quotas": {"claude": True, "sources": {}, "hide": [], "order": []}})

    def test_user_layer_sets_values(self):
        (self.agent / "foreman.json").write_text(json.dumps({"sidebar": {"strip": {"disks": ["/", "C:"], "sampleSeconds": 20}}}))
        res = self.load()
        self.assertEqual(res["config"]["sidebar"]["strip"]["disks"], ["/", "C:"])
        self.assertEqual(res["errors"], [])

    def test_project_and_session_layers_are_ignored(self):
        (self.project / ".pi" / "foreman.json").write_text(json.dumps({"sidebar": {"strip": {"enabled": False, "sampleSeconds": 5,
            "quotas": {"sources": {"x": {"command": "/bin/evil"}}}}}}))
        res = self.load(trusted_project=True, session_json='{"sidebar": {"strip": {"cpu": false}}}')
        strip = res["config"]["sidebar"]["strip"]
        self.assertEqual((strip["enabled"], strip["sampleSeconds"], strip["cpu"], strip["quotas"]["sources"]), (True, 10, True, {}))
        self.assertIn("sidebar.strip", "\n".join(res["warnings"]))

    def test_schema_rejects_unknown_and_bad_keys(self):
        (self.agent / "foreman.json").write_text(json.dumps({"sidebar": {"strip": {"bogus": 1, "sampleSeconds": 1,
            "quotas": {"sources": {"x": {"command": "c", "seconds": 5}}, "other": 1}}}}))
        res = self.load()
        text = "\n".join(res["errors"] + res["warnings"])
        for needle in ("bogus", "sampleSeconds", "seconds", "other"):
            self.assertIn(needle, text)


if __name__ == "__main__":
    unittest.main()
