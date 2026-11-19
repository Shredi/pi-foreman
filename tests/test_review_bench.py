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


def rec(verdict, *findings, launch="l1"):
    """A verdict record; each finding is (kind, text, file, line, class)."""
    fs = []
    for kind, text, *rest in findings:
        f = {"kind": kind, "text": text}
        f.update({k: v for k, v in zip(("file", "line", "class"), rest) if v is not None})
        fs.append(f)
    return {"v": 1, "launchId": launch, "verdict": verdict, "items": [], "findings": fs}


class Records(unittest.TestCase):
    def test_read_record_needs_this_launch_and_a_verdict(self):
        d = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, str(d), True)
        self.assertIsNone(rb.read_record(d, "l1"))
        (d / "verdict.json").write_text(json.dumps(rec("fail")), "utf-8")
        self.assertEqual(rb.read_record(d, "l1")["verdict"], "fail")
        self.assertIsNone(rb.read_record(d, "other"))
        (d / "verdict.json").write_text(json.dumps(dict(rec("fail"), verdict="maybe")), "utf-8")
        self.assertIsNone(rb.read_record(d, "l1"))
        (d / "verdict.json").write_text("{not json", "utf-8")
        self.assertIsNone(rb.read_record(d, "l1"))

    def test_a_cell_has_a_record_when_the_key_exists(self):
        self.assertTrue(rb.has_record({"record": None}))
        self.assertTrue(rb.has_record({"record": rec("pass")}))
        self.assertFalse(rb.has_record({"final_text": "VERDICT: PASS"}))
        d = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, str(d), True)
        (d / "new.json").write_text(json.dumps({"record": None}), "utf-8")
        (d / "old.json").write_text(json.dumps({"final_text": "x"}), "utf-8")
        self.assertEqual([rb.cell_has_record(d / n) for n in ("new.json", "old.json", "none.json")], [True, False, False])

    def test_located_findings_name_a_diff_file_and_give_a_line_or_class(self):
        r = rec("fail", ("defect", "a", "app/client.py", 38), ("defect", "b", "app/client.py", 39), ("defect", "c", "app/client.py"),
                ("defect", "d", "app/other.py", 3), ("later", "e", "app/client.py", 90))
        self.assertEqual([f["text"] for f in rb.located_findings(r, FILES)], ["a"])
        self.assertEqual(rb.located_findings(None, FILES), [])


