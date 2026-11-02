"""The classifier on the dangerous class (safety wave, ledger items 7-9, decision D3; r79 rules-first gate).

Run:  python -m unittest discover -s tests/replay -v
The classifier model is a fake model on the fake provider (`review-<kind>`, see fake_provider.ts) that answers every
request with a fixed verdict against the rig's two-sentence whitelist (A1 allow, D1 deny). The command `pip install requests`
is the dangerous class `danger-install`; a routine command such as `uname -s` never reaches the classifier under mode auto.
Expected: allow -> no prompt; deny -> denied with the whitelist rule's text; escalate (the model's own, a provider error,
an invalid verdict, a timeout) -> the human prompt.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import json  # noqa: E402

from driver import DIALOGS, PROVIDER_A, PROVIDER_B, load_fixture, tool_results  # noqa: E402
from test_replay import REASON, ReplayCase  # noqa: E402

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
                       permissions="baseline", config={"providers": providers})
        self.user_permissions(rig, {"classifier": {"allow": ["Installing a package from the registry is allowed."], "deny": ["Reading secrets is never allowed."]}})
        return rig

    def ask(self, pi, tag="r1"):
        """(dialog shown, [(isError, text)] of the bash call)."""
        recs = pi.prompt("[[replay:%s]] go" % tag, answers=list(YES), timeout=60)
        dialogs = [r for r in recs if r.get("type") == "extension_ui_request" and r.get("method") in DIALOGS]
        return bool(dialogs), [(e, t) for _, e, t in tool_results(recs, "bash")]

    def outcomes(self, rig):
        return [r.get("decision") for recs in rig.traces().values() for r in recs if r.get("event") == "review"]

    def causes(self, rig):
        """The classifier's gate-log records as (verdict, rule): an escalation's rule is its cause (model, provider_error, wrong_entry, timeout ...)."""
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
        self.assertEqual(causes, [("ask", cause)])

    def test_allow_runs_without_a_prompt(self):
        dialog, bash, outcomes, causes = self.run_path("allow")
        self.assertFalse(dialog)
        self.assertEqual([e for e, _ in bash], [False])
        self.assertEqual(outcomes, ["allow"])
        self.assertEqual(causes, [("allow", "prose:A1")])

    def test_deny_is_final(self):
        dialog, bash, outcomes, causes = self.run_path("deny")
        self.assertFalse(dialog)
        self.assertEqual([e for e, _ in bash], [True])
        self.assertIn("denied by whitelist rule D1", bash[0][1])
        self.assertEqual(outcomes, ["deny"])
        self.assertEqual(causes, [("deny", "prose:D1")])

    def test_ask_goes_to_the_human(self):
        self.assert_prompted("ask", "model")

    def test_unreachable_goes_to_the_human(self):
        self.assert_prompted("unreachable", "provider_error")

    def test_provider_error_goes_to_the_human(self):
        self.assert_prompted("error", "provider_error")

    def test_invalid_verdict_goes_to_the_human(self):
        # an allow verdict citing a whitelist entry that does not exist is unusable: the classifier escalates, the human is asked
        self.assert_prompted("invalid", "wrong_entry")

    def test_timeout_goes_to_the_human(self):
        self.assert_prompted("hang", "timeout", timeout_ms=1500)

    def test_reviewer_follows_the_active_provider_without_restart(self):
        rig = self.review_rig("allow", b_without_review=True)
        pi = rig.start()
        self.assertFalse(self.ask(pi)[0])
        pi.request({"type": "set_model", "provider": PROVIDER_B, "modelId": "foreman"})
        # another command: an identical allowed call would be answered from the classifier's cache without a model call
        dialog, bash = self.ask(pi, "r2")
        pi.close()
        # provider B sets no review model: its auto-picked role-map model answers with the scripted text, which is not a verdict, so the
        # classifier escalates and the human is asked; the switch is shown by the changed outcome
        self.assertTrue(dialog)
        self.assertEqual([e for e, _ in bash], [False])
        self.assertEqual(self.outcomes(rig), ["allow", "escalate"])
        self.assertEqual(self.causes(rig), [("allow", "prose:A1"), ("ask", "invalid_verdict")])


if __name__ == "__main__":
    unittest.main()
