# Prompting Claude Fable 5.1 (and Mythos 5.1)

Source: https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5-1
Checked: 2026-11-01

Own-words digest. Prompts that worked on Fable 5 should work unchanged; this page lists what to adjust, by symptom. Read `claude.md` for the techniques shared by all current models.

## Contents

- Effort
- Progress updates
- Finishing long tasks
- Tool batching and history
- Writing and formatting
- Scope and edits
- Search, refusals, outputs, subagents, vision

## Effort

Default is `high`. Test `low`, `medium`, `xhigh` and `max` against your own evals, and rerun the sweep per model, because level names do not map to the same amount of thinking across models. Gains over Fable 5 are largest at higher settings; `medium` roughly matches Fable 5 at lower cost; `low` is often competitive with the Opus and Sonnet lines on cost per task while scoring higher.

## Progress updates

Compared with Fable 5, this model says less to the user while a long tool-calling turn runs, and the gap widens as effort rises.

1. Check the client actually receives progress-update thinking blocks (a display setting on the thinking parameter, behind a beta header).
2. Audit the prompt for lines that suppress narration ("hold findings for the final reply") and remove them.
3. If you still want more, add one short line saying when you want user-facing text and what an update contains.
4. If the UI hides tool output, say so in a turn-scoped message; otherwise the model runs commands to "show" output the user never sees.

## Finishing long tasks

In complex asynchronous work a turn may close with a description of the coming step ("Next, I'll ..."), or with a request for approval of something the user already asked for. Combine two system-prompt additions. First, state that nobody is watching, so it must not query work that was requested and should execute the next steps it has named; add the confirmations your product genuinely still requires. Second, declare that the user's request marks the boundary of the deliverable. For compaction, spell out what a summary has to keep.

## Tool batching and history

- In long coding or computer-use loops it may issue one call per turn when the next independent calls are only implied. A one-sentence nudge after each tool result, sent as a turn-scoped system message, fixes it. Append a fresh copy each turn; never delete earlier copies, since that edits earlier turns.
- Keep history append-only: return assistant turns exactly as received, thinking blocks included. Do not edit earlier turns, rebuild the system prompt or tools, or summarise old turns in place; that breaks thinking-block binding and restarts the prompt cache. Send per-turn reminders and instruction changes as system messages mid-conversation, and trim through server-side compaction or context editing. Client-side compaction replaces the whole history with one summary plus the new user turn. Cache reads are cheap, so compacting early may be the wrong trade.

## Writing and formatting

- Prose is plain with few stock phrases but can be dense: long sentences, few paragraph breaks. Define the anti-pattern ("mannered prose") in a user message, preferably, or the system prompt.
- It formats less than earlier models. Delete anti-formatting language written for them, or replace it with a rule for when specific formatting is right.
- It may reproduce retrieved passages without marking them as quotes. Add one full example of a correct answer (request, answer, why it is correct).

## Scope and edits

- It may fix nearby code, extend unmentioned behaviour or add more test files than warranted. Say what to leave out; this cuts unrequested additions a lot without hurting success.
- It leans toward rewriting whole files. An added instruction restores targeted edits for small and medium changes.

## Search, refusals, outputs, subagents, vision

- At low effort it answers from memory more often. Raise effort for affected turns, or add a verification nudge: recognising a name is not knowing its current state, so search names as the user wrote them.
- Fewer safeguard false positives than Fable 5. Known triggers: "does this compile" phrasing (ask "are there bugs"), lesser-known languages (supply docs), base64 in tool output (remove it).
- Under `xhigh` and `max` the model can compose the deliverable inside its thinking and then write it out a second time. Either run these requests at `high`, or size the output limit to cover thinking and reply together.
- Subagents: a start tool that returns at once, results arriving in a later message, and a separate wait tool let the lead keep working; the model still often waits.
- Vision work does better with tools to crop and zoom.
