import contextlib
import io
import json
import sys
import tempfile
import unittest
from argparse import Namespace
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / "bench"))
import foreman_bench as fb  # noqa: E402
import wait_session as ws  # noqa: E402

PRESET = {"bench": {"tasks_dir": "tasks", "repeats": 2},
          "rows": [{"id": "R1", "agent": "plain", "provider": "p", "model": "p/main"},
                   {"id": "R2", "agent": "foreman", "provider": "foreman-fake"}]}


def trial(reward=1.0, exc=None, infra=None, tokens=100, calls=3):
    bench = {"counters": {"tokens": {"total": tokens}, "tool_calls": calls, "approvals": 1, "guard_blocks": 0},
             "infra_error": infra, "pi_foreman_commit": "abc", "versions": {"pi": "1.0.0"}}
    return {"trial_name": "t", "verifier_result": None if reward is None else {"rewards": {"reward": reward}},
            "exception_info": {"exception_type": exc} if exc else None,
            "agent_result": {"metadata": {"bench": bench}},
            "agent_execution": {"started_at": "2026-10-04T06:00:00.000000Z", "finished_at": "2026-10-04T06:00:10.000000Z"}}


class BenchTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        for t in ("alpha", "beta"):
            (self.root / "tasks" / t).mkdir(parents=True)
            (self.root / "tasks" / t / "task.toml").write_text("")
        (self.root / "tasks" / "notes").mkdir()  # no task.toml: not a task
        self.preset = self.root / "preset.json"
        self.preset.write_text(json.dumps(PRESET))
        self.jobs = self.root / "jobs"

    def job(self, name, rec):
        d = self.jobs / name / "trial-1"
        d.mkdir(parents=True)
        (d / "result.json").write_text(json.dumps(rec))

    def args(self, **kw):
        base = dict(preset=str(self.preset), tasks=None, jobs_dir=str(self.jobs), rows=None, task=None, repeats=None,
                    harbor="harbor", dry_run=False)
        base.update(kw)
        return Namespace(**base)

    def test_command_and_env(self):
        cmd = fb.harbor_command(PRESET["rows"][1], Path("/t/alpha"), "/p.json", Path("/j"), "R2__alpha__r1__x")
        self.assertEqual(cmd[:6], ["harbor", "run", "-p", str(Path("/t/alpha")), "-a", "bench.harbor_agent:ForemanPi"])
        self.assertIn("foreman-fake/foreman", cmd)
        self.assertIn("row=R2", cmd)
        self.assertNotIn("--upload", cmd)
        self.assertNotIn("--launch", cmd)
        self.assertEqual(fb.harbor_env({"HARBOR_TELEMETRY": "on"})["HARBOR_TELEMETRY"], "off")

    def test_tasks_dir_from_config_or_flag(self):
        preset = fb.load_preset(self.preset)
        self.assertEqual(fb.tasks_dir(preset), (self.root / "tasks").resolve())
        self.assertEqual(fb.tasks_dir(preset, str(self.root)), self.root.resolve())
        self.assertEqual(len(fb.cells(preset, fb.tasks_dir(preset))), 2 * 2 * 2)

    def test_resume_skips_finished_and_reruns_infra(self):
        self.job("R1__alpha__r1__a", trial())
        self.job("R1__alpha__r2__a", trial(reward=None, exc="ApiOverloadedError"))
        calls = []

        def runner(cmd, env, cwd):
            calls.append(cmd[cmd.index("--job-name") + 1])
            self.job(calls[-1], trial(reward=0.0))

        with contextlib.redirect_stdout(io.StringIO()):
            rc = fb.run(self.args(rows=["R1"], task=["alpha"]), runner=runner)
        self.assertEqual(rc, 0)
        self.assertEqual(len(calls), 1)
        self.assertTrue(calls[0].startswith("R1__alpha__r2__"))
        self.assertEqual(fb.counted(fb.cell_results(self.jobs, "R1__alpha__r2"))["reward"], 0.0)

    def test_usage_limit_stops_run(self):
        calls = []

        def runner(cmd, env, cwd):
            calls.append(cmd[cmd.index("--job-name") + 1])
            self.job(calls[-1], trial(reward=None, exc="ApiUsageLimitError", infra="usage_limit"))

        with contextlib.redirect_stdout(io.StringIO()):
            rc = fb.run(self.args(), runner=runner)
        self.assertEqual(rc, fb.EXIT_USAGE_LIMIT)
        self.assertEqual(len(calls), 1)
        self.assertIsNone(fb.counted(fb.cell_results(self.jobs, calls[0].rsplit("__", 1)[0])))

    def test_table_median_range_and_infra(self):
        self.job("R2__beta__r1__a", trial(tokens=100, calls=2))
        self.job("R2__beta__r2__a", trial(reward=0.0, tokens=300, calls=4))
        self.job("R2__alpha__r1__a", trial(reward=None, exc="ApiUsageLimitError"))
        preset = fb.load_preset(self.preset)
        rows = {(r["row"], r["task"]): r for r in fb.table(preset, fb.tasks_dir(preset), self.jobs)}
        beta = rows[("R2", "beta")]
        self.assertEqual((beta["success"], beta["counted"]), (1, 2))
        self.assertEqual(beta["tokens"], {"median": 200, "min": 100, "max": 300})
        self.assertEqual(beta["wall_seconds"]["median"], 10.0)
        self.assertEqual(beta["meta"]["pi_foreman_commit"], "abc")
        self.assertEqual((rows[("R2", "alpha")]["counted"], rows[("R2", "alpha")]["infra_errors"]), (0, 1))
        self.assertIn("200 [100-300]", fb.format_table(list(rows.values())))

    def test_waiter_usage_limit_and_active_runs(self):
        err = {"message": {"role": "assistant", "stopReason": "error", "errorMessage": "Claude usage limit reached; resets at 5pm"}}
        self.assertTrue(ws.usage_limit_error(err))
        self.assertIsNone(ws.usage_limit_error({"message": {"role": "assistant", "stopReason": "stop", "errorMessage": "usage limit"}}))
        runs = self.root / "sub" / "async-subagent-runs"
        for name, state in (("a", "complete"), ("b", "running"), ("c", None)):
            (runs / name).mkdir(parents=True)
            if state:
                (runs / name / "status.json").write_text(json.dumps({"state": state}))
        (runs / ".active-runs").mkdir()
        self.assertEqual(sorted(r["runId"] for r in ws.active(ws.async_runs(self.root / "sub"))), ["b", "c"])


if __name__ == "__main__":
    unittest.main()
