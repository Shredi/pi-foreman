"""Review bench (scripts/foreman_review_bench.py): scorer, verdict parse, task-dir validation, blindness,
resume and dry run. Offline; the end-to-end cell runs on the replay fake provider and is skipped without Pi."""
import contextlib
import io
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import foreman_bench as fb  # noqa: E402
import foreman_review_bench as rb  # noqa: E402

SAMPLES = ROOT / "bench" / "review-samples"
TRUTH = {"clean": False, "defects": [{"id": "d1", "file": "app/client.py", "lines": [38, 39], "class": "secret-log",
                                      "description": "x"}]}
FILES = ["app/client.py", "tests/test_client.py"]
HAVE_TOOLS = bool(shutil.which("node") and shutil.which("git"))


def pi_cli():
    try:
        p = rb.pi_cli_path()
    except (RuntimeError, OSError):
        return None
    return p if p.is_file() else None


class Parse(unittest.TestCase):
    def test_verdict_twin_of_verdictof(self):
        self.assertEqual(rb.verdict_of("VERDICT: PASS\n...\nOverall verdict: **FAIL**"), "fail")
        self.assertEqual(rb.verdict_of("**Verdict:** approve"), "pass")
        self.assertIsNone(rb.verdict_of("looks fine"))

    def test_items_and_fail_evidence(self):
        text = ("VERDICT: FAIL\n1. PASS done at app/client.py:30\n- **2. FAIL** app/client.py:38 logs it\n"
                "Defects:\n- tests/test_client.py:5 weak assert\nMissing: none\n3. Overall verdict: FAIL")
        self.assertEqual([(i["n"], i["verdict"]) for i in rb.items_of(text)], [(1, "PASS"), (2, "FAIL")])
        self.assertEqual(rb.fail_evidence(text), ["- **2. FAIL** app/client.py:38 logs it", "- tests/test_client.py:5 weak assert"])


class Score(unittest.TestCase):
    def s(self, text, truth=TRUTH):
        return rb.score(text, truth, FILES)

    def test_caught_by_class_word(self):
        self.assertEqual(self.s("VERDICT: FAIL\n2. FAIL client.py writes the bearer token to the log")["caught"], ["d1"])

    def test_caught_by_line_within_slack(self):
        self.assertEqual(self.s("VERDICT: FAIL\n2. FAIL app/client.py:41 wrong")["caught"], ["d1"])
        self.assertEqual(self.s("VERDICT: FAIL\n2. FAIL app/client.py:45 wrong")["caught"], [])

    def test_other_file_or_basename_is_no_catch(self):
        r = self.s("VERDICT: FAIL\n2. FAIL tests/test_client.py:38 token logged")
        self.assertEqual((r["caught"], r["false_alarms"]), ([], ["tests/test_client.py"]))

    def test_overall_pass_scores_nothing(self):
        r = self.s("VERDICT: PASS\n2. FAIL app/client.py:38 token logged")
        self.assertEqual((r["caught"], r["false_alarms"]), ([], []))

    def test_false_alarms_on_clean_task(self):
        clean = {"clean": True, "defects": []}
        r = self.s("VERDICT: FAIL\n1. FAIL tests do not run\n- app/client.py:3 x\n- app/client.py:9 y", clean)
        self.assertEqual(r["false_alarms"], ["(no file)", "app/client.py"])
        self.assertEqual(self.s("VERDICT: PASS\n1. PASS ok\nMissing: none", clean)["false_alarms"], [])


class TaskDirs(unittest.TestCase):
    def test_samples_are_valid(self):
        tasks = rb.find_tasks(SAMPLES)
        self.assertEqual([t.name for t in tasks], ["py-clean", "py-token-log", "ts-shell"])
        self.assertEqual({t.name: rb.validate_task(t) for t in tasks}, {t.name: [] for t in tasks})

    def test_invalid_task_dirs(self):
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp, True)
        t = Path(tmp)
        self.assertIn("no base/ or base.tar.gz", rb.validate_task(t))
        (t / "ground_truth.json").write_text(json.dumps({"clean": True, "defects": TRUTH["defects"]}), "utf-8")
        self.assertIn("ground_truth.json: a clean task has no defects", rb.validate_task(t))
        bad = {"clean": False, "defects": [dict(TRUTH["defects"][0], **{"class": "typo", "lines": [9, 2]})]}
        errs = rb.truth_errors(bad)
        self.assertTrue(any("class 'typo'" in e for e in errs) and any("lines must be" in e for e in errs), errs)


