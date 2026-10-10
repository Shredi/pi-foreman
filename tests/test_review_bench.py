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

    def test_pass_sub_bullets_and_prose_are_no_evidence(self):  # bug 1
        text = ("VERDICT: FAIL\nContext: app/util.py:3 was read first.\n1. PASS done:\n   - app/util.py:12 adds the cap\n"
                "   - app/util.py:20 trims it\n2. FAIL app/client.py:38 logs it\n   - see app/client.py:39\n"
                "Overall: FAIL because of app/util.py:12")
        self.assertEqual(rb.fail_units(text), [["2. FAIL app/client.py:38 logs it", "- see app/client.py:39"]])

    def test_doubled_numbering_and_numbered_missing(self):  # bug 4
        text = "VERDICT: FAIL\n1. 1. PASS ok at app/util.py:4\n2. FAIL x\n4. Missing: app/schema.sql was not in the diff"
        self.assertEqual([(i["n"], i["verdict"]) for i in rb.items_of(text)], [(1, "PASS"), (2, "FAIL")])
        self.assertEqual(rb.fail_units(text), [["2. FAIL x"], ["4. Missing: app/schema.sql was not in the diff"]])


class Score(unittest.TestCase):
    def s(self, text, truth=TRUTH, files=FILES):
        return rb.score(text, truth, files)

    def test_located_and_diagnosed_by_class_word(self):
        r = self.s("VERDICT: FAIL\n2. FAIL client.py writes the bearer token to the log")
        self.assertEqual((r["located"], r["diagnosed"], r["scorer"]), (["d1"], ["d1"], rb.SCORER_VERSION))

    def test_line_within_slack_locates_but_does_not_diagnose(self):  # bug 5
        r = self.s("VERDICT: FAIL\n2. FAIL app/client.py:41 wrong")
        self.assertEqual((r["located"], r["diagnosed"]), (["d1"], []))
        self.assertEqual(self.s("VERDICT: FAIL\n2. FAIL app/client.py:45 wrong")["located"], [])

    def test_negated_class_word_does_not_diagnose(self):  # bug 5
        race = {"clean": False, "defects": [{"id": "d1", "file": "app/counter.go", "lines": [63, 63], "class": "race",
                                             "description": "counter bumped without the lock"}]}
        r = self.s("VERDICT: FAIL\n2. FAIL app/counter.go:63 bumps a counter, so it is not a race", race, ["app/counter.go"])
        self.assertEqual((r["located"], r["diagnosed"]), (["d1"], []))
        r = self.s("VERDICT: FAIL\n2. FAIL app/counter.go:63 bumps a counter: a data race", race, ["app/counter.go"])
        self.assertEqual(r["diagnosed"], ["d1"])

    def sym(self, cls, phrase):
        t = {"clean": False, "defects": [{"id": "d1", "file": "app/x.py", "lines": [10, 10], "class": cls,
                                          "description": "y"}]}
        r = rb.score("VERDICT: FAIL\n2. FAIL app/x.py:90 " + phrase, t, ["app/x.py"])
        return r["diagnosed"] == ["d1"]

    def test_symptom_phrases_diagnose(self):  # scorer v3
        cases = [("auth", "ids with bad chars still pass validation"), ("auth", "the check accepts forbidden characters"),
                 ("swallowed-error", "if the read fails, nothing is logged now"),
                 ("swallowed-error", "the patch removes the initial error log"),
                 ("swallowed-error", "the read error log was removed"),
                 ("resource-leak", "a stale value survives"), ("resource-leak", "it never clears the field"),
                 ("resource-leak", "it keeps its old value"),
                 ("off-by-one", "starts one row too far left"), ("off-by-one", "a one-cell gap in the range"),
                 ("off-by-one", "the buffer is one byte short"), ("off-by-one", "should be end - 1")]
        for cls, phrase in cases:
            self.assertTrue(self.sym(cls, phrase), phrase)

    def test_symptom_phrases_negated_or_near_miss_do_not_diagnose(self):  # scorer v3
        cases = [("auth", "does not pass validation here"), ("auth", "it accepts the request"),
                 ("swallowed-error", "no error log was removed"), ("swallowed-error", "nothing else is printed"),
                 ("resource-leak", "a stale comment above"), ("resource-leak", "a stale readme"),
                 ("resource-leak", "this is not clearly a problem"), ("resource-leak", "keeps its shape"),
                 ("off-by-one", "one cell is fine"), ("off-by-one", "not one row too far"),
                 ("off-by-one", "bumps the version to 1.4 + 1.5"), ("off-by-one", "total is 3 + 1 lines"),
                 ("off-by-one", "adds v2 + 10")]
        for cls, phrase in cases:
            self.assertFalse(self.sym(cls, phrase), phrase)

    def test_approximate_lines_and_file_only_bullets_locate(self):  # bug 2
        for ref in ("app/client.py:~38", "client.py ~40", "app/client.py:~L39", "app/client.py:L36", "app/client.py lines 30-36"):
            self.assertEqual(self.s("VERDICT: FAIL\n2. FAIL odd write at %s" % ref)["located"], ["d1"], ref)
        sym = {"clean": False, "defects": [dict(TRUTH["defects"][0], description="retry_warning prints every header")]}
        r = self.s("VERDICT: FAIL\n2. FAIL two problems:\n   - `app/client.py`: `retry_warning` is new and unasked", sym)
        self.assertEqual((r["located"], r["false_alarms"]), (["d1"], []))

    def test_basename_needs_full_path_or_unique_name(self):  # bug 3
        files = ["app/client.py", "lib/client.py"]
        self.assertEqual(self.s("VERDICT: FAIL\n2. FAIL client.py:38 leaks the token", files=files)["located"], [])
        self.assertEqual(self.s("VERDICT: FAIL\n2. FAIL lib/client.py:38 leaks the token", files=files)["located"], [])
        self.assertEqual(self.s("VERDICT: FAIL\n2. FAIL app/client.py:38 leaks the token", files=files)["located"], ["d1"])
        self.assertEqual(self.s("VERDICT: FAIL\n2. FAIL client.py:38 leaks the token")["located"], ["d1"])

    def test_false_alarms_per_item_and_process_items(self):  # bug 6
        text = ("VERDICT: FAIL\n1. FAIL no tests were added for the change\n2. FAIL defects:\n"
                "   - tests/test_client.py:5 weak assert\n     also tests/test_client.py:9\n   - app/util.py:2 and app/x.py:3 typo\n"
                "   - app/client.py:38 logs the token\n   - app/client.py:90 style nit\n   - app/util.py:7 harmless, not blocking")
        r = self.s(text, files=FILES + ["app/util.py", "app/x.py"])
        self.assertEqual((r["located"], len(r["false_alarms"]), r["process"], r["notes"]), (["d1"], 2, 1, 1))
        clean = {"clean": True, "defects": []}
        r = self.s("VERDICT: FAIL\n1. FAIL tests do not run\n2. FAIL app/client.py:3 x\n- app/client.py:9 y", clean)
        self.assertEqual((len(r["false_alarms"]), r["process"]), (1, 1))

    def test_overall_pass_scores_nothing(self):
        r = self.s("VERDICT: PASS\n2. FAIL app/client.py:38 token logged")
        self.assertEqual((r["located"], r["false_alarms"]), ([], []))
        self.assertEqual(self.s("VERDICT: PASS\n1. PASS ok\nMissing: none", {"clean": True, "defects": []})["false_alarms"], [])


