# Prompting Claude Fable 5.2 (and Mythos 5.2)

Source: https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5-2
Source: https://platform.claude.com/docs/en/models/fable-5-2/whats-new-fable-5-2
Source: https://platform.claude.com/docs/en/models/fable-5-2/migration-guide
Checked: 2026-11-17

Own-words digest. Prompts that worked on Fable 5.1 usually run unchanged; this page lists what to adjust, by symptom, and what changed against 5.1. Read `claude.md` for the techniques shared by all current models. Mythos 5.2 has the same capabilities and is open only to organisations verified through Anthropic's programmes.

## Contents

- What changed against 5.1
- Effort
- Finishing long tasks and approvals
- Code ownership
- Progress updates
- Subagents
- Caution that builds up, and old prompts
- Reports, refusals, history

## What changed against 5.1

- Effort default is still `high`, but the effort sweep must be rerun; level names do not map to the same amount of thinking across models.
- A line that asks for less thinking ("answer directly without deliberating") no longer works from `medium` up; 5.1 usually obeyed it. Lower the effort instead.
- A small output limit can end the turn after thinking and before any text, because thinking counts against it; raise the limit or lower effort.
- Early stops are more common at `low` and `medium`; the page gives new text for it (below).
- Code ownership, approval wording and subagent cost now matter, and the page has new sections for each.
- History rules are enforced: a changed system prompt, tool list or earlier turn, followed by a request that sends thinking back, returns a 400 error. On 5.1 such an edit broke the thinking binding and the prompt cache. Only 5.2 and Mythos 5.2 read 5.2's thinking blocks; any other model on a fallback or router drops them and runs without that reasoning.
- Forced tool choice, disabled thinking and manual thinking budgets return 400 errors (5.1 already did). An old computer-use tool and a non-5.2 advisor also error.
- Price is $8 input and $40 output per million tokens, against $10 and $50 on 5.1; Opus 5.5 is $4 and $20 and defaults to `medium`, so moving from Opus 5.5 runs one level higher unless effort is set.

## Effort

Start at `high` and set it explicitly. `low` fits quick back-and-forth, well-specified work and fast subagents, and on coding evals it scores near 5.1 at higher effort. `medium` fits interactive coding and everyday work. `high` fits hard coding, research and long unattended runs; most of the capability gain is already there. `xhigh` only where you measured a gain; `max` for ceiling tests or open-ended science and maths. At `high` and above the model thinks before nearly every reply, even a greeting, so route easy turns to a lower level. Effort barely changes reply length; steer length and tone by prompt. Mixed levels in one workflow are fine; changing the top-level value mid-conversation can drop cached messages.

## Finishing long tasks and approvals

- Symptom: a turn ends with a list of what remains, an offer to continue, or a stop at an ordinary error or timeout; more at `low` and `medium`. Add a system-prompt block saying: do not stop while owed work remains; carry on with whatever does not depend on the user's answer; diagnose errors, timeouts, locked files and empty results and work through them with the access you have; leave deliberate blockers (a file marked untouchable, withheld access, a guardrail) alone, say so, and find another safe way. On a recorded-session replay at `medium` this about halved unfinished sessions and raised output tokens about 30 percent. It removed permission-asking endings but not endings that list what remains.
- It replaces the two-part "nobody is watching, the request is the boundary" advice of 5.1 for this symptom. Keep your own confirmation step for risky or irreversible actions: the model now asks less.
- When you reply to continue, name what you approve ("yes, run the migration on staging"), not "go".
- Approval rules in a system prompt must be narrow. A rule listing "messages to people outside this conversation" made the model hold back about half of routine requests to colleagues.

## Code ownership

