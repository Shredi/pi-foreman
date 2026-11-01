# Prompting Claude Sonnet 5.5

Source: https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-sonnet-5-5
Checked: 2026-11-01

Own-words digest. Sonnet 5 prompts should work unchanged. For the hardest long-horizon work an Opus model is the better pick. Read `claude.md` for the shared techniques.

## Contents

- Effort
- Initiative and scope
- Thinking and JSON output
- Progress updates
- Tool use and mid-turn messages
- Verification, tool names, vision, refusals

## Effort

Levels are recalibrated against Sonnet 5; run a fresh sweep. Start at `high` (the API default) unless the work is agentic or latency-sensitive: agentic coding and multi-step tool use at `medium` for well-specified tasks and `high` for harder ones; chat at `medium` or `low`. At `low` it keeps thinking short and may skip verifying a change; at `low` and `medium` on long agentic tasks it is more likely to stop and check in. Leave room in the output limit for thinking and stream long outputs. Reserve `xhigh` and `max` for measured gains. Lower effort to think less; asking in the prompt is unreliable. The per-message effort change keeps the cache and needs adaptive thinking.

## Initiative and scope

- At low and medium effort it may pause to confirm a plan, ask what it could answer itself, or stop after one part. Try higher effort first, or add a system-prompt line to keep working (keep your own rules for risky actions).
- It tends to add tests, docs and small helper files at every effort, more at higher levels. Add a paragraph that says what to do when the asked-for work is done (stop, no extras).
- At `xhigh` and `max` it may start its own review rounds, sometimes with subagents. Run routine work at `high` or below. A system-prompt line directing the thoroughness at the task itself stopped reviewer launches and cut cost by about a third with no quality change.
- On open-ended requests ("show me what you can do") it may start building; say you want ideas or a plan first.

## Thinking and JSON output

- The lowest thinking setting, `between_tools`, is accepted at `high` or below, cannot be combined with mid-conversation effort changes, and conflicts with "don't think" instructions (internal tags can leak into output). Read responses by block type; pass thinking blocks back unchanged.
- With structured outputs on a reasoning task the model can only work in thinking, and often skips it at low and medium. End the system prompt with a line asking it to think first, or use `xhigh`; use adaptive thinking, not `between_tools`. Treat an output-limit stop as a failure and retry. Without structured outputs, parse the last JSON value in the reply, check the fields, retry once.

## Progress updates

Notes longer than a sentence or two arrive as progress-update thinking blocks when the display setting asks for them (beta). Give it a send-message tool for exact text mid-turn, declared in the first request. Remove "hold all findings for the final response". Say in the system prompt if you want an intent line before the first tool call and a recap. A harness reminder after several silent steps (turn-scoped, appended, left in place, stopped after two or three) helps; harness text that is too frequent looks like injection.

## Tool use and mid-turn messages

- In chat and knowledge work it sometimes answers from training when a search would catch changed details. Remove "only use tools when strictly necessary" and add a line encouraging search for current details.
- It resists indirect injection and may treat a genuine mid-task user message as one when that message sits inside a tool result or is a system message right after one. Never put user text in a tool result. Send mid-turn input as a text block after the last tool result in the same user message, harness notices as a separate mid-conversation system message after the user's words, and no budget countdown after each tool result.

## Verification, tool names, vision, refusals

- At `low` it sometimes reports a change done without running a check that exercises it (for example skipping tests because dependencies are missing). A system-prompt paragraph requiring a check makes that rare, at slightly higher cost.
- It occasionally gets the case of a tool name wrong or renames a parameter. Accept unambiguous matches, or return an error naming the expected form; it corrects next turn.
- Complex images: crop, zoom or code on the image helps at every effort; tools beat raising effort for charts.
- Refusal categories: cyber, bio, frontier LLM, reasoning extraction, general harms. Remove instructions that ask for reasoning in the reply and read summarised thinking.
