"""The judge on the judge-first list (PR C; docs/permissions.md).

Run:  python -m unittest discover -s tests/replay -v
The judge model is a fake model on the fake provider (`review-<kind>`, see fake_provider.ts) that answers every request with
a fixed verdict. The command `git branch -D old-topic || true` is judge-first (`danger-git`); a routine command never reaches the judge.
Expected (docs/permissions.md "Who decides", plan D1): clear -> no prompt and the call runs; unsure, a provider error, an invalid verdict, a timeout -> a refusal with the
reason and no prompt; an owner verdict with a class -> the owner dialog (the call runs once the owner allows it).
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import json

from driver import DIALOGS, PROVIDER_A, PROVIDER_B, load_fixture, tool_results
from test_replay import REASON, ReplayCase

YES = [{"value": "allow once"}, {"value": "Yes"}]  # the gate dialog; then the permission package's own ask (it leaves with phase B)


@unittest.skipIf(REASON is not None, "replay prerequisites missing: %s" % (REASON,))
class TestModelReview(ReplayCase):
    def review_rig(self, kind, timeout_ms=None, b_without_review=False):
        review = {"model": "%s/review-%s" % (PROVIDER_A, kind)}
        if timeout_ms:
            review["timeoutMs"] = timeout_ms
        providers = {PROVIDER_A: {"review": review}}
        if b_without_review:
            providers[PROVIDER_B] = {"review": {"model": None}}  # provider_map gives every provider a review model; this one has none
        rig = self.rig("review-" + kind, load_fixture("review"), providers=(PROVIDER_A, PROVIDER_B),
                       config={"providers": providers})
        return rig

    def ask(self, pi, tag="r1"):
        """(dialog shown, [(isError, text)] of the bash call)."""
        recs = pi.prompt("[[replay:%s]] go" % tag, answers=list(YES), timeout=60)
        dialogs = [r for r in recs if r.get("type") == "extension_ui_request" and r.get("method") in DIALOGS]
        return bool(dialogs), [(e, t) for _, e, t in tool_results(recs, "bash")]

    def outcomes(self, rig):
        return [r.get("decision") for recs in rig.traces().values() for r in recs if r.get("event") == "review"]

    def causes(self, rig):
        """The judge's gate-log records as (verdict, rule): a non-clear's rule is `judge:<cause>` (model, provider_error, invalid_verdict, timeout ...)."""
        log = rig.state_dir / "gate" / "log.jsonl"
        lines = [json.loads(x) for x in log.read_text("utf-8").splitlines() if x.strip()]
        return [(r.get("verdict"), r.get("rule")) for r in lines if r.get("layer") == "classifier"]

    def run_path(self, kind, timeout_ms=None):
        rig = self.review_rig(kind, timeout_ms)
        pi = rig.start()
        dialog, bash = self.ask(pi)
        pi.close()
        return dialog, bash, self.outcomes(rig), self.causes(rig)

    def assert_prompted(self, kind, cause, timeout_ms=None):
        dialog, bash, outcomes, causes = self.run_path(kind, timeout_ms)
        self.assertTrue(dialog, "%s: no human prompt" % kind)
        self.assertEqual([e for e, _ in bash], [False], "%s: approved by the human, the command runs: %s" % (kind, bash))
        self.assertEqual(outcomes, ["escalate"])
        self.assertEqual(causes, [("ask", "judge:" + cause)])

    def assert_refused(self, kind, cause, timeout_ms=None):
        dialog, bash, outcomes, causes = self.run_path(kind, timeout_ms)
        self.assertFalse(dialog, "%s: a judge that is no clear and no owner refuses, nobody is asked" % kind)
        self.assertEqual([e for e, _ in bash], [True], "%s: the call is refused: %s" % (kind, bash))
        self.assertTrue(bash[0][1].startswith("pi-foreman: refused:"), bash)
        self.assertEqual(outcomes, ["escalate"])
        self.assertEqual(causes, [("deny", "judge:" + cause)])

    def test_clear_runs_without_a_prompt(self):
        dialog, bash, outcomes, causes = self.run_path("allow")
        self.assertFalse(dialog)
        self.assertEqual([e for e, _ in bash], [False])
        self.assertEqual(outcomes, ["allow"])
        self.assertEqual(causes, [("allow", "judge")])

    def test_owner_verdict_goes_to_the_human(self):
        # plan D1 / Who decides: only a judge answer `owner` with a class asks the owner
        self.assert_prompted("owner", "owner:data-loss")

    def test_unsure_is_a_refusal(self):
        self.assert_refused("ask", "model")

    def test_unreachable_is_a_refusal(self):
        self.assert_refused("unreachable", "provider_error")

    def test_provider_error_is_a_refusal(self):
        self.assert_refused("error", "provider_error")

    def test_invalid_verdict_is_a_refusal(self):
        # a verdict outside the closed set is unusable (asked for once more, then refused): nobody is asked
        self.assert_refused("invalid", "invalid_verdict")

    def test_timeout_is_a_refusal(self):
        self.assert_refused("hang", "timeout", timeout_ms=1500)

    def test_reviewer_follows_the_active_provider_without_restart(self):
        rig = self.review_rig("allow", b_without_review=True)
        pi = rig.start()
        self.assertFalse(self.ask(pi)[0])
        pi.request({"type": "set_model", "provider": PROVIDER_B, "modelId": "foreman"})
        # another command: an identical cleared call would be answered from the judge's cache without a model call
        dialog, bash = self.ask(pi, "r2")
        pi.close()
        # provider B sets no review model: its auto-picked role-map model answers with the scripted text, which is not a verdict, so the
        # judge is no clear and the call is refused without a dialog (plan D1); the switch is shown by the changed outcome
        self.assertFalse(dialog)
        self.assertEqual([e for e, _ in bash], [True])
        self.assertEqual(self.outcomes(rig), ["allow", "escalate"])
        self.assertEqual(self.causes(rig), [("allow", "judge"), ("deny", "judge:invalid_verdict")])


if __name__ == "__main__":
    unittest.main()
