"""scripts/foreman_findings.py: the path and symbol helpers of the bench scorer, and `record`, which takes the findings of a
reviewer's verdict record as JSON (never report text)."""
import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import _isolation  # noqa: E402,F401  (agent dir -> temp)
import foreman_findings as ff  # noqa: E402
import foreman_review_bench as rb  # noqa: E402

FILES = ["app/client.py", "tests/test_client.py"]


def record(argv, stdin):
    out, err = io.StringIO(), io.StringIO()
    fake = mock.Mock(buffer=io.BytesIO(stdin.encode()))
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err), mock.patch.object(sys, "stdin", fake):
        rc = ff.main(argv)
    return rc, out.getvalue(), err.getvalue()


class Helpers(unittest.TestCase):
    def test_text_readers_are_gone(self):
        for n in ("verdict_of", "items_of", "fail_units", "fail_evidence", "located_findings", "VERDICT_RE", "ITEM_RE"):
            self.assertFalse(hasattr(ff, n), n)
            self.assertFalse(hasattr(rb, n) and n != "located_findings", n)
        self.assertEqual(rb.SCORER_VERSION, 4)

    def test_names_file_and_symbols(self):
        self.assertTrue(ff.names_file("see client.py:3", "app/client.py", FILES))
        self.assertFalse(ff.names_file("see client.py:3", "app/client.py", FILES + ["lib/client.py"]))
        self.assertEqual(ff.patch_files("--- a/x.py\n+++ b/x.py\n--- /dev/null\n+++ b/y.py\n"), ["x.py", "y.py"])
        self.assertEqual(ff.symbols_of({"description": "ReportStore.read joins paths"}), ["ReportStore"])

    def test_finding_id_triple(self):
        self.assertEqual(ff.finding_id("a.py", 38, "race"), ff.finding_id("a.py", 36, "race"))
        self.assertNotEqual(ff.finding_id("a.py", 38, "race"), ff.finding_id("a.py", 38, None))
        self.assertEqual(len(ff.finding_id("a.py", None, None)), 12)


class RecordInput(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.agent = Path(self.tmp.name) / "agent"
        self.files = Path(self.tmp.name) / "files.txt"
        self.files.write_text("\n".join(FILES), "utf-8")

    def call(self, stdin, *extra):
        return record(["record", "--session", "s1", "--gate", "item", "--model", "m", "--rung", "0", "--primary", "1",
                       "--role", "reviewer", "--run-id", "r1", "--source", "live", "--head", "abc", "--verdict", "FAIL",
                       "--agent-dir", str(self.agent), *extra], stdin)

    def stored(self):
        p = self.agent / "pi-foreman" / "state" / "findings" / "s1.jsonl"
        return [json.loads(ln) for ln in p.read_text("utf-8").splitlines()]

    def test_findings_and_items_come_from_the_json(self):
        data = {"items": [3, 1, 1, "V", True, 0],
                "findings": [{"file": "app/client.py", "line": 38, "class": "secret-log", "note": "logs it"},
                             {"file": "app/client.py", "line": 39, "class": "secret-log", "note": "same band"},
                             {"file": "app/client.py", "line": 7, "class": "no-such-class", "note": "x" * 300},
                             {"file": "app/other.py", "line": 2, "class": "race", "note": "not in the diff"},
                             {"file": "/etc/passwd", "line": 1}, {"file": "../x.py"}, {"line": 4}, "text", {"file": 3}]}
        rc, out, _err = self.call(json.dumps(data), "--files-from", str(self.files))
        self.assertEqual(rc, 0)
        res = json.loads(out)
        self.assertEqual(res["verdict"], "FAIL")
        self.assertEqual(res["items"], [1, 3])
        self.assertEqual([(f["file"], f["line"], f["class"]) for f in res["findings"]],
                         [("app/client.py", 38, "secret-log"), ("app/client.py", 7, None)])
        self.assertEqual(len(res["findings"][1]["note"]), ff.MAX_NOTE)
        review, *findings = self.stored()
        self.assertEqual((review["items"], review["findings"], review["verdict"]), ([1, 3], 2, "FAIL"))
        self.assertEqual([f["id"] for f in findings], [f["id"] for f in res["findings"]])

    def test_without_a_file_list_every_repo_relative_file_counts(self):
        rc, out, _err = self.call(json.dumps({"findings": [{"file": "app/other.py", "line": 2}]}))
        self.assertEqual((rc, len(json.loads(out)["findings"])), (0, 1))

    def test_report_text_or_bad_json_records_the_review_without_findings(self):
        for stdin in ("VERDICT: FAIL\n2. FAIL app/client.py:38 logs the bearer token\n", "[1, 2]"):
            rc, out, err = self.call(stdin, "--files-from", str(self.files))
            self.assertEqual(rc, 0)
            self.assertEqual(json.loads(out)["findings"], [])
            self.assertIn("record", err)
        self.assertEqual([r["type"] for r in self.stored()], ["review", "review"])

    def test_extract_is_gone(self):
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(ff.main(["extract", "--files-from", str(self.files)]), 2)


class Rescoring(unittest.TestCase):
    def test_score_from_the_record_of_each_fixture_cell(self):
        cells = json.loads((ROOT / "tests" / "fixtures" / "review_bench_cells.json").read_text("utf-8"))
        self.assertGreaterEqual(len(cells), 10)
        for c in cells:
            self.assertTrue(rb.has_record(c), c["name"])
            self.assertEqual(rb.score(c["record"], c["ground_truth"], c["files"]), c["expected"], c["name"])


if __name__ == "__main__":
    unittest.main()