class Score(unittest.TestCase):
    def s(self, record, truth=TRUTH, files=FILES):
        return rb.score(record, truth, files)

    def test_located_and_diagnosed_by_class(self):
        r = self.s(rec("fail", ("defect", "writes the bearer token", "client.py", 90, "secret-log")))
        self.assertEqual((r["located"], r["diagnosed"], r["scorer"]), (["d1"], ["d1"], rb.SCORER_VERSION))
        self.assertNotIn("process", r)

    def test_line_within_slack_locates_but_does_not_diagnose(self):
        r = self.s(rec("fail", ("defect", "wrong", "app/client.py", 41)))
        self.assertEqual((r["located"], r["diagnosed"]), (["d1"], []))
        self.assertEqual(self.s(rec("fail", ("defect", "wrong", "app/client.py", 45)))["located"], [])

    def test_a_wrong_class_in_the_file_locates_by_nothing_unless_line_or_symbol(self):
        r = self.s(rec("fail", ("defect", "x", "app/client.py", 90, "race")))
        self.assertEqual((r["located"], len(r["false_alarms"])), ([], 1))
        sym = {"clean": False, "defects": [dict(TRUTH["defects"][0], description="retry_warning prints every header")]}
        r = self.s(rec("fail", ("defect", "`retry_warning` is new and unasked", "app/client.py", 90, "race")), sym)
        self.assertEqual((r["located"], r["diagnosed"], r["false_alarms"]), (["d1"], [], []))

    def test_basename_needs_full_path_or_unique_name(self):
        files = ["app/client.py", "lib/client.py"]
        self.assertEqual(self.s(rec("fail", ("defect", "x", "client.py", 38)), files=files)["located"], [])
        self.assertEqual(self.s(rec("fail", ("defect", "x", "lib/client.py", 38)), files=files)["located"], [])
        self.assertEqual(self.s(rec("fail", ("defect", "x", "app/client.py", 38)), files=files)["located"], ["d1"])
        self.assertEqual(self.s(rec("fail", ("defect", "x", "client.py", 38)))["located"], ["d1"])

    def test_false_alarms_are_unmatched_defects_and_notes_are_now_or_later(self):
        r = self.s(rec("fail", ("defect", "logs the token", "app/client.py", 38), ("defect", "style nit", "app/client.py", 90),
                       ("defect", "no file at all"), ("now", "rename", "app/util.py", 7), ("later", "split")))
        self.assertEqual((r["located"], r["false_alarms"], r["notes"]), (["d1"], ["style nit", "no file at all"], 2))
        clean = {"clean": True, "defects": []}
        r = self.s(rec("fail", ("defect", "tests do not run"), ("defect", "y", "app/client.py", 9)), clean)
        self.assertEqual(len(r["false_alarms"]), 2)

    def test_only_a_fail_record_scores(self):
        for r in (rec("pass", ("later", "x", "app/client.py", 38)), rec("incomplete", ("defect", "x", "app/client.py", 38)), None):
            res = self.s(r)
            self.assertEqual((res["located"], res["false_alarms"], res["missed"]), ([], [], ["d1"]))
        self.assertEqual(self.s(rec("pass"))["verdict"], "pass")
        self.assertEqual(self.s(rec("incomplete"))["verdict"], "incomplete")
        self.assertIsNone(self.s(None)["verdict"])


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
        self.assertIn("## Facts to rule on", prep["user"])  # the augment ran (the diff has facts)
        self.assertNotIn("Owner task text", prep["user"])

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
        cell = {"task": "py-token-log", "model": "foreman-fake/reviewer", "repeat": 1, "status": "ok", "secs": 3,
                "record": rec("fail", ("defect", "logs the bearer token", "apiclient/client.py", 38, "secret-log")),
                "ground_truth": bench.truth("py-token-log"), "files": ["apiclient/client.py"], "usd": None,
                "score": {"located": [], "diagnosed": [], "false_alarms": ["stale"]}}
        bench.cell_path("py-token-log", "foreman-fake/reviewer", 1).write_text(json.dumps(cell), "utf-8")
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

    def test_stale_cell_is_launched_again_and_reported_stale(self):
        out = self.tmp / "run2"
        bench = rb.Bench(out, [SAMPLES / "py-token-log"], ["foreman-fake/reviewer"], repeats=1, log=lambda s: None)
        bench.cells_dir.mkdir(parents=True)
        path = bench.cell_path("py-token-log", "foreman-fake/reviewer", 1)
        path.write_text(json.dumps({"task": "py-token-log", "model": "foreman-fake/reviewer", "repeat": 1, "status": "ok",
                                    "final_text": "VERDICT: PASS", "ground_truth": {"clean": True, "defects": []}}), "utf-8")
        launched = []
        bench.run_cell = lambda *c: launched.append(c) or {"status": "error", "error": "stop"}
        bench.run()
        self.assertEqual(len(launched), 1)
        table = rb.render_table(out)
        self.assertIn("0 scored, 1 stale", table)
        self.assertIn("## Stale cells", table)
        self.assertIn(rb.cell_name("py-token-log", "foreman-fake/reviewer", 1), table)


