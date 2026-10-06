"""Replay: review flow (plan D3, D4, D5, D10) on the fake provider.

Triage gate: untriaged (edit refused, .workflow write ok), trivial (foreman_triage, then edit ok),
standard (edit refused, builder launch ok), heavy (edit refused, builder on the strong model).
Revision rounds: a builder -> reviewer (FAIL) -> builder chain driven by the children's
completion notices (a child's output carries the foreman's next replay tag); standard refuses
the 2nd revision, heavy the 3rd; a user prompt starts the count again. strongOnRevision on puts
the revision builder on the strong model with launch kind `strong-relaunch` in the usage log,
off keeps the default model and kind `revision`. The reviewer's own `edit` is refused (H4).
Same prerequisites and skips as test_replay.py.
"""
from __future__ import annotations

import json
import sys
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from driver import PROVIDER_A, load_fixture, tool_results  # noqa: E402
from test_replay import REASON, ReplayCase  # noqa: E402

STRONG = {"providers": {PROVIDER_A: {"roles": {"builder": {"strong": {"model": "%s/finalizer" % PROVIDER_A}}}}}}


def strong_config(on):
    cfg = json.loads(json.dumps(STRONG))
    cfg["providers"][PROVIDER_A]["strongOnRevision"] = on
    return cfg


def blocked_launch(pi, timeout=180):
    """Collect RPC records until a refused subagent call and the run after it settles."""
    deadline = time.time() + timeout
    out, hit = [], None
    while True:
        rec = pi._next(deadline)
        out.append(rec)
        if rec.get("type") == "tool_execution_end" and rec.get("toolName") == "subagent" and rec.get("isError"):
            hit = rec
        if hit is not None and rec.get("type") == "agent_settled":
            return out


def usage(rig, sid):
    safe = "".join(c for c in sid if c.isalnum() or c in "-_")
    f = rig.state_dir / "usage" / (safe + ".jsonl")
    return [json.loads(x) for x in f.read_text("utf-8").splitlines() if x.strip()] if f.is_file() else []


def events(rig, sid, name):
    safe = "".join(c for c in sid if c.isalnum() or c in "-_")
    return [r for r in rig.traces().get("trace-" + safe, []) if r.get("event") == name]


@unittest.skipIf(REASON is not None, "replay prerequisites missing: %s" % REASON)
class TestTriageGate(ReplayCase):
    def test_untriaged_trivial_standard_heavy(self):
        rig = self.rig("triage", load_fixture("review_flow"), config=STRONG)
        a_txt = rig.project / "a.txt"
        a_txt.write_text("alpha\n", "utf-8")

        pi = rig.start()
        res = tool_results(pi.prompt("[[replay:t0]] fix the typo", timeout=60))
        self.assertEqual([(n, e) for n, e, _ in res], [("edit", True), ("write", False)], res)
        self.assertIn("no tier recorded yet", res[0][2])
        self.assertIn("Call foreman_triage", res[0][2])
        self.assertEqual(a_txt.read_text("utf-8"), "alpha\n")
        self.assertTrue((rig.project / ".workflow" / "notes.md").is_file())
        pi.close()

        pi = rig.start()
        res = tool_results(pi.prompt("[[replay:t1]] fix the typo", timeout=60))
        self.assertEqual([(n, e) for n, e, _ in res], [("foreman_triage", False), ("edit", False)], res)
        self.assertIn("triaged by the foreman", res[0][2])
        self.assertEqual(a_txt.read_text("utf-8"), "beta\n")
        pi.close()
        a_txt.write_text("alpha\n", "utf-8")

        for tag, tier in (("t2", "standard"), ("t3", "heavy")):
            pi = rig.start()
            sid = pi.session_id()
            res = tool_results(pi.prompt("[[replay:%s]] build it" % tag, timeout=60))
            self.assertEqual([(n, e) for n, e, _ in res], [("foreman_triage", False), ("edit", True), ("write", False), ("subagent", False)], res)
            self.assertIn("the tier is %s" % tier, res[1][2])
            self.assertIn("Launch a builder", res[1][2])
            self.assertEqual(a_txt.read_text("utf-8"), "alpha\n")
            pi.wait_child_notify(timeout=120)
            pi.close()
            [b] = [x for x in usage(rig, sid) if x["role"] == "builder"]
            self.assertEqual(b["model"], "finalizer" if tier == "heavy" else "builder", b)
            self.assertEqual(b["kind"], "first")
            gate = [(r["toolFamily"], r["tier"], r["decision"]) for r in events(rig, sid, "triage_gate")]
            self.assertEqual(gate, [("edit", tier, "blocked")])


@unittest.skipIf(REASON is not None, "replay prerequisites missing: %s" % REASON)
class TestRevisionRounds(ReplayCase):
    def chain(self, name, start, config, limit_text):
        rig = self.rig(name, load_fixture("review_flow"), config=config)
        (rig.project / "a.txt").write_text("alpha\n", "utf-8")
        pi = rig.start()
        sid = pi.session_id()
        pi.prompt("[[replay:%s]] build it" % start, timeout=60)
        recs = blocked_launch(pi)
        refused = [t for n, e, t in tool_results(recs, "subagent") if e]
        self.assertEqual(len(refused), 1, tool_results(recs))
        self.assertIn(limit_text, refused[0])
        self.assertIn("Report the open findings to the owner", refused[0])
        return rig, pi, sid

    def test_standard_second_revision_refused_then_user_prompt_resets(self):
        rig, pi, sid = self.chain("rounds-std", "s1", None, "revision limit for standard reached (1)")
        res = tool_results(pi.prompt("[[replay:s6]] go on", timeout=60), "subagent")
        self.assertEqual([e for _, e, _ in res], [False], res)
        pi.close()
        self.assertEqual((rig.project / "a.txt").read_text("utf-8"), "alpha\n", "the reviewer's edit must not land")
        transcripts = [p.read_text("utf-8", "replace") for p in rig.agent.rglob("*_reviewer_transcript.jsonl")]
        self.assertTrue(any("Tool edit not found" in t for t in transcripts), "the reviewer has no edit tool (H4)")
        rev = [(r["decision"], r["tier"]) for r in events(rig, sid, "revision")]
        self.assertEqual(rev, [("revision", "standard"), ("blocked", "standard")])
        done = [(r["role"], r["decision"]) for r in events(rig, sid, "review_done")]
        self.assertEqual(done, [("reviewer", "fail"), ("reviewer", "fail")])

    def test_heavy_third_revision_refused(self):
        rig, pi, sid = self.chain("rounds-heavy", "h1", None, "revision limit for heavy reached (2)")
        pi.close()
        rev = [r["decision"] for r in events(rig, sid, "revision")]
        self.assertEqual(rev, ["revision", "revision", "blocked"])

    def test_strong_on_revision(self):
        for on in (True, False):
            rig, pi, sid = self.chain("rounds-strong-%s" % on, "s1", strong_config(on), "revision limit for standard reached (1)")
            pi.close()
            builders = [(x["kind"], x["model"]) for x in usage(rig, sid) if x["role"] == "builder"]
            want = [("first", "builder"), ("strong-relaunch", "finalizer")] if on else [("first", "builder"), ("revision", "builder")]
            self.assertEqual(builders, want)


if __name__ == "__main__":
    unittest.main()
