"""scripts/foreman_findings.py: the extraction half of scorer v3 and located_findings (no ground truth)."""
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
import foreman_findings as ff  # noqa: E402
import foreman_review_bench as rb  # noqa: E402

FILES = ["app/client.py", "tests/test_client.py"]


class Helpers(unittest.TestCase):
    def test_reexported_by_the_bench(self):
        for n in ("verdict_of", "items_of", "fail_units", "fail_evidence", "names_file", "patch_files", "symbols_of",
                  "CLASSES", "CLASS_SYNONYMS", "LINE_SLACK"):
            self.assertIs(getattr(rb, n), getattr(ff, n))
        self.assertEqual(rb.SCORER_VERSION, 3)

    def test_verdict_items_units(self):
        text = "VERDICT: FAIL\n1. PASS ok app/x.py:1\n2. FAIL app/client.py:38 logs it\n   - more\nOverall: FAIL"
        self.assertEqual(ff.verdict_of(text), "fail")
        self.assertEqual([(i["n"], i["verdict"]) for i in ff.items_of(text)], [(1, "PASS"), (2, "FAIL")])
        self.assertEqual(ff.fail_units(text), [["2. FAIL app/client.py:38 logs it", "- more"]])

    def test_names_file_and_spans(self):
        self.assertTrue(ff.names_file("see client.py:3", "app/client.py", FILES))
        self.assertFalse(ff.names_file("see client.py:3", "app/client.py", FILES + ["lib/client.py"]))
        self.assertEqual(ff._line_spans("app/client.py:38-40 x", "app/client.py"), [(38, 40)])
        self.assertTrue(ff._negated("this is not a race", 15))
        self.assertEqual(ff.patch_files("--- a/x.py\n+++ b/x.py\n--- /dev/null\n+++ b/y.py\n"), ["x.py", "y.py"])


class Located(unittest.TestCase):
    def test_fail_unit_with_path_line_and_class(self):
        r = ff.located_findings("VERDICT: FAIL\n2. FAIL app/client.py:38 logs the bearer token\n", FILES)
        self.assertEqual(r, [{"file": "app/client.py", "line": 38, "class": "secret-log",
                              "note": "2. FAIL app/client.py:38 logs the bearer token"}])

    def test_pass_report_can_still_list_a_located_defect(self):
        text = "VERDICT: PASS\n1. PASS ok at app/client.py:30\nNotes:\n- app/client.py:40 leaves the file handle unclosed\n"
        r = ff.located_findings(text, FILES)
        self.assertEqual([(f["file"], f["line"], f["class"]) for f in r], [("app/client.py", 40, "resource-leak")])
        self.assertEqual(ff.located_findings("VERDICT: PASS\n1. PASS ok at app/client.py:30\n- none", FILES), [])

    def test_negated_class_word_without_line_is_not_located(self):
        self.assertEqual(ff.located_findings("VERDICT: FAIL\n2. FAIL app/client.py is not a race\n", FILES), [])
        r = ff.located_findings("VERDICT: FAIL\n2. FAIL app/client.py:9 is not a race\n", FILES)
        self.assertEqual((r[0]["line"], r[0]["class"]), (9, None))

    def test_basename_ambiguity_and_no_located_finding(self):
        text = "VERDICT: FAIL\n2. FAIL client.py:38 logs the token\n"
        self.assertEqual(ff.located_findings(text, FILES + ["lib/client.py"]), [])
        self.assertEqual(ff.located_findings("VERDICT: FAIL\n2. FAIL no tests were added\n", FILES), [])
        self.assertEqual(ff.located_findings("VERDICT: PASS\n1. PASS fine", FILES), [])

    def test_dedupe_and_id(self):
        text = "VERDICT: FAIL\n2. FAIL app/client.py:38 leaks the token\n3. FAIL app/client.py:39 leaks the token\n"
        r = ff.located_findings(text, FILES)
        self.assertEqual(len(r), 1)
        self.assertEqual(ff.finding_id("a.py", 38, "race"), ff.finding_id("a.py", 36, "race"))
        self.assertNotEqual(ff.finding_id("a.py", 38, "race"), ff.finding_id("a.py", 38, None))
        self.assertEqual(len(ff.finding_id("a.py", None, None)), 12)

    def test_extract_cli(self):
        with tempfile.TemporaryDirectory() as d:
            lst = Path(d) / "files.txt"
            lst.write_text("\n".join(FILES), "utf-8")
            stdin = mock.Mock(buffer=io.BytesIO(b"VERDICT: FAIL\n2. FAIL app/client.py:38 logs the token\n"))
            out = io.StringIO()
            with mock.patch.object(sys, "stdin", stdin), contextlib.redirect_stdout(out):
                self.assertEqual(ff.main(["extract", "--files-from", str(lst)]), 0)
            data = json.loads(out.getvalue())
            self.assertEqual((data["verdict"], data["findings"][0]["class"], len(data["findings"][0]["id"])),
                             ("fail", "secret-log", 12))
            with contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(ff.main(["extract"]), 2)


class Rescoring(unittest.TestCase):
    def test_score_identical_to_stored_pre_refactor_fixtures(self):
        cells = json.loads((ROOT / "tests" / "fixtures" / "review_bench_cells.json").read_text("utf-8"))
        self.assertGreaterEqual(len(cells), 10)
        for c in cells:
            self.assertEqual(rb.score(c["final_text"], c["ground_truth"], c["files"]), c["expected"], c["name"])


if __name__ == "__main__":
    unittest.main()
