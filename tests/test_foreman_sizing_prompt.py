import os
import subprocess
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_foreman_config import render_prompt, review_loop_rewrite

ROOT = Path(__file__).resolve().parent.parent
BASE = "b228232"  # origin/main after #15: foreman.md as before the sizing fold


ROLE_PAIRS = [
    # builders push (PR-B): the child push line names who pushes
    ("- Children run detached with a strict tool allowlist. They never push.",
     "- Children run detached with a strict tool allowlist. A builder from a single launch pushes its own branch; other children never push, and a builder from a `tasks` or `chain` launch does not either (the foreman pushes for it, or launches a builder that must push on its own). No child opens or merges a PR."),
    # D71 addendum: a refused shell write keeps the tier; only a refused tool edit raises it
    ("A refused project edit makes the task standard: write the ledger and delegate.", "A refused `write`, `edit`, `foreman_move` or `foreman_copy` on a project file makes the task standard: write the ledger and delegate. A refused shell write keeps the tier, and the change still goes to a builder."),
    # D28: finish refusals are counted per unchanged state, not per user prompt
    ("After two refusals per user prompt the finish goes through,", "After two refusals of the same unchanged state (missing steps and work) the finish goes through,"),
    ("needs a `reviewer` or `senior-reviewer` PASS on the current head", "needs a `reviewer` PASS on the current head"),
    ("a commit made after the PASS, a finalizer's included, makes the review stale. Heavy order: builder, finalizer, reviewer, PR.", "commit exactly the reviewed files, push, then open the PR; a commit that adds or changes anything after the PASS makes the review stale. Heavy order: builder(s), reviewer, PR."),
    ("a `reviewer` (or `senior-reviewer`) PASS.", "a `reviewer` PASS."),
    ("the finalizer drafts it at heavy tier, you draft it otherwise.", "you draft it in the scratch dir at every tier. For a runtime or UI change in a repo with a way to drive it, the PR body also carries a short `## Verification` section (the command run and the path of the kept log or screenshot, from the builder's report)."),
    ("Skip explorer, planner, reviewer and finalizer:", "Skip explorer and reviewer:"),
    ("- heavy: ledger, then `planner` (single launch; it writes `.workflow/scratch/plan-<topic>.md`), then `foreman_checkpoint({path})`, then builder(s), `finalizer`, `reviewer`, PR. Builders may fan out up to the configured width. `finalizer` closes the task; it is also required before you may finish.",
     "- heavy: ledger, then your own plan in `.workflow/scratch/plan-<topic>.html` (an HTML page the owner reads in the browser; `plan-<topic>.md` also works), then plan review, then `foreman_checkpoint({path})`, then builder(s), `reviewer`, PR. Builders may fan out up to the configured width. Heavy follows standard for commit and Changelog: after the `reviewer` PASS you stage explicit paths and commit, and you draft `## Changelog` in the scratch dir."),
    ("After a FAIL send the plan back to the planner once", "After a FAIL revise the plan once"),
    ("After a FAIL revise the plan once (`plan_revision_required`) and have the revised plan reviewed again; then the checkpoint opens and the owner sees the verdict.",
     "After a FAIL (`plan_revision_required`) revise the plan and have it reviewed again, as often as needed and without asking, while the findings are defects or gaps. A finding needs a decision when the reviewer marked it `DECISION:` or settling it means choosing scope, risk, a gate, guard or permission that loosens, a default, format or cost that changes, or a trade-off with no single sensible fix; ask then, when unsure, and when a finding comes back after you revised for it. Go to the checkpoint with a FAIL only for such findings. After every fifth failed review of the same plan in a row, say so in one line with the count (to the parent by a normal update when you have one, otherwise in your chat reply) and go on."),
    # cost-turns: the planner's self-check before the first plan review (instructions/foreman.md)
    ("while the findings are defects or gaps. A finding needs a decision when",
     "while the findings are defects or gaps. Before the first review, launch an inexpensive `explorer` to check every claim the plan makes about the code (file:line, symbol, caller, test named) against the code and to report the wrong, unverified and unread ones: a wrong claim found there costs far less than a review round. Fix what it reports. Then read the plan once against the rest of the reviewer's list: callers, consumers and pinning tests of every changed symbol, text or default; failure paths and modes (resume, reload, feature off, child session, remote); doc, config and schema follow-ups; a test for every named condition; parts of the plan that agree with each other and with the ledger. State a code fact only when it was read (by an explorer or by you), else mark it an assumption. On a finding, fix its class across the whole plan and re-read the changed text against that list before the next review. A finding needs a decision when"),
    ("Call it only after the planner's completion notice (refused while a planner runs) and change nothing", "Change nothing"),
    ("re-plan (relaunch `planner` or edit the plan yourself), then checkpoint again.", "revise the plan yourself, then checkpoint again."),
    ("closed by a fresh `reviewer` or `senior-reviewer` that marks it", "closed by a fresh `reviewer` launched with `items` naming V (it gives V a `pass` result in its `review_verdict` call after its own check)"),
    ("If the reviewer reports FAIL, you may relaunch", "If the reviewer records FAIL, you may relaunch"),
    ("(it gives V a `pass` result in its `review_verdict` call after its own check) after its own check, or by you", "(it gives V a `pass` result in its `review_verdict` call after its own check), or by you"),
    ("raise the tier with `/ceremony`.\n- The count starts again", "raise the tier with `/ceremony`. A builder launch that answers a reviewer FAIL with a `SECURITY:` finding does not count against that limit (at most twice the limit in all).\n- The count starts again"),
    ("- Launch only the roles `explorer`, `planner`, `builder`, `reviewer`, `senior-reviewer`, `finalizer`. Other agents are refused. `planner` only as a single launch, never in `tasks`, `chain` or `resume`; it writes only under `.workflow/`.",
     "- Launch only the roles `explorer`, `builder`, `reviewer`. Other agents are refused."),
    # persistent PR watch: the watch is armed by pr_create and stays until merge or close; a child never closes itself
    ("After you open a PR, call `pr_watch`; on its message fix failing checks or answer the comments, then get a reviewer PASS on the new head and ask for review again.",
     "`pr_create` arms a watch that stays until the PR is merged or closed and reports each CI result, failing job, comment, review, conflict and missing CI. Act on each message. `pr_create` opens the PR as a draft. Once a pre-pr reviewer PASS stands on the current head, the watch takes it out of draft, even while CI still runs; it keeps reporting CI after that. A PR opened with the `holdDraft` field of `pr_create` stays in draft and gets no ready label while the watch reports CI. You own the PR you opened: fix its CI yourself, then get a reviewer PASS on the new head and ask for review again. A child session reports to its parent only `PR #n green on <sha>, mergeable, ready to merge`, or, when the checks passed but a draft state, a review or a branch rule holds the PR back, the line the watch gives, or that it is stuck and why. A session cannot close while its PR is open and watched (`close refused: PR #n open and watched`: wait for the merge, or `pr_unwatch`). A child session never closes itself: after its PR is merged it goes on with its brief, writes `result.md` (PR numbers, merge commits, anything left open) and sends `Result from` when the brief is done; its parent reviews the result and sends `foreman:close`, and its worktree and local branch are removed after it exits."),
    # ready, then wait: no session merges
    ("removed after it exits.\n",
     "removed after it exits. Your work on a PR ends at ready: checks green, mergeable, a reviewer PASS on the head, out of draft. Say so once (a child with the watch's report line to its parent; a session without a parent to the owner, judged from the watch's check result, the mergeable state and its own PASS) and wait. No session merges a PR, its own or a child's: the owner wants a human look before anything lands, and the host decides how it lands. The watch tells you when it is merged. While you wait, a review or comment the watch reports is feedback: rework, get a reviewer PASS on the new head, and say ready again. Leave a ready PR as it stands: a moved base is no reason to merge it into the PR or to rerun CI, so merge the base in only when the PR is CONFLICTING or the base fix is needed for that branch's own CI. When the watch reports the merge, check the base's CI on the merge commit; if it is red, fix forward with a small PR.\n"),
    # rules diet: prohibitions with exceptions or plain preferences read as the wanted behaviour
    ("notice; do not rely on that.", "notice."),
    ("`write` tool, never through the shell. Writing it", "`write` tool. Writing it"),
    ("every item its `N. PASS` lines name (never V); do not mark those by hand. Mark yourself only items",
     "every item the reviewer's `review_verdict` call gives a `pass` result. Name the items to review in the launch's `items` field (`items: [1, 4, \"V\"]`, beside `agent` and `task`); without it the review takes every open item except V. Mark yourself only items"),
    ("turn. Never poll with bash.", "turn."),
    ("change workspace files yourself (`write`, `edit`, `foreman_move`, `foreman_copy`), and then only", "change workspace files yourself, and then only"),
    ("launch a builder instead. `.workflow/` (ledger, notes) stays writable. Do not work", "launch a builder instead. Do not work"),
    ("stays unbound and the gates treat the session as having no ledger.", "stays unbound, so the gates see none."),
    # git guard removed: the PR tool refuses without a PASS, a shell-opened PR is not refused, a watch follows it
    ("on the current head; the adapter refuses it otherwise. Start",
     "on the current head. The PR tool `pr_create` refuses without it; a PR opened from the shell is not refused, but the rule stays: review before the PR. After you open a PR from the shell, start a watch on it with `pr_watch`. Start"),
    # html plans: the standard line names the HTML plan form
    ("then your own short plan in `.workflow/scratch/plan-<topic>.md` (scratchpad mode allows it)",
     "then your own short plan in `.workflow/scratch/plan-<topic>.html` (an HTML page, or `plan-<topic>.md`; scratchpad mode allows it), the HTML from `{{planSkeleton}}`"),
    # html plans: an HTML plan keeps rulings in a sidecar and any page change is a new version
    ("a body edit is a new version. After a FAIL",
     "a body edit is a new version. An HTML plan (`plan-<topic>.html`) has no such heading: write its rulings to `rulings-<topic>.md` next to it, never into the page, and any change to the page, style included, is a new version; the reviewer reads the markdown copy `plan-<topic>.md` the harness generates from the page, which you never edit. After a FAIL"),
    # D74: foreman_ledger add takes texts, upsert takes entries (the ledgerHelper=tool line)
    ("Manage items with the tool `foreman_ledger({action, items?, text?})` on your own ledger. Actions: `status`; `mark` (`items`: item numbers, several in one call); `add` (`text`); `upsert` (`item?`, `text`: replace that item's text and keep its state, or append when `item` is omitted; same text is a no-op); `note` and `defer` (one item, `text` is the note or the reason). Every call returns `ledger status`. It does not count against `ceremony.recheckBudget`.",
     "Manage items with the tool `foreman_ledger({action, items?, text?})` on your own ledger. Actions: `status`; `mark` (`items`: item numbers, several in one call); `add` (`text`, or `texts` for several items in one call); `upsert` (`item?`, `text`: replace that item's text and keep its state, or append when `item` is omitted; same text is a no-op; `entries: [{item?, text}]` for several in one call); `note` and `defer` (one item, `text` is the note or the reason). Every call returns `ledger status`."),
    # D80: `init` creates and binds the ledger when `write` is missing (applies to the line the D74 pair just produced)
    ("`add` (`text`, or `texts` for several items in one call); `upsert`", "`add` (`text`, or `texts` for several items in one call); `init` (`topic`, `texts?`: creates and binds `.workflow/LEDGER-<topic>.md` with the `texts` items plus V when `write` is missing, and binds an existing file unless the session is bound elsewhere); `upsert`"),
    # D72: a plan-only session closes V on a plan-review PASS (the ledgerHelper=tool V line)
    ("once a reviewer PASS stands with no builder launch or project edit since; before that the tool refuses.",
     "once a reviewer PASS stands (later work does not matter; the tool refuses before a PASS, and while a checkout's last review failed; in a session with no builder launch and no project edit, a `[plan-review]` PASS on the current version of every plan also closes it)."),
    # review occasion: the launch field `occasion` names the kind of review; a tag first in the task still works
    ("launch one `reviewer` with `[plan-review]` in its task on the plan file and the ledger,",
     "launch one `reviewer` with `occasion: \"plan-review\"` on the plan file and the ledger (the field names the kind of review; a `[plan-review]` first in the task works too),"),
    ("Add `[second-opinion]` to its task only for auth",
     "Set `occasion: \"second-opinion\"` on it only for auth"),
    ("on the whole branch diff with `[pre-pr]` in its task (never refused as a repeat); its PASS on the head opens the PR gate. `[second-opinion]` is optional advice: it never blocks, marks items or opens the PR gate. ",
     "on the whole branch diff with `occasion: \"pre-pr\"` (never refused as a repeat; it may name items that are already done in `items`, and without `items` it takes the items reviewed in its worktree); its PASS on the head opens the PR gate. `occasion: \"second-opinion\"` is optional advice: it never blocks, marks items or opens the PR gate. Name the review kind with the `occasion` field or a tag first in the task: a tag only later in the text is refused (`review_occasion_late`), and a tag first in the task beside a different field is refused (`review_occasion_ambiguous`). "),
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
            if os.environ.get("CI"):
                self.fail(f"base commit {BASE} missing: CI checkout must use fetch-depth: 0")
            self.skipTest("base commit not available")
        text = (ROOT / "instructions" / "foreman.md").read_text(encoding="utf-8")
        for brief in ("off",):  # the merged launch-brief lines only render with launchBriefs on
            k = self.knobs(sizing="off", launchbriefs=brief, show="off")  # show "off": no foreman_show explain rule
            # round 68: the launch `mcp` field is named in the launch rule (no `mcp` = no MCP for the child)
            old_launch = "`output` and `outputMode` are refused (`output_path`). Workflow scripts"
            new_launch = "`output` and `outputMode` are refused (`output_path`). `mcp: [\"server\", \"server/tool\"]` gives a child MCP tools from its role's ceiling (single launches only; no `mcp` or `[]` = none). Name each tool the task will probably need as `server/tool`, so it is in the child's tool list from the first request, and add the bare `server` so the child finds the rest with `tool_search`. Workflow scripts"
            # token-diet item 9: the ask_user_question rule
            old_ask = "- Plan mode is not part of the ceremony; the checkpoint is.\n"
            new_ask = "- Plan mode is not part of the ceremony; the checkpoint is. Questions to the owner go through `ask_user_question`: 1 to 4 questions, each with a `header` chip and 2 to 4 options that are objects with a `label` and a `description`. An answer may carry `user notes:` or a `global note:`; treat them as part of the answer. When `ask_user_question` is not in your tool list (no human at the pane), ask the parent in a message, or by file (`ask.md`) when intercom cannot reach it. Ask once: a question goes to the parent or, when a human is at the pane and the decision is the owner's, to the owner as a dialog.\n"
            # review-own-model: `reason` placement (rendered with the ladder rule) and the real different-model rule
            old_reason = "needs a `reason` (why the default model cannot do it), and at trivial"
            new_reason = "needs a `reason` (why the default model cannot do it; a top-level key of the `subagent` call, never inside `options` or `args`), and at trivial"
            old_own = "A review never runs on your own model; the adapter swaps it."
            new_own = "A configured reviewer pair is used as set; otherwise the adapter moves a review off your model (the same model id under another provider counts as your model) when another model is mapped. A risky change can get one more review. When the adapter reminds you of a high-stakes review, judge whether the change warrants it; if it does, launch one `reviewer` with `occasion: \"high-stakes\"`, alone, on the whole change, after the last PASS (before a PR, after the pre-pr PASS), once the change is complete. If it reports FAIL, revise or answer the findings, then pass the normal reviewer again (before a PR, `occasion: \"pre-pr\"`; it gets the findings and its PASS clears the FAIL); the adapter then reminds you of a second and last high-stakes review (two per worktree; the findings go to the next review of the worktree they came from). If that fails too, revise, pass the normal reviewer again and tell the owner in one line that the second high-stakes review failed and on what. Name each high-stakes review in the PR body, one line each: `High-stakes review: <verdict> on <sha> (<reasons>)`."
            want = render_prompt(old.stdout.decode("utf-8"), k).replace(old_launch, new_launch)
            # review per checkout: the finish rule and the repeat rule name the checkout
            old_fin = "A FAIL, or a builder launch or project edit after the review, leaves the reviewer step open until a re-review passes."
            new_fin = "A FAIL, or a builder launch or project edit in a checkout after its review, leaves that checkout's reviewer step open until a re-review passes there; the finish needs a standing PASS in every checkout you worked in."
            old_rep = "after a PASS with nothing changed, a second reviewer launch is refused."
            new_rep = "after a PASS with nothing changed in that checkout, a second reviewer launch there is refused."
            # plan-form-readers: the dash forms of an appendix heading
            old_dash = "`## Addendum` heading: append rulings"
            new_dash = "`## Addendum` heading (a colon, a dash (-, \u2013 or \u2014), a bracket or a number may follow the word): append rulings"
            for old_text, new_text in ((old_reason, new_reason), (old_own, new_own), (old_fin, new_fin), (old_rep, new_rep), (old_dash, new_dash)):
                self.assertIn(old_text, want)
                want = want.replace(old_text, new_text)
            # roles-slim: the planner, finalizer and senior-reviewer roles are gone (one old/new pair per changed rendered line)
            for old_text, new_text in ROLE_PAIRS:
                self.assertIn(old_text, want)
                want = want.replace(old_text, new_text)
            # launch fields: a numbered item beyond the failed ones is reviewed against the whole change
            old_items = "a review did not cover, and only after you have checked the evidence on disk."
            new_items = old_items + " A numbered item in `items` outside the current failed items is reviewed against the whole change."
            self.assertIn(old_items, want)
            want = want.replace(old_items, new_items)
            want = review_loop_rewrite(want.replace(old_ask, new_ask))
            self.assertEqual(render_prompt(text, k), want)
        self.assertNotIn("size: {files", render_prompt(text, self.knobs(sizing="off")))

    def test_missing_base_fails_in_ci_instead_of_skipping(self):
        # a shallow CI checkout lacks the base commit; there the test must fail, not skip
        case = SizingPromptTest("test_sizing_off_bytes_unchanged")
        result = unittest.TestResult()
        with mock.patch.object(sys.modules[__name__], "BASE", "0" * 40), mock.patch.dict(os.environ, {"CI": "1"}):
            case.run(result)
        self.assertEqual(result.skipped, [])
        self.assertEqual(len(result.failures), 1)
        self.assertIn("CI checkout must use fetch-depth: 0", result.failures[0][1])


if __name__ == "__main__":
    unittest.main()