@unittest.skipUnless(HAVE_TOOLS, "needs node and git")
class Blind(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.bench = rb.Bench(Path(self.tmp) / "out", rb.find_tasks(SAMPLES), ["foreman-fake/reviewer"],
                              work=Path(self.tmp) / "work")

    def test_composed_launch_is_blind(self):
        prep = self.bench.prepare("py-token-log", "foreman-fake/reviewer", 1)
        self.assertEqual(prep["blind"], [])
        text = "\n".join([prep["system"], prep["user"], str(prep["repo"])] + list(prep["env"].values())).lower()
        for needle in ("seeded", "ground_truth", str(SAMPLES.resolve()).lower(), SAMPLES.resolve().as_posix().lower()):
            self.assertNotIn(needle, text)
        self.assertFalse(any("ground_truth" in p.name for p in Path(prep["repo"]).rglob("*")))
        self.assertIn("## Owner task text", prep["user"])  # the augment ran (the diff has facts)

    def test_violations_are_found(self):
        tree = Path(self.tmp) / "tree"
        tree.mkdir()
        (tree / "ground_truth.json").write_text("{}", "utf-8")
        task = SAMPLES / "py-clean"
        bad = rb.blind_violations({"task": "see %s, seeded" % task.resolve()}, tree, task)
        self.assertEqual(len(bad), 3, bad)


class ResumeAndDryRun(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, str(self.tmp), True)

    def test_existing_cell_is_skipped_and_table_written(self):
        out = self.tmp / "run1"
        bench = rb.Bench(out, [SAMPLES / "py-token-log"], ["foreman-fake/reviewer"], repeats=1, log=lambda s: None)
        bench.cells_dir.mkdir(parents=True)
        rec = {"task": "py-token-log", "model": "foreman-fake/reviewer", "repeat": 1, "status": "ok", "secs": 3,
               "final_text": "VERDICT: FAIL\n1. FAIL apiclient/client.py:38 logs the bearer token",
               "ground_truth": bench.truth("py-token-log"), "files": ["apiclient/client.py"], "usd": None}
        bench.cell_path("py-token-log", "foreman-fake/reviewer", 1).write_text(json.dumps(rec), "utf-8")
        bench.run_cell = lambda *c: self.fail("a finished cell was launched again")
        self.assertEqual(bench.run(), 0)
        table = (out / "review-bench-run1.md").read_text("utf-8")
        self.assertIn("| foreman-fake/reviewer | 1 | 1/1 (100%) |", table)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            self.assertEqual(fb.main(["review-table", "--out", str(out)]), 0)
        self.assertIn("secret-log", buf.getvalue())

    @unittest.skipUnless(HAVE_TOOLS, "needs node and git")
    def test_dry_run_launches_nothing_and_writes_nothing(self):
        out = self.tmp / "dry"
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            code = rb.main(["--tasks", str(SAMPLES), "--models", "foreman-fake/reviewer", "--repeats", "1",
                            "--out", str(out), "--dry-run"])
        self.assertEqual(code, 0, buf.getvalue())
        self.assertFalse(out.exists())
        self.assertEqual(buf.getvalue().count("blind ok"), 3)


@unittest.skipUnless(HAVE_TOOLS and pi_cli(), "needs node, git and the Pi CLI")
class FakeCell(unittest.TestCase):
    def test_one_cell_on_the_fake_provider(self):
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, str(tmp), True)
        script = tmp / "script.json"
        answer = "VERDICT: FAIL\n1. PASS ok\n2. FAIL apiclient/client.py:38 the warning logs the bearer token\nMissing: none"
        script.write_text(json.dumps({"*": {"review-bench": [{"text": answer}]}}), "utf-8")
        bench = rb.Bench(tmp / "out", [SAMPLES / "py-token-log"], ["foreman-fake/reviewer"], repeats=1, timeout=120,
                         work=tmp / "work", pi_cli=pi_cli(), fake_script=script, prices=fb.load_prices(),
                         log=lambda s: None)
        bench.cells_dir.mkdir(parents=True)
        rec = bench.run_cell("py-token-log", "foreman-fake/reviewer", 1)
        self.assertEqual(rec["status"], "ok", rec.get("error"))
        self.assertEqual((rec["verdict"], rec["score"]["caught"]), ("fail", ["d1"]))
        self.assertTrue(bench.cell_path("py-token-log", "foreman-fake/reviewer", 1).is_file())
        self.assertNotIn("CLAUDE_CODE_OAUTH_TOKEN", rec["env_set"])


if __name__ == "__main__":
    unittest.main()
