"""The high-stakes review (docs/review.md "High stakes"): the `high-stakes` gate of foreman_findings, the ceremony.highStakes keys."""
from __future__ import annotations

import contextlib
import copy
import io
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import _isolation  # noqa: E402,F401  (agent dir -> temp)
import foreman_config as fc  # noqa: E402
import foreman_findings as ff  # noqa: E402

# stdin of a `record` call: the item numbers and defect findings of the reviewer's verdict record
REPORT = json.dumps({"items": [1], "findings": [{"file": "app/client.py", "line": 38, "class": "secret-log", "note": "logs the bearer token"}]})
SCHEMA = json.loads((ROOT / "config" / "foreman.schema.json").read_text(encoding="utf-8"))
DEFAULTS = json.loads((ROOT / "config" / "foreman.defaults.json").read_text(encoding="utf-8"))


def run(fn, argv, stdin=""):
    out, err = io.StringIO(), io.StringIO()
    fake = mock.Mock(buffer=io.BytesIO(stdin.encode()))
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err), mock.patch.object(sys, "stdin", fake):
        rc = fn(argv)
    return rc, out.getvalue(), err.getvalue()


class FindingsGate(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="hs_findings_"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.agent = self.tmp / "agent"
        self.files = self.tmp / "files.txt"
        self.files.write_text("app/client.py\n")

    def record(self, gate, rid="r1"):
        return run(ff.main, ["record", "--session", "s1", "--gate", gate, "--model", "m1", "--rung", "0",
                             "--primary", "1", "--role", "reviewer", "--run-id", rid, "--source", "live",
                             "--head", "abc", "--files-from", str(self.files), "--agent-dir", str(self.agent)], REPORT)

    def test_high_stakes_gate_is_accepted_and_recorded(self):
        rc, out, _e = self.record("high-stakes")
        self.assertEqual(rc, 0)
        self.assertEqual(len(json.loads(out)["findings"]), 1)
        path = self.agent / "pi-foreman" / "state" / "findings" / "s1.jsonl"
        recs = [json.loads(ln) for ln in path.read_text(encoding="utf-8").splitlines()]
        self.assertEqual({r["gate"] for r in recs}, {"high-stakes"})
        self.assertEqual([r["type"] for r in recs], ["review", "finding"])

    def test_the_other_gates_stay_and_an_unknown_gate_is_refused(self):
        for gate in ("item", "plan-review", "pre-pr", "second-opinion"):
            self.assertEqual(self.record(gate, "r-" + gate)[0], 0)
        rc, _out, err = self.record("high_stakes")
        self.assertNotEqual(rc, 0)
        self.assertIn("invalid choice", err)


class ConfigKeys(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.agent = Path(self.tmp.name) / "agent"
        self.agent.mkdir()
        self.project = Path(self.tmp.name) / "proj"
        (self.project / ".pi").mkdir(parents=True)
        prev = os.environ.get("PI_CODING_AGENT_DIR")
        os.environ["PI_CODING_AGENT_DIR"] = str(self.agent)
        self.addCleanup(lambda: os.environ.pop("PI_CODING_AGENT_DIR", None) if prev is None else os.environ.__setitem__("PI_CODING_AGENT_DIR", prev))

    def load(self, hs):
        (self.agent / "foreman.json").write_text(json.dumps({"ceremony": {"highStakes": hs}}))
        return fc.load_config(project_dir=str(self.project))

    def test_schema_keys(self):
        props = SCHEMA["properties"]["ceremony"]["properties"]["highStakes"]
        self.assertIs(props["additionalProperties"], False)
        self.assertEqual(set(props["properties"]), {"model", "modules", "lines", "paths"})
        for key in ("modules", "lines", "paths"):
            self.assertIn("Retired", props["properties"][key]["description"])
        for key in ("modules", "lines"):
            self.assertEqual(set(props["properties"][key]), {"description"})
        self.assertEqual(props["properties"]["model"]["type"], ["string", "null"])

    def test_defaults(self):
        self.assertEqual(DEFAULTS["ceremony"]["highStakes"], {"model": None})

    def test_keys_load_and_paths_is_accepted_and_ignored(self):
        res = self.load({"model": "p/x", "modules": 0, "lines": 10, "paths": ["src/**"]})
        self.assertEqual(res["errors"], [])
        self.assertEqual([w for w in res["warnings"] if "highStakes" in w], [])
        self.assertEqual(res["config"]["ceremony"]["highStakes"]["model"], "p/x")

    def test_the_retired_size_keys_load_with_any_value(self):
        for retired in ({"lines": 2000}, {"modules": -1}, {"lines": "many"}, {"modules": 1.5, "lines": -1}):
            res = self.load(copy.deepcopy(retired))
            self.assertEqual(res["errors"], [], retired)
            self.assertEqual([w for w in res["warnings"] if "highStakes" in w], [], retired)

    def test_bad_values_are_errors(self):
        for bad in ({"model": 5}, {"bogus": 1}):
            res = self.load(copy.deepcopy(bad))
            self.assertTrue(res["errors"] or any("bogus" in w for w in res["warnings"]), bad)

    def test_the_retired_stake_keys_are_gone_from_the_defaults(self):
        self.assertNotIn("paths", DEFAULTS["ceremony"]["highStakes"])


if __name__ == "__main__":
    unittest.main()
