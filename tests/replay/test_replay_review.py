"""Model review of asks, link foreman-review (safety wave, ledger items 7-9, decision D3).

Run:  FOREMAN_REPLAY_CACHE=<dir> python -m unittest discover -s tests/replay -v
The reviewer is a fake model on the fake provider (`review-<kind>`, see fake_provider.ts) that
answers every review with a fixed verdict. The command `uname -s` hits the baseline `*: ask`.
Expected: allow -> no prompt; hard deny -> denied; everything else -> the human prompt.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from driver import DIALOGS, PROVIDER_A, PROVIDER_B, load_fixture, tool_results  # noqa: E402
from test_replay import REASON, ReplayCase  # noqa: E402

YES = [{"value": "Yes"}]


@unittest.skipIf(REASON is not None, "replay prerequisites missing: %s" % (REASON,))
class TestModelReview(ReplayCase):
    def review_rig(self, kind, timeout_ms=None):
        review = {"model": "%s/review-%s" % (PROVIDER_A, kind)}
        if timeout_ms:
            review["timeoutMs"] = timeout_ms
        return self.rig("review-" + kind, load_fixture("review"), providers=(PROVIDER_A, PROVIDER_B),
                        permissions="baseline", config={"providers": {PROVIDER_A: {"review": review}}})

    def ask(self, pi):
        """(dialog shown, [(isError, text)] of the bash call, review trace outcomes so far)."""
        recs = pi.prompt("[[replay:r1]] go", answers=list(YES), timeout=60)
        dialogs = [r for r in recs if r.get("type") == "extension_ui_request" and r.get("method") in DIALOGS]
        return bool(dialogs), [(e, t) for _, e, t in tool_results(recs, "bash")]

    def outcomes(self, rig):
        return [r.get("decision") for recs in rig.traces().values() for r in recs if r.get("event") == "review"]

    def run_path(self, kind, timeout_ms=None):
        rig = self.review_rig(kind, timeout_ms)
        pi = rig.start()
        dialog, bash = self.ask(pi)
        pi.close()
        return dialog, bash, self.outcomes(rig)

    def assert_prompted(self, kind, outcome, timeout_ms=None):
        dialog, bash, outcomes = self.run_path(kind, timeout_ms)
        self.assertTrue(dialog, "%s: no human prompt" % kind)
        self.assertEqual([e for e, _ in bash], [False], "%s: approved by the human, the command runs" % kind)
        self.assertEqual(outcomes, [outcome])

    def test_allow_runs_without_a_prompt(self):
        dialog, bash, outcomes = self.run_path("allow")
        self.assertFalse(dialog)
        self.assertEqual([e for e, _ in bash], [False])
        self.assertEqual(outcomes, ["allow"])

    def test_hard_deny_is_final(self):
        dialog, bash, outcomes = self.run_path("deny-high")
        self.assertFalse(dialog)
        self.assertEqual([e for e, _ in bash], [True])
        self.assertIn("foreman-review", bash[0][1])
        self.assertEqual(outcomes, ["deny"])

    def test_soft_deny_goes_to_the_human(self):
        self.assert_prompted("deny-low", "soft-deny")

    def test_unsure_goes_to_the_human(self):
        self.assert_prompted("defer", "defer")

    def test_provider_error_goes_to_the_human(self):
        self.assert_prompted("error", "error")

    def test_garbage_reply_goes_to_the_human(self):
        self.assert_prompted("garbage", "garbage")

    def test_empty_reply_goes_to_the_human(self):
        self.assert_prompted("empty", "empty")

    def test_timeout_goes_to_the_human(self):
        self.assert_prompted("hang", "timeout", timeout_ms=1500)

    def test_reviewer_follows_the_active_provider_without_restart(self):
        rig = self.review_rig("allow")
        pi = rig.start()
        self.assertFalse(self.ask(pi)[0])
        pi.request({"type": "set_model", "provider": PROVIDER_B, "modelId": "foreman"})
        dialog, bash = self.ask(pi)
        pi.close()
        self.assertTrue(dialog, "provider B sets no review model: its auto-picked role-map model answers nothing, the ask reaches the human")
        self.assertEqual([e for e, _ in bash], [False])
        self.assertEqual(self.outcomes(rig), ["allow", "empty"])


if __name__ == "__main__":
    unittest.main()
