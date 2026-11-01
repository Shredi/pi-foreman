# Prompting Claude Opus 5.5

Source: https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5-5
Checked: 2026-11-01

Own-words digest. Opus 5 prompts should work unchanged. The model writes faster and finishes the same task with fewer tokens. Read `claude.md` for the shared techniques.

## Contents

- Effort
- Prompts written for thinking off
- Unattended runs
- Progress updates
- Context, time and chat
- Safeguards, injection, vision, frontend

## Effort

Thinking is always on, so effort is the first setting to adjust. The default is `medium` (Opus 5 defaulted to `high`); set it explicitly and run a sweep. `medium` matches or beats Opus 5 at `high` on coding evals; `low` comes close at much lower cost. It thinks more per turn at a given level, especially at `xhigh` and `max`, so leave generous room in the output limit and reserve those levels for measured gains. Lower effort rather than asking in the prompt for less thinking. Changing top-level effort invalidates the cache; use the per-message effort change mid-conversation.

## Prompts written for thinking off

Turning thinking off is rejected. If a prompt depended on that: start at `low` and measure; "answer directly without deliberating" can trim further. Remove lines that stood in for thinking (write your reasoning in the answer); read summarised thinking instead. Prompts that push reasoning into the reply may be declined as reasoning extraction. Drop any no-thinking rule. Read responses by block type, since the first block may be an empty thinking block.

## Unattended runs

Long multi-part tasks make the model write progress notes, and some of those turns end on text alone. A text-only ending tells you what the model reported; it does not show the work is complete.

- Track the task's parts in a checklist that the model keeps current.
- When a turn ends while items remain open and no blocker was stated, reply with a short message listing them, or have a smaller model test the completion condition whenever a turn ends. Cap automatic continuations at two or three.
- Wait for background commands and subagents before calling the task done.
- A system-prompt paragraph naming the early stops to avoid (and the legitimate ones, such as needing the user) reduces them. Add it from the first request, omit it where a human is in the loop, keep confirmation for risky actions, and expect more tool calls.

## Progress updates

Four levers: receive progress-update thinking blocks; declare a simple send-message tool from the first request for verbatim mid-turn text; state in the system prompt whether you want an intent line ahead of the first tool call and a recap at the close; and add a harness reminder after several silent tool steps (for example five), as a turn-scoped system message left in place, stopping after two or three. The reminder roughly halved long silent stretches.

## Context, time and chat

- On loosely specified tasks across several apps, one sentence telling it to look through the relevant sources first raised completion. Keep untrusted content out of the searched records.
- Elapsed-time information strongly affects its behaviour. In multi-agent harnesses, end each message with a line stating the time budget ("elapsed 340s / 1200s"). The model paces itself to land within that figure, typically well ahead of it, so set the budget higher than the finish time you want. With no budget, display elapsed time and add one system-prompt sentence. Treat the signal as advisory: retain your own timeout and review quality.
- Delete "think carefully before answering" from chat prompts, since effort governs depth. Over several chat turns the model may revisit its previous answers. Two sentences declaring those answers settled curb the habit, though it then points out its own past errors less often. Skip them for agentic work.

## Safeguards, injection, vision, frontend

- Safeguard classifiers (biology, cybersecurity with vulnerability finding allowed, reasoning extraction) return a refusal stop reason; server-side fallback retries all but reasoning extraction.
- To resist instructions hidden in pasted text, wrap each pasted block in matching open and close tags carrying the same random ID on their own lines, and add a system-prompt note. Tags can be imitated, so it is one guardrail among several.
- Retest scaffolding built for weaker vision: higher-resolution images and image tools (crop, zoom, a container with an imaging library) still help the densest inputs, and work better at higher effort.
- Telling it to "avoid a generic AI look" only trades one default for another. List concrete patterns to steer clear of, and extend that list as you iterate.
