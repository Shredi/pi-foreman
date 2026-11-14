import subprocess
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_foreman_config import render_prompt, review_loop_rewrite  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
BASE = "b228232"  # origin/main after #15: foreman.md as before the sizing fold


ROLE_PAIRS = [
    ("needs a `reviewer` or `senior-reviewer` PASS on the current head", "needs a `reviewer` PASS on the current head"),
    ("a commit made after the PASS, a finalizer's included, makes the review stale. Heavy order: builder, finalizer, reviewer, PR.", "a commit made after the PASS makes the review stale. Heavy order: builder(s), reviewer, PR."),
    ("a `reviewer` (or `senior-reviewer`) PASS.", "a `reviewer` PASS."),
    ("the finalizer drafts it at heavy tier, you draft it otherwise.", "you draft it in the scratch dir at every tier."),
    ("Skip explorer, planner, reviewer and finalizer:", "Skip explorer and reviewer:"),
    ("- heavy: ledger, then `planner` (single launch; it writes `.workflow/scratch/plan-<topic>.md`), then `foreman_checkpoint({path})`, then builder(s), `finalizer`, `reviewer`, PR. Builders may fan out up to the configured width. `finalizer` closes the task; it is also required before you may finish.",
     "- heavy: ledger, then your own plan in `.workflow/scratch/plan-<topic>.md`, then plan review, then `foreman_checkpoint({path})`, then builder(s), `reviewer`, PR. Builders may fan out up to the configured width. Heavy follows standard for commit and Changelog: after the `reviewer` PASS you stage explicit paths and commit, and you draft `## Changelog` in the scratch dir."),
    ("After a FAIL send the plan back to the planner once", "After a FAIL revise the plan once"),
    ("After a FAIL revise the plan once (`plan_revision_required`) and have the revised plan reviewed again; then the checkpoint opens and the owner sees the verdict.",
     "After a FAIL (`plan_revision_required`) revise the plan and have it reviewed again, as often as needed and without asking, while the findings are defects or gaps. A finding needs a decision when the reviewer marked it `DECISION:` or settling it means choosing scope, risk, a gate, guard or permission that loosens, a default, format or cost that changes, or a trade-off with no single sensible fix; ask then, when unsure, and when a finding comes back after you revised for it. Go to the checkpoint with a FAIL only for such findings. After every fifth failed review of the same plan in a row, say so in one line with the count (to the parent by a normal update when you have one, otherwise in your chat reply) and go on."),
    ("Call it only after the planner's completion notice (refused while a planner runs) and change nothing", "Change nothing"),
    ("re-plan (relaunch `planner` or edit the plan yourself), then checkpoint again.", "revise the plan yourself, then checkpoint again."),
    ("closed by a fresh `reviewer` or `senior-reviewer` that marks it", "closed by a fresh `reviewer` that marks it"),
    ("raise the tier with `/ceremony`.\n- The count starts again", "raise the tier with `/ceremony`. A builder launch that answers a reviewer FAIL with a `SECURITY:` finding does not count against that limit (at most twice the limit in all).\n- The count starts again"),
    ("- Launch only the roles `explorer`, `planner`, `builder`, `reviewer`, `senior-reviewer`, `finalizer`. Other agents are refused. `planner` only as a single launch, never in `tasks`, `chain` or `resume`; it writes only under `.workflow/`.",
     "- Launch only the roles `explorer`, `builder`, `reviewer`. Other agents are refused."),
    # persistent PR watch: the watch is armed by pr_create and stays until merge or close; a child closes itself on merge
    ("After you open a PR, call `pr_watch`; on its message fix failing checks or answer the comments, then get a reviewer PASS on the new head and ask for review again.",
     "`pr_create` arms a watch that stays until the PR is merged or closed and reports each CI result, failing job, comment, review, conflict and missing CI. Act on each message; do not re-arm. You own the PR you opened: fix its CI yourself, then get a reviewer PASS on the new head and ask for review again. A child session reports to its parent only `PR #n green on <sha>, mergeable, ready to merge`, or, when the checks passed but a draft state, a review or a branch rule holds the PR back, the line the watch gives, or that it is stuck and why. A session cannot close while its PR is open and watched (`close refused: PR #n open and watched`: merge it, or `pr_unwatch`). A child session closes itself when its PR is merged: it writes `result.md` (PR number, merge commit, anything left open), and its worktree and local branch are removed after it exits."),
    # fast merge policy
    ("removed after it exits.\n",
     "removed after it exits. Merge fast: merge a PR that is green and mergeable without merging the base into it or rerunning CI, even if the base moved. After each merge check the base's CI on the merge commit; if it is red, fix forward with a small PR. Merge the base into a branch only when the PR is CONFLICTING, or when the base fix is needed for that branch's own CI.\n"),
    # git guard removed: the PR tool refuses without a PASS, a shell-opened PR is not refused, a watch follows it
    ("on the current head; the adapter refuses it otherwise. Start",
     "on the current head. The PR tool `pr_create` refuses without it; a PR opened from the shell is not refused, but the rule stays: review before the PR. After you open a PR from the shell, start a watch on it with `pr_watch`. Start"),
]