class TaskDirs(unittest.TestCase):
    def test_samples_are_valid(self):
        tasks = rb.find_tasks(SAMPLES)
        self.assertEqual([t.name for t in tasks], ["py-clean", "py-path-serve", "py-shell-filter", "py-token-log", "ts-shell"])
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
               "ground_truth": bench.truth("py-token-log"), "files": ["apiclient/client.py"], "usd": None,
               "score": {"located": [], "diagnosed": [], "false_alarms": ["stale"]}}
        bench.cell_path("py-token-log", "foreman-fake/reviewer", 1).write_text(json.dumps(rec), "utf-8")
        bench.run_cell = lambda *c: self.fail("a finished cell was launched again")
        self.assertEqual(bench.run(), 0)
        table = (out / "review-bench-run1.md").read_text("utf-8")
        self.assertIn("Scorer v%d." % rb.SCORER_VERSION, table)  # rescored, the stored score is ignored
        self.assertIn("| foreman-fake/reviewer | 1 | 1/1 (100%) | 1/1 (100%) | 0/1 |", table)
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
        self.assertEqual(buf.getvalue().count("blind ok"), 5)


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
        self.assertEqual((rec["verdict"], rec["score"]["diagnosed"]), ("fail", ["d1"]))
        self.assertTrue(bench.cell_path("py-token-log", "foreman-fake/reviewer", 1).is_file())
        self.assertNotIn("CLAUDE_CODE_OAUTH_TOKEN", rec["env_set"])


def _cell(model, rep, verdict, located, diagnosed, fa, secs, usd, clean=False, defects=1):
    return {"task": "t", "model": model, "repeat": rep, "secs": secs, "usd": usd,
            "score": {"clean": clean, "verdict": verdict, "located": located, "diagnosed": diagnosed,
                      "false_alarms": ["x"] * fa, "defects": defects}}