@unittest.skipUnless(HAVE_TOOLS and pi_cli(), "needs node, git and the Pi CLI")
class FakeCell(unittest.TestCase):
    def test_one_cell_on_the_fake_provider(self):
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, str(tmp), True)
        script = tmp / "script.json"
        script.write_text(json.dumps({"*": {"review-bench": [{"tools": [verdict_call("fail", "apiclient/client.py", 38, "secret-log")]},
                                                            {"text": "done"}]}}), "utf-8")
        bench = rb.Bench(tmp / "out", [SAMPLES / "py-token-log"], ["foreman-fake/reviewer"], repeats=1, timeout=120,
                         work=tmp / "work", pi_cli=pi_cli(), fake_script=script, prices=fb.load_prices(),
                         log=lambda s: None)
        bench.cells_dir.mkdir(parents=True)
        rec = bench.run_cell("py-token-log", "foreman-fake/reviewer", 1)
        self.assertEqual(rec["status"], "ok", rec.get("error"))
        self.assertEqual((rec["record"]["verdict"], rec["score"]["verdict"], rec["score"]["diagnosed"]), ("fail", "fail", ["d1"]))
        self.assertTrue(bench.cell_path("py-token-log", "foreman-fake/reviewer", 1).is_file())
        self.assertNotIn("CLAUDE_CODE_OAUTH_TOKEN", rec["env_set"])


def verdict_call(verdict, file=None, line=None, cls=None):
    """A replay-script step: the review_verdict call of a reviewer (items 1-3 are the bench ledger)."""
    args = {"verdict": verdict, "items": [{"id": 1, "result": "fail" if verdict == "fail" else "pass"}]}
    if file:
        args["findings"] = [{"kind": "defect", "text": "the warning logs the bearer token", "file": file, "line": line, "class": cls}]
    return {"name": "review_verdict", "arguments": args}


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
        for model, record in (("p/a", rec("fail", ("defect", "logs the bearer token", "app/client.py", 38, "secret-log"))), ("p/b", rec("pass"))):
            cell = {"task": "t", "model": model, "repeat": 1, "status": "ok", "secs": 5, "usd": 0.25, "record": record,
                    "ground_truth": truth, "files": FILES}
            (out / "cells" / (rb.cell_name("t", model, 1) + ".json")).write_text(json.dumps(cell), "utf-8")
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


