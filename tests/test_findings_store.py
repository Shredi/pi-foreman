"""scripts/foreman_findings.py live store: record, list, dismiss, export, outcomes, models table; retro models."""
from __future__ import annotations

import contextlib
import io
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import _isolation  # noqa: E402,F401  (agent dir -> temp)
import foreman_backlog as fb  # noqa: E402
import foreman_findings as ff  # noqa: E402
import foreman_retro as fr  # noqa: E402
import foreman_review_bench as rb  # noqa: E402

REPORT = "VERDICT: FAIL\n1. FAIL app/client.py:38 logs the bearer token\nOverall: FAIL\n"


def run(fn, argv, stdin=""):
    out, err = io.StringIO(), io.StringIO()
    fake = mock.Mock(buffer=io.BytesIO(stdin.encode()))
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err), mock.patch.object(sys, "stdin", fake):
        rc = fn(argv)
    return rc, out.getvalue(), err.getvalue()


def git(cwd, *a):
    r = subprocess.run(["git", "-C", str(cwd), "-c", "user.name=t", "-c", "user.email=t@example.com",
                        "-c", "commit.gpgsign=false"] + list(a), stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                       check=True)
    return r.stdout.decode().strip()


def fnd(i, model="m1", line=10, cls="auth", head="h1", run_id="r1", session="s1", primary=True, **kw):
    return dict({"type": "finding", "id": i, "session": session, "model": model, "rung": 0, "primary": primary,
                 "runId": run_id, "file": "a.py", "line": line, "class": cls, "head": head, "gate": "item",
                 "source": "live", "ts": "2026-01-01T00:00:00Z"}, **kw)


def rev(run_id, head, verdict, model="m1", primary=True, session="s1", **kw):
    return dict({"type": "review", "session": session, "model": model, "rung": 0, "primary": primary, "runId": run_id,
                 "head": head, "verdict": verdict, "gate": "item", "source": "live", "items": [1], "findings": 0,
                 "ts": "2026-01-01T00:00:10Z"}, **kw)


