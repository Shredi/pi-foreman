import subprocess
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_foreman_config import render_prompt  # noqa: E402

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
    ("Call it only after the planner's completion notice (refused while a planner runs) and change nothing", "Change nothing"),
    ("re-plan (relaunch `planner` or edit the plan yourself), then checkpoint again.", "revise the plan yourself, then checkpoint again."),
    ("closed by a fresh `reviewer` or `senior-reviewer` that marks it", "closed by a fresh `reviewer` that marks it"),
    ("raise the tier with `/ceremony`.\n- The count starts again", "raise the tier with `/ceremony`. A builder launch that answers a reviewer FAIL with a `SECURITY:` finding does not count against that limit (at most twice the limit in all).\n- The count starts again"),
    ("- Launch only the roles `explorer`, `planner`, `builder`, `reviewer`, `senior-reviewer`, `finalizer`. Other agents are refused. `planner` only as a single launch, never in `tasks`, `chain` or `resume`; it writes only under `.workflow/`.",
     "- Launch only the roles `explorer`, `builder`, `reviewer`. Other agents are refused."),
]


class SizingPromptTest(unittest.TestCase):
    def knobs(self, **over):
        k = {"ledgerhelper": "tool", "heavythreshold": "strict", "reviewperrevision": "on", "trivialpath": "builder",
             "ladder": "on", "factrulings": "on", "launchbriefs": "on", "reviewmarks": "on", "research": "on",
             "planreview": "on", "tools.pr": "on", "sizing": "on"}
        k.update(over)
        return k

    def test_sizing_on_fits_and_is_neutral(self):
        text = (ROOT / "instructions" / "foreman.md").read_text()
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
        text = (ROOT / "instructions" / "foreman.md").read_text()
        for brief in ("off",):  # the merged launch-brief lines only render with launchBriefs on
            k = self.knobs(sizing="off", launchbriefs=brief)
            # round 68: the launch `mcp` field is named in the launch rule
            old_launch = "`output` and `outputMode` are refused (`output_path`). Workflow scripts"
            new_launch = "`output` and `outputMode` are refused (`output_path`). `mcp: [\"server\", \"server/tool\"]` narrows a child's MCP tools to part of its role's ceiling (single launches only; `[]` = none). Workflow scripts"
            # token-diet item 9: the ask_user_question rule
            old_ask = "- Plan mode is not part of the ceremony; the checkpoint is.\n"
            new_ask = "- Plan mode is not part of the ceremony; the checkpoint is. Questions to the owner go through `ask_user_question`: 1 to 4 questions, each with a `header` chip and 2 to 4 options that are objects with a `label` and a `description`. An answer may carry `user notes:` or a `global note:`; treat them as part of the answer. When `ask_user_question` is not in your tool list (no human at the pane), ask by file (`ask.md`).\n"
            want = render_prompt(old.stdout.decode("utf-8"), k).replace(old_launch, new_launch)
            # roles-slim: the planner, finalizer and senior-reviewer roles are gone (one old/new pair per changed rendered line)
            for old_text, new_text in ROLE_PAIRS:
                self.assertIn(old_text, want)
                want = want.replace(old_text, new_text)
            want = want.replace(old_ask, new_ask)
            self.assertEqual(render_prompt(text, k), want)
        self.assertNotIn("size: {files", render_prompt(text, self.knobs(sizing="off")))


if __name__ == "__main__":
    unittest.main()