Without a word on ownership, the model adds to the existing structure, even duplicating code, and reports nearby problems rather than fixing them. A sentence stating that it is the owner and long-term maintainer and the design is its call raised consolidation of duplicates from under 10 percent to about 75 percent of runs, at 70 to 80 percent more output tokens, with unrequested tests, docs and some behaviour changes; its closing summary often omitted small changes, so read the diff. Leave the sentence out where the user owns the code and wants minimal change. An earlier "no drive-by refactors" rule did not cancel it: consolidation still happened in over half the runs.

## Progress updates

- Check the client first: updates arrive as `thinking` blocks whose text is empty at the default display setting. Set the display to `updates` (short summaries) or `summarized` (updates plus reasoning summary), both beta, and render non-empty thinking blocks between tool calls.
- Harness fix: count tool steps in a row with nothing readable; after several, append a turn-scoped system message ("the user has not heard from you in a while: say in a few words what you are doing, then continue"). It about halved the longest silent stretch. Leave each reminder in history; removing one edits an earlier turn.
- Prompt fix: an opening line before the first tool call, brief updates while working and a closing recap that stands alone; every run then opened with a message, at about 20 percent more tokens. Without mid-conversation messages, "every few tool calls, give a one-line update" cut most long silences.
- Where nobody needs updates, the model suits long asynchronous work as it is.

## Subagents

Delegation depends on the harness: rare with a bare subagent tool, ready where prompts invite it. At `xhigh` and `max` it started subagents to review its own work, which 5.1 did not on the same tasks. It also works well as planner and orchestrator over other models. Subagents can be a large share of session cost, so check their default model. Change the subagent tool's description only if it starts more than the task needs: state what a subagent adds to cost, when delegation pays and when not, and how to brief one. A longer description of that kind roughly halved subagent counts at `high`. First read standing "delegate" lines in system prompts, skills and agent files.

## Caution that builds up, and old prompts

- Cautious lines pile up in memory, notes and instruction files (agents may write them), and the model follows them closely. Delete notes whose reason is gone, name the routine steps that need no approval, narrow stop-and-review conditions, and write exceptions: "ask before deleting files", not "never delete files", because "never" is read as absolute. A stuck system may be worth restarting with trimmed memory.
- Review lines written for earlier models: standing delegation, a token budget shown to the model (removing a large one cut cost with equal results at `high` and `xhigh`; the API's task-budget feature was not tested), code that edits earlier turns, "treat that answer as done" chat lines (they cut thinking on follow-ups and made it far less likely to flag its own earlier mistakes), "think less" lines, hard style limits ("20 words or fewer" makes prose choppy), and accumulated rules.

## Reports, refusals, history

- Final reports are read by people who did not see the work. A system-prompt block asks for a low-context reader, key points in the first sentences, plain words, no coined terms, short sentences in the manner of simplified technical English, flowing prose where ideas connect and bullets for separate items. It made reports less dense and cut semicolons; add length or detail instructions as needed.
- Safety classifiers can end a request with `stop_reason: "refusal"` and a category: `cyber`, `bio`, `frontier_llm`, `reasoning_extraction`, `general_harms` or none. Benign security or life-science work can trip the first two; verification programmes exist. Remove any instruction to write out reasoning in the reply (it triggers `reasoning_extraction`); read summarized thinking instead. Fallback targets are Opus 4.8 and Opus 5, and a model switch loses the 5.2 thinking.
- Keep history append-only: return assistant turns exactly as received, send changes as later messages or turn-scoped system messages, trim by context editing or compaction that leaves no earlier turns. A beta setting can drop mismatched thinking instead of failing, but dropped thinking is re-done and costs more output tokens, so treat it as a stopgap.
- Where to start, in order: set `high` explicitly and run evals at `medium` and `xhigh`; read the prompts, skills, agent files and notes you carry over; run your longest agentic tasks and note stops, needless approvals, silence, over-delegation and additions where you wanted restructuring; add one fix at a time and measure effect and token cost.
- Not restated on the 5.2 page: formatting, search at low effort, edit style, vision and the 5.1 scope notes. Check `claude-fable-5-1.md` and test them on 5.2.