class Store(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="findings_store_"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.agent = self.tmp / "agent"
        self.files = self.tmp / "files.txt"
        self.files.write_text("app/client.py\n")

    def record(self, rid="r1", model="m1", primary="1", *extra, text=REPORT, agent=None):
        return run(ff.main, ["record", "--session", "s1", "--gate", "item", "--model", model, "--rung", "0",
                             "--primary", primary, "--role", "reviewer", "--run-id", rid, "--source", "live",
                             "--head", "abc", "--item", "1", "--secs", "12.5", "--files-from", str(self.files),
                             "--agent-dir", str(agent or self.agent)] + list(extra), text)

    def lines(self):
        p = self.agent / "pi-foreman" / "state" / "findings" / "s1.jsonl"
        return [json.loads(ln) for ln in p.read_text().splitlines()]

    def test_record_writes_review_and_finding_and_prints_json(self):
        rc, out, _e = self.record()
        self.assertEqual(rc, 0)
        res = json.loads(out)
        self.assertEqual([(f["file"], f["line"], f["class"]) for f in res["findings"]],
                         [("app/client.py", 38, "secret-log")])
        review, finding = self.lines()
        self.assertEqual((review["type"], review["findings"], review["items"], review["verdict"], review["secs"]),
                         ("review", 1, [1], "FAIL", 12.5))
        self.assertEqual((finding["id"], finding["file"], finding["head"], finding["primary"]),
                         (res["findings"][0]["id"], "app/client.py", "abc", True))
        self.record("r2", text="VERDICT: PASS\n1. PASS fine\n")
        self.assertEqual([r["type"] for r in self.lines()], ["review", "finding", "review"])

    def test_record_fail_soft_and_no_absolute_paths(self):
        blocker = self.tmp / "blocker"
        blocker.write_text("x")
        rc, out, err = self.record(agent=blocker / "sub")
        self.assertEqual(rc, 0)
        self.assertEqual(len(json.loads(out)["findings"]), 1)
        self.assertIn("record", err)
        self.assertIsNone(ff.safe_rel("../x.py"))
        self.assertIsNone(ff.safe_rel("/etc/x.py"))
        self.assertEqual(ff.safe_rel("./a\\b.py"), "a/b.py")

    def test_list_unique_only_model_and_dismiss(self):
        self.record("r1", "alpha")
        self.record("r2", "beta")
        self.record("r3", "beta", "0", text="VERDICT: FAIL\n1. FAIL app/client.py:60 ignores the error\n")
        rc, out, _e = run(ff.main, ["list", "--json", "--agent-dir", str(self.agent)])
        self.assertEqual(len(json.loads(out)), 3)
        _rc, out, _e = run(ff.main, ["list", "--json", "--unique", "--agent-dir", str(self.agent)])
        self.assertEqual([r["line"] for r in json.loads(out)], [60])
        _rc, out, _e = run(ff.main, ["list", "--json", "--only-model", "ALP", "--since", "7d", "--agent-dir",
                                     str(self.agent)])
        self.assertEqual([r["model"] for r in json.loads(out)], ["alpha"])
        fid = json.loads(run(ff.main, ["list", "--json", "--unique", "--agent-dir", str(self.agent)])[1])[0]["id"]
        rc, _o, _e = run(ff.main, ["dismiss", fid, "not a bug", "--agent-dir", str(self.agent)])
        self.assertEqual(rc, 0)
        self.assertEqual(self.lines()[-1]["type"], "dismiss")
        self.assertEqual(run(ff.main, ["dismiss", "nope", "x", "--agent-dir", str(self.agent)])[0], 1)


def make_repo(tmp):
    repo = tmp / "repo"
    repo.mkdir()
    git(repo, "init", "-q")
    (repo / "src").mkdir()
    base = "".join("line %d\n" % i for i in range(1, 61))
    (repo / "src" / "app.py").write_text(base)
    git(repo, "add", "src/app.py")
    git(repo, "commit", "-q", "-m", "base")
    c0 = git(repo, "rev-parse", "HEAD")
    changed = base.replace("line 20\n", "line 20 changed\n").replace("line 40\n", "line 40 changed\n").replace(
        "line 5\n", "line 5 changed\n")
    (repo / "src" / "app.py").write_text(changed)
    git(repo, "commit", "-q", "-am", "feature")
    return repo, c0, git(repo, "rev-parse", "HEAD")


class Export(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="findings_export_"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.agent = self.tmp / "agent"
        self.repo, self.c0, self.c1 = make_repo(self.tmp)
        ff._append_lines(str(self.agent / "pi-foreman" / "state" / "findings" / "s1.jsonl"), [
            rev("r1", self.c1, "FAIL", base=self.c0, items=[]),
            fnd("abc123abc123", head=self.c1, line=20, cls="auth", file="src/app.py", note="missing check"),
        ])

    def export(self, to):
        return run(ff.main, ["export", "abc123abc123", "--to", str(to), "--repo", str(self.repo),
                             "--agent-dir", str(self.agent)])

    def test_export_task_is_valid_and_skipped_until_confirmed(self):
        out = self.tmp / "out"
        rc, stdout, err = self.export(out)
        self.assertEqual((rc, err), (0, ""))
        task = Path(stdout.strip())
        self.assertEqual(rb.validate_task(task), [])
        self.assertEqual((task / "base" / "src" / "app.py").read_text().count("changed"), 0)
        self.assertIn("+line 20 changed", (task / "diff.patch").read_text())
        gt = json.loads((task / "ground_truth.json").read_text())
        self.assertEqual((gt["clean"], gt["defects"][0]["lines"], gt["defects"][0]["description"]),
                         (False, [17, 23], "missing check"))
        harvest = json.loads((task / "harvest.json").read_text())
        self.assertEqual((harvest["source"], harvest["confirmed"], harvest["findingId"]), ("harvest", False, "abc123abc123"))
        self.assertEqual([t.name for t in rb.find_tasks(out)], [task.name])
        self.assertTrue(rb.unconfirmed_harvest(task))
        harvest["confirmed"] = True
        (task / "harvest.json").write_text(json.dumps(harvest))
        self.assertFalse(rb.unconfirmed_harvest(task))
        self.assertFalse(rb.unconfirmed_harvest(self.tmp))

    def test_export_refuses_package_tree_repo_and_missing_to(self):
        for target in (ROOT / "scratch-out", self.repo / "out"):
            rc, _o, err = self.export(target)
            self.assertEqual(rc, 2, err)
            self.assertFalse(target.exists())
        self.assertEqual(run(ff.main, ["export", "abc123abc123", "--agent-dir", str(self.agent)])[0], 2)


class Outcomes(unittest.TestCase):
    def hunks(self, spans):
        return lambda a, b: spans.get((a, b))

    def test_accepted_rejected_late_open(self):
        f_acc, f_rej, f_open = fnd("acc", line=10), fnd("rej", line=50, run_id="r1"), fnd("opn", line=80, run_id="r1")
        recs = [rev("r1", "h1", "FAIL"), f_acc, f_rej, f_open, rev("r2", "h2", "FAIL"), rev("r3", "h3", "PASS")]
        out = ff.outcomes(recs, self.hunks({("h1", "h2"): {"a.py": [(12, 13)]}, ("h1", "h3"): {"a.py": [(12, 13)]}}))
        self.assertEqual({k[2]: v["outcome"] for k, v in out.items()},
                         {"acc": "accepted", "rej": "rejected", "opn": "rejected"})
        # without a diff accessor the untouched claim cannot be made
        out = ff.outcomes(recs, None)
        self.assertEqual({k[2]: v["outcome"] for k, v in out.items()}, {"acc": "open", "rej": "open", "opn": "open"})
        recs = [rev("r1", "h1", "FAIL"), fnd("d", line=10)]
        self.assertEqual(ff.outcomes(recs + [{"type": "dismiss", "id": "d", "session": "s1"}], None)[("s1", "m1", "d")]
                         ["outcome"], "rejected")

    def test_confirmed_late_attributes_the_primary_miss(self):
        recs = [rev("p1", "h1", "PASS", model="cheap"), rev("p2", "h2", "FAIL", model="strong", rung=1),
                fnd("late", model="strong", line=12, run_id="p2", head="h2")]
        o = ff.outcomes(recs, None)[("s1", "strong", "late")]
        self.assertEqual((o["outcome"], o["late"], o["miss"]), ("confirmed_late", True, ("cheap", 0)))
        recs.insert(1, fnd("had", model="cheap", line=14, run_id="p1", head="h1"))  # the PASS already listed it
        self.assertFalse(ff.outcomes(recs, None)[("s1", "strong", "late")]["late"])


class Models(unittest.TestCase):
    def test_table_usd_per_accepted_p90_and_time_to_clean(self):
        t0 = "2026-01-01T00:00:00Z"
        recs = [rev("r1", "h1", "FAIL", model="p/cheap", secs=10, startedTs=t0, ts="2026-01-01T00:00:10Z", findings=1),
                fnd("f1", model="p/cheap", run_id="r1", line=10),
                rev("r2", "h2", "PASS", model="p/cheap", secs=30, startedTs="2026-01-01T00:01:00Z",
                    ts="2026-01-01T00:01:30Z")]
        usage = [{"ts": "2026-01-01T00:00:05Z", "role": "reviewer", "provider": "p", "model": "cheap",
                  "cost": {"total": 0}, "input": 1000000, "output": 0, "cacheRead": 0, "cacheWrite": 0},
                 {"ts": "2026-01-01T00:00:06Z", "role": "builder", "provider": "p", "model": "cheap",
                  "cost": {"total": 9.0}},
                 {"ts": "2026-01-01T00:01:10Z", "role": "reviewer", "provider": "p", "model": "cheap",
                  "cost": {"total": 0.25}}]
        t = ff.models_table(recs, usage=lambda s: usage, rates={"p/cheap": {"input": 2.0}},
                            hunks=lambda a, b: {"a.py": [(11, 11)]})
        [row] = t["rows"]
        self.assertEqual((row["reviews"], row["findings"], row["accepted"], row["usd"], row["usdPerAccepted"]),
                         (2, 1, 1, 2.25, 2.25))
        self.assertEqual((row["medianSecs"], row["p90Secs"]), (20.0, 30))
        self.assertEqual((t["timeToClean"]["items"], t["timeToClean"]["medianSecs"]), (1, 90.0))
        self.assertEqual(ff.models_table(recs, source="panel")["rows"], [])

    def test_backlog_candidate_at_threshold(self):
        tmp = Path(tempfile.mkdtemp(prefix="findings_models_"))
        self.addCleanup(shutil.rmtree, tmp, True)
        repo, c0, c1 = make_repo(tmp)
        agent = tmp / "agent"
        recs = [rev("p1", c0, "FAIL")]
        for n in (5, 20, 40):
            recs.append(fnd("sh%d" % n, model="shadow", primary=False, run_id="s1", line=n, head=c0, file="src/app.py",
                            source="panel", cls="auth"))
        recs.append(rev("p2", c1, "PASS"))
        ff._append_lines(str(agent / "pi-foreman" / "state" / "findings" / "s1.jsonl"), recs)
        table = ff.models_table(ff.load_records(str(agent)), hunks=ff.git_hunks(str(repo)))
        self.assertEqual(table["shadows"]["shadow"]["uniqueAccepted"], 3)
        self.assertEqual(ff.shadow_candidates(table, 4), [])
        [cand] = ff.shadow_candidates(table, 3)
        self.assertEqual(cand["kind"], "review-model")
        rc, out, _e = run(fr.main, ["models", "--agent-dir", str(agent), "--cwd", str(repo), "--json"])
        self.assertEqual(rc, 0)
        self.assertEqual(json.loads(out)["shadows"]["shadow"]["uniqueAccepted"], 3)
        [entry] = fb.load(fb.store_path_for("review-model", workspace_root=str(repo), cfg={},
                                            agent_dir=str(agent))[0])
        self.assertEqual((entry["kind"], entry["candidate"]), ("review-model", cand["candidate"]))


if __name__ == "__main__":
    unittest.main()
