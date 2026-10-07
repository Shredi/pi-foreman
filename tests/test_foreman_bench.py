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
import types  # noqa: E402
for _m, _n in (("harbor", None), ("harbor.agents", None), ("harbor.agents.installed", None), ("harbor.agents.installed.base", ("ApiUsageLimitError", "BaseInstalledAgent")),
               ("harbor.environments", None), ("harbor.environments.base", ("BaseEnvironment",)),
               ("harbor.models", None), ("harbor.models.agent", None), ("harbor.models.agent.context", ("AgentContext",))):
    if _m not in sys.modules:
        _mod = types.ModuleType(_m)
        for _a in _n or ():
            setattr(_mod, _a, type(_a, (object,), {}))
        sys.modules[_m] = _mod
sys.path.insert(0, str(ROOT))
from bench import harbor_agent as ha  # noqa: E402
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
                    harbor="harbor", dry_run=False, token_cap=None, setup_only=False)
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

    def write_preset(self, **bench):
        data = json.loads(json.dumps(PRESET))
        data["rows"].append({"id": "RS", "agent": "foreman", "provider": "foreman-fake"})
        data["bench"].update(bench)
        self.preset.write_text(json.dumps(data))
        return fb.load_preset(self.preset)

    def test_repeats_by_task_overrides_the_global_value(self):
        preset = self.write_preset(tasks=["alpha", "beta"], repeats=2, repeats_by_task={"beta": 3})
        ids = [(t, k) for _, t, k, _ in fb.cells(preset, fb.tasks_dir(preset))]
        self.assertEqual(sorted({k for t, k in ids if t == "alpha"}), [1, 2])
        self.assertEqual(sorted({k for t, k in ids if t == "beta"}), [1, 2, 3])
        self.assertEqual({k for t, k in [(t, k) for _, t, k, _ in fb.cells(preset, fb.tasks_dir(preset), repeats=1)]}, {1})

    def test_order_first_then_repeat_task_row(self):
        preset = self.write_preset(tasks=["beta", "alpha"], first={"row": "R2", "task": "alpha"})
        order = [fb.cell_id(r["id"], t, k) for r, t, k, _ in fb.cells(preset, fb.tasks_dir(preset))]
        self.assertEqual(order[:4], ["R2__alpha__r1", "R1__beta__r1", "R2__beta__r1", "RS__beta__r1"])
        self.assertEqual(order[4:7], ["R1__alpha__r1", "R2__alpha__r1", "RS__alpha__r1"])
        self.assertEqual(order[7], "R1__beta__r2")
        self.assertEqual(len(order), 1 + 3 * 2 * 2)
        self.assertEqual(fb.first_summary(preset, fb.tasks_dir(preset), self.jobs)["finished"], False)
        with self.assertRaises(SystemExit):
            fb.cells(self.write_preset(tasks=["gamma"]), self.root / "tasks")

    def test_token_cap_stops_before_next_cell(self):
        self.write_preset(token_cap=250)
        calls = []

        def runner(cmd, env, cwd):
            calls.append(cmd[cmd.index("--job-name") + 1])
            self.job(calls[-1], trial(tokens=100))

        with contextlib.redirect_stdout(io.StringIO()) as out:
            rc = fb.run(self.args(), runner=runner)
        self.assertEqual(rc, fb.EXIT_TOKEN_CAP)
        self.assertEqual(len(calls), 3)  # 100, 200 < 250 -> run; 300 >= 250 -> stop
        self.assertIn("token cap reached (300 of 250", out.getvalue())
        with contextlib.redirect_stdout(io.StringIO()):  # resume: finished cells still count; flag overrides
            self.assertEqual(fb.run(self.args(token_cap=300), runner=runner), fb.EXIT_TOKEN_CAP)
            self.assertEqual(fb.run(self.args(token_cap=10 ** 9, rows=["R1"]), runner=runner), 0)
        self.assertEqual(len(calls), 3 + 3)  # R1 alpha r1 was done; beta r1, alpha r2, beta r2 ran

    def test_two_consecutive_infra_cells_stop(self):
        outcomes = iter([trial(reward=None, exc="AgentAuthenticationError"), trial(), None,
                         trial(reward=None, exc="ApiOverloadedError")])
        calls = []

        def runner(cmd, env, cwd):
            calls.append(cmd[cmd.index("--job-name") + 1])
            rec = next(outcomes)
            if rec is not None:  # None: the job left no trial result
                self.job(calls[-1], rec)

        with contextlib.redirect_stdout(io.StringIO()) as out:
            rc = fb.run(self.args(), runner=runner)
        self.assertEqual(rc, fb.EXIT_INFRA_STREAK)
        self.assertEqual(len(calls), 4)  # infra, ok (resets), no result, infra -> stop
        self.assertIn("2 consecutive infrastructure-error cells", out.getvalue())

    def rpc(self, name, assistant):
        """rpc.jsonl shaped like the waiter's log of a real cell (made-up content)."""
        d = self.jobs / name / "trial-1" / "agent"
        d.mkdir(parents=True, exist_ok=True)
        recs = [{"type": "response", "id": "bench-prompt", "command": "prompt", "success": True}, {"type": "agent_start"},
                {"type": "turn_start"},
                {"type": "message_start", "message": {"role": "user", "content": [{"type": "text", "text": "task"}],
                                                      "timestamp": 1}},
                {"type": "message_end", "message": {"role": "user", "content": [{"type": "text", "text": "task"}],
                                                    "timestamp": 1}}]
        if assistant:
            recs += [{"type": t, "message": dict(assistant, role="assistant", timestamp=2)}
                     for t in ("message_start", "message_end", "turn_end")]
        recs += [{"type": "agent_end", "messages": []}, {"type": "agent_settled"}]
        (d / "rpc.jsonl").write_text("".join(json.dumps(r) + "\n" for r in recs))

    def test_failed_first_turn_and_zero_tokens_are_infra_and_stop(self):
        bridge_err = {"content": [], "provider": "claude-bridge", "model": "claude-x", "stopReason": "error",
                      "errorMessage": "Claude Code process exited with code 1. stderr: refused",
                      "usage": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 0}}
        ok = {"content": [{"type": "text", "text": "done"}], "stopReason": "stop", "usage": {"input": 10, "output": 5}}
        self.job("R1__alpha__r1__a", trial(reward=0.0, tokens=0))
        self.rpc("R1__alpha__r1__a", bridge_err)
        self.job("R1__alpha__r2__a", trial(reward=0.0, tokens=15))
        self.rpc("R1__alpha__r2__a", None)
        self.job("R1__beta__r1__a", trial(reward=0.0, tokens=0))  # no rpc.jsonl: zero tokens alone
        self.job("R1__beta__r2__a", trial(reward=0.0, tokens=15))
        self.rpc("R1__beta__r2__a", ok)
        infra = {c: fb.cell_results(self.jobs, c)[0]["infra"] for c in
                 ("R1__alpha__r1", "R1__alpha__r2", "R1__beta__r1", "R1__beta__r2")}
        self.assertEqual(infra, {"R1__alpha__r1": "assistant_error", "R1__alpha__r2": "no_model_turn",
                                 "R1__beta__r1": "zero_tokens", "R1__beta__r2": None})
        calls = []

        def runner(cmd, env, cwd):
            calls.append(cmd[cmd.index("--job-name") + 1])
            self.job(calls[-1], trial(reward=0.0, tokens=0))
            self.rpc(calls[-1], bridge_err)

        with contextlib.redirect_stdout(io.StringIO()) as out:
            rc = fb.run(self.args(rows=["R2"]), runner=runner)
        self.assertEqual(rc, fb.EXIT_INFRA_STREAK)
        self.assertEqual(len(calls), 2)
        self.assertIn("assistant_error", out.getvalue())

    def test_signal_interrupts_cell_and_resume_reruns_it(self):
        calls = []
        clock = iter(range(1000, 2000, 10))

        def runner(cmd, env, cwd):
            calls.append(cmd[cmd.index("--job-name") + 1])
            if len(calls) == 2:
                fb._on_signal(fb.signal.SIGINT, None)  # owner stops the run mid-cell (no child: nothing to forward)
            self.job(calls[-1], trial(reward=1.0))

        with contextlib.redirect_stdout(io.StringIO()) as out:
            rc = fb.run(self.args(rows=["R1"]), runner=runner, now=lambda: next(clock))
        self.assertEqual(rc, fb.EXIT_INTERRUPTED)
        self.assertEqual(len(calls), 2)
        self.assertIn("interrupted", out.getvalue())
        self.assertIn("Resume with the same `run` command", out.getvalue())
        interrupted = calls[1].rsplit("__", 1)[0]
        self.assertTrue((self.jobs / calls[1] / fb.INTERRUPTED_MARK).is_file())
        self.assertIsNone(fb.counted(fb.cell_results(self.jobs, interrupted)))
        with contextlib.redirect_stdout(io.StringIO()):  # resume: the interrupted cell runs again
            self.assertEqual(fb.run(self.args(rows=["R1"]), runner=runner, now=lambda: next(clock)), 0)
        self.assertTrue(calls[2].startswith(interrupted + "__"))

    def test_row_summary_per_tier_and_first_cell_roles(self):
        preset = self.write_preset(first={"row": "R2", "task": "alpha"})

        def rec(reward, opus, sonnet):
            r = trial(reward=reward, tokens=opus + sonnet)
            r["agent_result"]["metadata"]["bench"]["counters"].update(
                tokens_by_model={"b/claude-opus-5-5": {"input": opus, "output": 0},
                                 "b/claude-sonnet-5-5": {"input": sonnet, "output": 0}},
                tokens_by_role={"foreman": {"total": opus}, "builder": {"total": sonnet}})
            return r

        self.job("R2__alpha__r1__a", rec(1.0, 1000, 50))  # the first cell, excluded from the row summary
        self.job("R2__beta__r1__a", rec(1.0, 100, 10))
        self.job("R2__beta__r2__a", rec(0.0, 300, 30))
        tdir = fb.tasks_dir(preset)
        r2 = {r["row"]: r for r in fb.row_summary(preset, tdir, self.jobs)}["R2"]
        self.assertEqual((r2["success"], r2["counted"]), (1, 2))
        self.assertEqual(r2["tokens_by_tier"]["opus"], {"median": 200, "min": 100, "max": 300})
        self.assertEqual(r2["tokens_by_tier"]["sonnet"], {"median": 20, "min": 10, "max": 30})
        first = fb.first_summary(preset, tdir, self.jobs)
        self.assertEqual((first["cell"], first["reward"]), ("R2__alpha__r1", 1.0))
        self.assertEqual(first["tokens_by_role"]["foreman"]["total"], 1000)
        text = fb.format_summary(fb.row_summary(preset, tdir, self.jobs), first)
        self.assertIn("tokens opus", text)
        self.assertIn("200 [100-300]", text)
        self.assertEqual(fb.tier("claude-bridge/claude-fable-5-1"), "fable")
        self.assertEqual(fb.tier("foreman-fake/builder"), "builder")

    def test_cost_view_list_prices_and_warm_share(self):
        preset = self.write_preset()

        def rec(opus, fable, other=None):
            r = trial()
            tbm = {"b/claude-opus-5-5": opus, "b/claude-fable-5-1": fable}
            tbm.update(other or {})
            r["agent_result"]["metadata"]["bench"]["counters"]["tokens_by_model"] = tbm
            return r

        # opus: 1M in, 1M out, 2M read, 1M write -> 4 + 20 + 0.40 + 5 = 29.40 (1h write: 32.40)
        # fable: 1M read only -> 0.25
        self.job("R2__beta__r1__a", rec({"input": 10**6, "output": 10**6, "cacheRead": 2 * 10**6, "cacheWrite": 10**6},
                                        {"cacheRead": 10**6}))
        self.job("R2__beta__r2__a", rec({"cacheWrite": 10**6}, {}, {"b/mystery-1": {"input": 5}}))
        tdir = fb.tasks_dir(preset)
        prices = fb.load_prices()
        self.assertEqual(prices["retrieved"], "2026-10-04")
        c = fb.cost_of(fb.counted(fb.cell_results(self.jobs, "R2__beta__r1")), prices)
        self.assertAlmostEqual(c["usd"], 29.65)
        self.assertAlmostEqual(c["usd_1h"], 32.65)
        self.assertAlmostEqual(c["by_tier"]["opus"], 29.40)
        self.assertAlmostEqual(c["by_tier"]["fable"], 0.25)
        self.assertAlmostEqual(c["read_usd"], 0.65)
        rows = {(r["row"], r["task"]): r for r in fb.table(preset, tdir, self.jobs, prices)}
        cell = rows[("R2", "beta")]["cost"]
        self.assertAlmostEqual(cell["usd"]["max"], 29.65)
        self.assertAlmostEqual(cell["usd"]["min"], 5.0)
        self.assertEqual(cell["warm_share_tokens"]["max"], 0.75)  # 3M read / (3M read + 1M write)
        self.assertEqual(cell["warm_share_tokens"]["min"], 0.0)
        self.assertEqual(cell["unpriced"], ["mystery-1"])
        row = fb.row_summary(preset, tdir, self.jobs, prices)[1]
        self.assertEqual(row["row"], "R2")
        self.assertAlmostEqual(row["cost"]["by_tier"]["fable"]["max"], 0.25)
        self.assertNotIn("cost", fb.table(preset, tdir, self.jobs)[0])  # off unless prices are passed
        text = fb.format_cost(fb.row_summary(preset, tdir, self.jobs, prices), list(rows.values()), prices)
        self.assertIn("list-price equivalent (runs go through the subscription)", text)
        self.assertIn("5-minute rate", text)
        self.assertIn("Not priced", text)
        with contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(fb.main(["table", "--preset", str(self.preset), "--jobs-dir", str(self.jobs), "--cost"]), 0)
        self.assertIn("usd opus", out.getvalue())
        with contextlib.redirect_stdout(io.StringIO()) as out:
            fb.main(["table", "--preset", str(self.preset), "--jobs-dir", str(self.jobs)])
        self.assertNotIn("list-price", out.getvalue())

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


    # ---- P3: infra shape, usage log, triage evidence ----
    def logs(self, **files):
        self.nlogs = getattr(self, "nlogs", 0) + 1
        d = self.root / ("agentlogs%d" % self.nlogs)
        for rel, lines in files.items():
            f = d / rel.replace("__", "/")
            f.parent.mkdir(parents=True, exist_ok=True)
            f.write_text("\n".join(json.dumps(x) for x in lines) + "\n")
        return d

    def test_cap_seconds_by_task_in_command(self):
        row = PRESET["rows"][1]
        cmd = fb.harbor_command(row, Path("/t/alpha"), "/p.json", Path("/j"), "x", cap_by_task={"alpha": 2400})
        self.assertEqual(cmd[cmd.index("cap_seconds=2400") - 1], "--ak")
        self.assertFalse([c for c in fb.harbor_command(row, Path("/t/beta"), "/p.json", Path("/j"), "x",
                                                        cap_by_task={"alpha": 2400}) if c.startswith("cap_seconds")])

    def test_infra_flag_shape_and_refusal_classification(self):
        err = lambda text: {"type": "message_end", "message": {"role": "assistant", "stopReason": "error", "errorMessage": text}}  # noqa: E731
        ok = {"type": "message_end", "message": {"role": "assistant", "stopReason": "stop", "content": []}}
        clean = ha.classify_infra(self.logs(**{"rpc.jsonl": [ok]}), {}, 10)
        self.assertEqual(clean, {"flag": False, "reason": None, "detail": ""})
        # a refusal after a good first turn is still infra, even though the waiter missed it
        r = ha.classify_infra(self.logs(**{"rpc.jsonl": [ok, err("Safeguards flagged this message")]}), {}, 10)
        self.assertEqual((r["flag"], r["reason"]), (True, "provider_refusal"))
        self.assertIn("Safeguards", r["detail"])
        # the same text on a non-error message is not a refusal
        text = {"type": "message_end", "message": {"role": "assistant", "stopReason": "stop", "content": "flagged this message"}}
        self.assertFalse(ha.classify_infra(self.logs(**{"rpc.jsonl": [text]}), {}, 10)["flag"])
        self.assertEqual(ha.classify_infra(self.logs(**{"rpc.jsonl": [err("boom")]}), {}, 10)["reason"], "assistant_error")
        self.assertEqual(ha.classify_infra(self.logs(), {"infra_error": "usage_limit", "error": "x"}, 0)["reason"], "usage_limit")
        self.assertEqual(ha.classify_infra(self.logs(), {}, 0)["reason"], "zero_tokens")

    def infra_trial(self, reason, detail="d"):
        rec = trial(reward=None)
        rec["agent_result"]["metadata"]["bench"]["infra"] = {"flag": True, "reason": reason, "detail": detail}
        return rec

    def test_refusal_cell_is_rerun_and_listed_without_stopping(self):
        self.job("R1__alpha__r1__a", self.infra_trial("provider_refusal", "x" * 200))
        self.job("R1__alpha__r2__a", trial())
        self.assertEqual(fb.cell_results(self.jobs, "R1__alpha__r1")[0]["infra"], "provider_refusal")
        text = fb.format_infra(fb.infra_cells(fb.load_preset(self.preset), self.root / "tasks", self.jobs))
        self.assertIn("provider_refusal", text)
        self.assertIn("x" * 80, text)
        self.assertNotIn("x" * 81, text)
        calls = []

        def runner(cmd, env, cwd):
            calls.append(cmd[cmd.index("--job-name") + 1])
            self.job(calls[-1], self.infra_trial("provider_refusal") if len(calls) == 1 else trial())

        with contextlib.redirect_stdout(io.StringIO()):
            rc = fb.run(self.args(rows=["R1"], task=["alpha"]), runner=runner)
        self.assertEqual(rc, 0)  # refusal does not stop the run
        self.assertEqual(len(calls), 1)
        self.assertTrue(calls[0].startswith("R1__alpha__r1__"))

    def test_table_lists_infra_cells_and_new_columns(self):
        self.job("R2__beta__r1__a", self.infra_trial("zero_tokens", "none"))
        self.job("R2__beta__r2__a", trial())
        preset = fb.load_preset(self.preset)
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            fb.main(["table", "--preset", str(self.preset), "--jobs-dir", str(self.jobs)])
        text = out.getvalue()
        self.assertIn("Infra cells", text)
        self.assertIn("R2__beta__r1  zero_tokens  none", text)
        self.assertIn("guard blocks  tier  launches  revisions  asks_denied  gate_blocks", text)
        rows = fb.table(preset, fb.tasks_dir(preset), self.jobs)
        self.assertEqual([r for r in rows if r["row"] == "R2" and r["task"] == "beta"][0]["counted"], 1)

    def test_usage_log_parse_and_delta(self):
        line = lambda role, model, i: {"role": role, "model": model, "input": i, "cacheRead": 10, "cacheWrite": 1, "output": 2}  # noqa: E731
        d = self.logs(**{"state__usage__s1.jsonl": [line("foreman", "m1", 5), line("child", "m1", 5), line("builder", "m2", 1)]})
        c = ha.summarize_logs(d)
        self.assertEqual(c["usage_by_role_model"]["child"]["m1"], {"input": 5, "cacheRead": 10, "cacheWrite": 1, "output": 2, "n": 1})
        self.assertEqual(c["usage_log_delta"], 3 * 13 + 11 - 0)
        rec = trial()
        rec["agent_result"]["metadata"]["bench"]["counters"] = c
        self.job("R2__beta__r1__a", rec)
        self.assertEqual(fb.cell_results(self.jobs, "R2__beta__r1")[0]["usage_by_role_model"]["builder"]["m2"]["n"], 1)

    def test_cost_per_role_block(self):
        r = trial()
        r["agent_result"]["metadata"]["bench"]["counters"].update(
            tokens_by_model={"b/claude-opus-5-5": {"input": 10**6, "cacheRead": 0, "cacheWrite": 0, "output": 0}},
            usage_by_role_model={"builder": {"claude-opus-5-5": {"input": 10**6, "cacheRead": 0, "cacheWrite": 0, "output": 0, "n": 1}},
                                 "child": {"mystery": {"input": 1, "cacheRead": 0, "cacheWrite": 0, "output": 0, "n": 1}}})
        self.job("R2__beta__r1__a", r)
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            fb.main(["table", "--preset", str(self.preset), "--jobs-dir", str(self.jobs), "--cost"])
        self.assertIn("cost per role", out.getvalue())
        self.assertIn("$4.00", out.getvalue())
        self.assertIn("mystery", out.getvalue())

    def test_triage_counters_from_trace(self):
        ev = lambda **k: k  # noqa: E731
        d = self.logs(**{"state__trace-s1.jsonl": [
            ev(event="tier", tier="light"), ev(event="triage", tier="standard", decision="refused"),
            ev(event="triage", tier="deep", decision="recorded"), ev(event="role_launch", role="explorer"),
            ev(event="role_launch", role="explorer"), ev(event="role_launch", role="builder"),
            ev(event="revision", role="builder", decision="revision"), ev(event="revision", role="builder", decision="strong-relaunch"),
            ev(event="revision", role="builder", decision="blocked"), ev(event="triage_gate", decision="blocked"),
            ev(event="review", decision="allow"), ev(event="review", decision="allow"), ev(event="review", decision="deny")]})
        t = ha.summarize_logs(d)["triage"]
        self.assertEqual((t["tier"], t["revisions"], t["gate_blocks"]), ("deep", 2, 1))
        self.assertEqual(t["launches"], {"explorer": 2, "builder": 1})
        self.assertEqual(t["asks_reviewed"], {"allow": 2, "deny": 1})
        self.assertEqual(ha.summarize_logs(self.logs(**{"state__trace-s2.jsonl": [ev(event="ask")]}))["triage"]["tier"], "untriaged")
        rec = trial()
        rec["agent_result"]["metadata"]["bench"].update(counters=dict(ha.summarize_logs(d), tokens={"total": 100}), asks_denied=[{"method": "confirm"}])
        self.job("R2__beta__r1__a", rec)
        row = [r for r in fb.table(fb.load_preset(self.preset), self.root / "tasks", self.jobs) if r["row"] == "R2" and r["task"] == "beta"][0]
        self.assertEqual((row["tier"], row["launches"]["median"], row["asks_denied"]["median"]), ("deep", 3, 1))

    def test_poll_bash_and_ceremony_incomplete_from_trace(self):
        d = self.logs(**{"state__trace-s1.jsonl": [
            {"event": "role_result", "role": "builder", "pollBash": 2}, {"event": "turn", "pollBash": 3},
            {"event": "ceremony_incomplete", "missing": "review"}, {"event": "ceremony_incomplete", "missing": "tests"}]})
        t = ha.summarize_logs(d)["triage"]
        self.assertEqual((t["pollBash"], t["ceremony_incomplete"]), (5, 2))

    def test_2a_style_job_without_new_files_still_tabulates(self):
        self.job("R2__beta__r1__a", trial())
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(fb.main(["table", "--preset", str(self.preset), "--jobs-dir", str(self.jobs), "--cost"]), 0)
        self.assertNotIn("Infra cells", out.getvalue())


    def test_old_job_dir_with_refusal_in_logs_is_infra(self):
        d = self.jobs / "R1__alpha__r1__a"
        self.job("R1__alpha__r1__a", trial())
        agent = d / "trial-1" / "agent"
        agent.mkdir()
        (agent / "rpc.jsonl").write_text("\n".join(json.dumps(x) for x in (
            {"type": "message_end", "message": {"role": "assistant", "stopReason": "stop", "content": []}},
            {"type": "message_end", "message": {"role": "assistant", "stopReason": "error",
                                                "errorMessage": "Safeguards flagged this message"}})) + "\n")
        self.assertEqual(fb.cell_results(self.jobs, "R1__alpha__r1")[0]["infra"], "provider_refusal")

    def test_per_row_summary_has_triage_columns(self):
        rec = trial()
        rec["agent_result"]["metadata"]["bench"]["counters"]["triage"] = {
            "tier": "deep", "launches": {"builder": 2}, "revisions": 1, "gate_blocks": 0, "asks_reviewed": {}}
        self.job("R2__beta__r1__a", rec)
        preset = fb.load_preset(self.preset)
        summ = fb.row_summary(preset, fb.tasks_dir(preset), self.jobs)
        text = fb.format_summary(summ)
        self.assertIn("guard blocks  tier  launches  revisions  asks_denied  gate_blocks", text)
        self.assertEqual([r for r in summ if r["row"] == "R2"][0]["tier"], "deep")


if __name__ == "__main__":
    unittest.main()