class SizingPromptTest(unittest.TestCase):
    def knobs(self, **over):
        k = {"ledgerhelper": "tool", "heavythreshold": "strict", "reviewperrevision": "on", "trivialpath": "builder",
             "ladder": "on", "factrulings": "on", "launchbriefs": "on", "reviewmarks": "on", "research": "on",
             "planreview": "on", "tools.pr": "on", "sizing": "on", "show": "on"}
        k.update(over)
        return k

    def test_sizing_on_fits_and_is_neutral(self):
        text = (ROOT / "instructions" / "foreman.md").read_text(encoding="utf-8")
        for mode in ("tool", "bash", "off"):
            for heavy in ("strict", "eee843d"):
                for review in ("on", "off"):
                    for trivial in ("builder", "off"):
                        kept = render_prompt(text.lower(), self.knobs(ledgerhelper=mode, heavythreshold=heavy,
                                                                      reviewperrevision=review, trivialpath=trivial))
                        self.assertLessEqual(len(kept.splitlines()), 70, (mode, heavy, review, trivial))
        self.assertIn("size: {files", render_prompt(text, self.knobs()))
        for word in ("claude", "sonnet", "opus", "fable", "gpt", "gemini", "copilot", "openrouter"):
            self.assertNotIn(word, text.lower())

    def test_sizing_off_bytes_unchanged(self):
        old = subprocess.run(["git", "show", BASE + ":instructions/foreman.md"], cwd=str(ROOT), capture_output=True)
        if old.returncode != 0:
            self.skipTest("base commit not available")
        text = (ROOT / "instructions" / "foreman.md").read_text(encoding="utf-8")
        for brief in ("off",):  # the merged launch-brief lines only render with launchBriefs on
            k = self.knobs(sizing="off", launchbriefs=brief, show="off")  # show "off": no foreman_show explain rule
            # round 68: the launch `mcp` field is named in the launch rule (no `mcp` = no MCP for the child)
            old_launch = "`output` and `outputMode` are refused (`output_path`). Workflow scripts"
            new_launch = "`output` and `outputMode` are refused (`output_path`). `mcp: [\"server\", \"server/tool\"]` gives a child MCP tools from its role's ceiling (single launches only; no `mcp` or `[]` = none). Name each tool the task will probably need as `server/tool`, so it is in the child's tool list from the first request, and add the bare `server` so the child finds the rest with `tool_search`. Workflow scripts"
            # token-diet item 9: the ask_user_question rule
            old_ask = "- Plan mode is not part of the ceremony; the checkpoint is.\n"
            new_ask = "- Plan mode is not part of the ceremony; the checkpoint is. Questions to the owner go through `ask_user_question`: 1 to 4 questions, each with a `header` chip and 2 to 4 options that are objects with a `label` and a `description`. An answer may carry `user notes:` or a `global note:`; treat them as part of the answer. When `ask_user_question` is not in your tool list (no human at the pane), ask by file (`ask.md`).\n"
            # review-own-model: `reason` placement (rendered with the ladder rule) and the real different-model rule
            old_reason = "needs a `reason` (why the default model cannot do it), and at trivial"
            new_reason = "needs a `reason` (why the default model cannot do it; a top-level key of the `subagent` call, never inside `options` or `args`), and at trivial"
            old_own = "A review never runs on your own model; the adapter swaps it."
            new_own = "A configured reviewer pair is used as set; at high stakes the high-stakes model applies when one is set; otherwise the adapter moves a review off your model (the same model id under another provider counts as your model) when another model is mapped."
            want = render_prompt(old.stdout.decode("utf-8"), k).replace(old_launch, new_launch)
            for old_text, new_text in ((old_reason, new_reason), (old_own, new_own)):
                self.assertIn(old_text, want)
                want = want.replace(old_text, new_text)
            # roles-slim: the planner, finalizer and senior-reviewer roles are gone (one old/new pair per changed rendered line)
            for old_text, new_text in ROLE_PAIRS:
                self.assertIn(old_text, want)
                want = want.replace(old_text, new_text)
            want = review_loop_rewrite(want.replace(old_ask, new_ask))
            self.assertEqual(render_prompt(text, k), want)
        self.assertNotIn("size: {files", render_prompt(text, self.knobs(sizing="off")))


if __name__ == "__main__":
    unittest.main()