class Policies(unittest.TestCase):
    def test_nearest_rank_and_stats_on_synthetic_units(self):
        self.assertEqual([rb.nearest_rank(list(range(1, 11)), p) for p in (50, 90, 100)], [5, 9, 10])
        self.assertIsNone(rb.nearest_rank([], 90))
        a1, a2 = _cell("a", 1, "fail", ["d1"], [], 1, 10, 0.1), _cell("b", 1, "pass", [], ["d1"], 0, 30, 0.5)
        b1 = _cell("a", 2, "pass", [], [], 0, 20, 0.1, clean=True, defects=0)
        c1 = _cell("a", 3, "fail", [], [], 2, 40, 0.1, clean=True, defects=0)
        s = rb.policy_stats([{"cells": [a1, a2], "stop": 2}, {"cells": [b1], "stop": 1}, {"cells": [c1], "stop": "exhausted"}])
        self.assertEqual((s["cells"], s["located"], s["diagnosed"], s["total"]), (3, 1, 1, 1))  # union over rungs
        self.assertEqual((s["fa_seeded"], s["fa_clean"], s["seeded"], s["clean"]), (1, 2, 1, 2))
        self.assertAlmostEqual(s["usd"], 0.8)
        self.assertEqual((s["median"], s["p90"], s["hist"]), (40, 40, {"r2": 1, "r1": 1, "ex": 1}))

    def test_table_marks_climb_rows_as_composed(self):
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, str(tmp), True)
        out = tmp / "run"
        (out / "cells").mkdir(parents=True)
        (out / "policies" / "x").mkdir(parents=True)
        truth = {"clean": False, "defects": [dict(TRUTH["defects"][0])]}
        for model, text in (("p/a", "VERDICT: FAIL\n1. FAIL app/client.py:38 logs the bearer token"), ("p/b", "VERDICT: PASS")):
            rec = {"task": "t", "model": model, "repeat": 1, "status": "ok", "secs": 5, "usd": 0.25, "final_text": text,
                   "ground_truth": truth, "files": FILES}
            (out / "cells" / (rb.cell_name("t", model, 1) + ".json")).write_text(json.dumps(rec), "utf-8")
        pol = {"policy": rb.climb_policy(["p/a", "p/b"]), "task": "t", "repeat": 1, "stop_rung": 2,
               "rungs": [{"cell": rb.cell_name("t", "p/a", 1)}, {"cell": rb.cell_name("t", "p/b", 1)}]}
        (out / "policies" / "x" / "t__r1.json").write_text(json.dumps(pol), "utf-8")
        table = rb.render_table(out)
        self.assertIn("| single:p/a | run | 1 | 1/1 (100%) | 1/1 (100%) | 0 |", table)
        self.assertIn("| climb:a\u2192b | composed from cached rungs | 1 | 1/1 (100%) | 1/1 (100%) | 0 | 0/1 | 0/0 | 0.500 | 0.500 | 10 | 10 | r2:1 |", table)
        self.assertIn("composed from cached single-model rung cells", table)

    def test_mode_flags(self):
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            self.assertEqual(rb.main(["--tasks", str(SAMPLES), "--mode", "climb"]), 2)
            self.assertEqual(rb.main(["--tasks", str(SAMPLES), "--rungs", "a/x,a/y"]), 2)
        self.assertIn("--rungs", err.getvalue())


@unittest.skipUnless(HAVE_TOOLS and pi_cli(), "needs node, git and the Pi CLI")
class FakeClimb(unittest.TestCase):
    RUNGS = ["foreman-fake/reviewer", "foreman-fake/senior-reviewer"]
    FAIL = "VERDICT: FAIL\n1. FAIL reports/store.py:25 path traversal: ../ segments escape the root"
    PASS = "VERDICT: PASS\n1. PASS ok"

    def climb(self, first, second):
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, str(tmp), True)
        script = tmp / "script.json"
        script.write_text(json.dumps({m.split("/")[1]: {"review-bench": [{"text": x}]} for m, x in zip(self.RUNGS, (first, second))}), "utf-8")
        bench = rb.Bench(tmp / "out", [SAMPLES / "py-path-serve"], self.RUNGS, repeats=1, timeout=120, work=tmp / "work",
                         pi_cli=pi_cli(), fake_script=script, prices=fb.load_prices(), log=lambda s: None, mode="climb")
        bench.cells_dir.mkdir(parents=True)
        self.assertEqual(bench.run_chain("py-path-serve", 1), "done")
        return bench, json.loads(bench.policy_path("py-path-serve", 1).read_text("utf-8"))

    def test_located_first_rung_climbs_to_the_second(self):
        bench, rec = self.climb(self.FAIL, self.PASS)
        self.assertEqual((rec["policy"], rec["stop_rung"], [r["located_count"] for r in rec["rungs"]]),
                         ("climb:reviewer\u2192senior-reviewer", 2, [1, 0]))
        cells = [json.loads(bench.cell_path("py-path-serve", m, 1).read_text("utf-8")) for m in self.RUNGS]
        self.assertAlmostEqual(rec["secs"], sum(c["secs"] for c in cells), places=1)
        self.assertAlmostEqual(rec["usd"] or 0, sum(c["usd"] or 0 for c in cells), places=5)
        self.assertEqual(rec["rung_secs"], [c["secs"] for c in cells])

    def test_clean_first_rung_never_runs_the_second(self):
        bench, rec = self.climb(self.PASS, self.FAIL)
        self.assertEqual((rec["stop_rung"], len(rec["rungs"])), (1, 1))
        self.assertFalse(bench.cell_path("py-path-serve", self.RUNGS[1], 1).exists())


if __name__ == "__main__":
    unittest.main()
