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

On long multi-part tasks it writes progress notes, some of which end the turn with text only. Treat that as a report, not proof of completion.

- Keep the task's parts in a checklist the model updates.
- If a turn ends with open items and no stated blocker, send a short message naming them, or let a smaller model check the completion condition at each turn end. Stop after two or three automatic continuations.
- Wait for background commands and subagents before calling the task done.
- A system-prompt paragraph naming the early stops to avoid (and the legitimate ones, such as needing the user) reduces them. Add it from the first request, omit it where a human is in the loop, keep confirmation for risky actions, and expect more tool calls.

## Progress updates

Four levers: receive progress-update thinking blocks; declare a simple send-message tool from the first request for verbatim mid-turn text; say in the system prompt if you want an intent line before the first tool call and a recap at the end; and add a harness reminder after several silent tool steps (for example five), as a turn-scoped system message left in place, stopping after two or three. The reminder roughly halved long silent stretches.

## Context, time and chat

- On loosely specified tasks across several apps, one sentence telling it to look through the relevant sources first raised completion. Keep untrusted content out of the searched records.
- It responds to elapsed-time information. In multi-agent harnesses give a time budget as a line at the end of each message ("elapsed 340s / 1200s"); it paces itself to finish inside it, usually well before, so set the budget above your target. Without a budget, show elapsed time and add one sentence. The signal is advisory; keep your own timeout and check quality.
- In chat prompts remove "think carefully before answering"; effort is the control. In multi-turn chat it may re-examine earlier answers; two sentences telling it to treat them as settled reduce that, at the cost of flagging its own earlier mistakes less. Leave them out for agentic work.

## Safeguards, injection, vision, frontend

- Safeguard classifiers (biology, cybersecurity with vulnerability finding allowed, reasoning extraction) return a refusal stop reason; server-side fallback retries all but reasoning extraction.
- To resist instructions hidden in pasted text, wrap each pasted block in matching open and close tags carrying the same random ID on their own lines, and add a system-prompt note. Tags can be imitated, so it is one guardrail among several.
- Retest scaffolding built for weaker vision: higher-resolution images and image tools (crop, zoom, a container with an imaging library) still help the densest inputs, and work better at higher effort.
- "Avoid a generic AI look" swaps one default for another; name specific patterns to avoid and grow the list.