class WorkDirLifecycle(unittest.TestCase):
    """The work dir (repo clones) is removed after a run, only ever under <tempdir>/pf-rb-work/."""
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, str(self.tmp), True)
        old = tempfile.tempdir
        tempfile.tempdir = str(self.tmp / "tmpdir")  # the guard's base; the real temp dir is never touched
        (self.tmp / "tmpdir").mkdir()
        self.addCleanup(setattr, tempfile, "tempdir", old)
        self.logs = []

    def bench(self, **kw):
        return rb.Bench(self.tmp / "out", [SAMPLES / "py-token-log"], ["foreman-fake/reviewer"], repeats=1, timeout=120,
                        log=self.logs.append, **kw)

    def fake_run(self, **kw):
        script = self.tmp / "script.json"
        script.write_text(json.dumps({"*": {"review-bench": [{"tools": [verdict_call("fail", "apiclient/client.py", 38, "secret-log")]},
                                                            {"text": "done"}]}}), "utf-8")
        b = self.bench(pi_cli=pi_cli(), fake_script=script, prices=fb.load_prices(), **kw)
        return b, b.run()

    def seeded(self, b):
        (b.work / "cell").mkdir(parents=True)
        (b.work / "cell" / "f.txt").write_text("x", "utf-8")

    def test_finish_removes_managed_dir_and_logs_size(self):
        b = self.bench()
        self.seeded(b)
        b.finish_work(0)
        self.assertFalse(b.work.exists())
        self.assertTrue(any(l.startswith("work dir removed: %s (" % b.work) for l in self.logs), self.logs)

    def test_keep_work_and_interrupt_keep_the_dir(self):
        b = self.bench(keep_work=True)
        self.seeded(b)
        b.finish_work(0)
        self.assertTrue(b.work.exists())
        self.assertIn("work dir kept: %s" % b.work, self.logs)
        b2 = self.bench()
        b2.finish_work(6)
        self.assertTrue(b2.work.exists())
        self.assertTrue(any("interrupted" in l for l in self.logs))

    def test_user_work_path_is_kept_even_under_pf_rb_work(self):
        for w in (self.tmp / "mine", self.tmp / "tmpdir" / "pf-rb-work" / "mine"):
            b = self.bench(work=w)
            self.seeded(b)
            b.finish_work(0)
            self.assertTrue(w.exists(), w)
            self.assertIn("work dir kept: %s" % w, self.logs)

    def test_prune_refuses_paths_outside_pf_rb_work(self):
        base = self.tmp / "tmpdir" / "pf-rb-work"
        outside = self.tmp / "outside"
        (outside / "d").mkdir(parents=True)
        base.mkdir()
        (base / "link").symlink_to(outside, target_is_directory=True)
        self.assertFalse(rb._prune_work(outside))
        self.assertFalse(rb._prune_work(base))  # the base itself stays
        self.assertFalse(rb._prune_work(base / "link"))  # a symlink out resolves outside
        self.assertTrue((outside / "d").exists())
        (base / "abc").mkdir()
        self.assertTrue(rb._prune_work(base / "abc"))
        self.assertFalse((base / "abc").exists())

    @unittest.skipUnless(HAVE_TOOLS and pi_cli(), "needs node, git and the Pi CLI")
    def test_fake_run_prunes_cell_dirs_and_work_dir(self):
        b, code = self.fake_run()
        self.assertEqual(code, 0)
        self.assertFalse(b.work.exists())
        self.assertTrue(b.cell_path("py-token-log", "foreman-fake/reviewer", 1).is_file())
        self.assertIn("py-token-log", (b.out / ("review-bench-%s.md" % b.out.name)).read_text("utf-8"))

    @unittest.skipUnless(HAVE_TOOLS and pi_cli(), "needs node, git and the Pi CLI")
    def test_fake_run_keep_work(self):
        b, code = self.fake_run(keep_work=True)
        self.assertEqual(code, 0)
        self.assertTrue(any(b.work.iterdir()))

    def test_partial_policy_rows_are_marked(self):
        out = self.tmp / "run"
        (out / "cells").mkdir(parents=True)
        (out / "run.json").write_text(json.dumps({"tasks": ["t", "u"], "models": ["p/a"], "repeats": 1, "mode": "single"}), "utf-8")
        cell = {"task": "t", "model": "p/a", "repeat": 1, "status": "ok", "secs": 5, "usd": 0.25,
                "record": rec("pass"), "ground_truth": {"clean": True, "defects": []}, "files": FILES}
        (out / "cells" / (rb.cell_name("t", "p/a", 1) + ".json")).write_text(json.dumps(cell), "utf-8")
        (out / "cells" / (rb.cell_name("u", "p/a", 1) + ".error.json")).write_text(
            json.dumps({"task": "u", "model": "p/a", "repeat": 1, "status": "error", "error": "boom"}), "utf-8")
        self.assertIn("| single:p/a (partial: 1/2 cells) | run |", rb.render_table(out))
        (out / "cells" / (rb.cell_name("u", "p/a", 1) + ".error.json")).unlink()
        (out / "cells" / (rb.cell_name("u", "p/a", 1) + ".json")).write_text(json.dumps(dict(cell, task="u")), "utf-8")
        table = rb.render_table(out)
        self.assertIn("| single:p/a | run | 2 |", table)
        self.assertNotIn("partial", table)


@unittest.skipUnless(HAVE_TOOLS and pi_cli(), "needs node, git and the Pi CLI")
class FakeClimb(unittest.TestCase):
    RUNGS = ["foreman-fake/reviewer", "foreman-fake/senior-reviewer"]
    FAIL = verdict_call("fail", "reports/store.py", 25, "path-traversal")
    PASS = verdict_call("pass")

    def climb(self, first, second):
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, str(tmp), True)
        script = tmp / "script.json"
        script.write_text(json.dumps({m.split("/")[1]: {"review-bench": [{"tools": [x]}, {"text": "done"}]} for m, x in zip(self.RUNGS, (first, second))}), "utf-8")
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
