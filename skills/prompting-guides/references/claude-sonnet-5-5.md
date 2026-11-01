# Prompting Claude Sonnet 5.5

Source: https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-sonnet-5-5
Checked: 2026-11-01

Own-words digest. Prompts tuned for Sonnet 5 transfer as they are. When the job is the most demanding kind of long-horizon work, choose an Opus model instead. Read `claude.md` for the shared techniques.

## Contents

- Effort
- Initiative and scope
- Thinking and JSON output
- Progress updates
- Tool use and mid-turn messages
- Verification, tool names, vision, refusals

## Effort

The levels were recalibrated relative to Sonnet 5, so rerun your sweep instead of reusing old picks. The API default, `high`, is the starting point unless the work is agentic or latency-bound. For agentic coding and multi-step tool use, pick `medium` when the task is well specified and `high` when it is harder; for chat, `medium` or `low`. At `low` the model keeps its thinking brief and may not verify a change. On long agentic tasks at `low` or `medium` it more readily halts to check in. Size the output limit so thinking fits, and stream long outputs. Keep `xhigh` and `max` for cases with a measured benefit. Reducing effort is the way to get less thinking; requesting it in the prompt is unreliable. A per-message effort change preserves the cache and requires adaptive thinking.

## Initiative and scope

- With `low` or `medium` effort the model may stop to confirm a plan, put a question it could resolve itself, or finish after one portion. First try more effort, or add a system-prompt line telling it to continue (retain your own rules for risky actions).
- Tests, docs and small helper files get added unasked at every effort level, and more at higher ones. Include a paragraph spelling out what happens once the requested work is complete (stop, nothing extra).
- At `xhigh` and `max` it can launch its own review rounds, at times through subagents. Keep routine work at `high` or lower. A system-prompt line pointing the diligence at the task itself ended the reviewer launches and cut cost by about a third with the same quality.
- Given an open-ended request ("show me what you can do"), it may begin building. Tell it you want ideas or a plan first.

## Thinking and JSON output

- `between_tools` is the lowest thinking setting. It works at `high` or below, cannot be mixed with mid-conversation effort changes, and clashes with any "don't think" instruction, which can leak internal tags into the output. Dispatch on block type when reading responses, and return thinking blocks as received.
- Combined with structured outputs, a reasoning task leaves the model only its thinking to work in, and at low and medium it frequently skips that. Finish the system prompt with a line telling it to think first, or choose `xhigh`. Prefer adaptive thinking over `between_tools`. A stop on the output limit is a failure: retry. When structured outputs are not in use, take the last JSON value in the reply, validate its fields and retry once on failure.

## Progress updates

When notes exceed a sentence or two, they surface as progress-update thinking blocks if the display setting requests them (beta). For exact wording mid-turn, give the model a send-message tool and declare it in the first request. Strike any "hold all findings for the final response" line. If you want an intent line ahead of the first tool call and a closing recap, say so in the system prompt. A harness reminder after several silent steps helps: scope it to the turn, append it, leave it in place, and stop after two or three. Overly frequent harness text reads as injection.

## Tool use and mid-turn messages

- In chat and knowledge work the model sometimes replies from training data where a search would surface changed facts. Delete "only use tools when strictly necessary" and add a line that encourages searching for current details.
- Because it is built to resist indirect injection, a real user message sent mid-task can be mistaken for one when it lands inside a tool result or as a system message directly after one. Keep user text out of tool results. Deliver mid-turn input as a text block following the final tool result in the same user message, put harness notices into their own mid-conversation system message that comes after what the user wrote, and skip budget countdowns after each tool result.

## Verification, tool names, vision, refusals

- At `low` the model may call a change finished with no check that actually exercises it (for example, skipping tests since dependencies are absent). A system-prompt paragraph that demands a check makes this uncommon, for slightly more cost.
- Now and then it writes a tool name in the wrong case or renames a parameter. Match unambiguous variants, or return an error stating the expected form; it fixes itself on the following turn.
- For complex images, cropping, zooming or running code on the image helps at every effort. For charts, tools do more than a higher effort level.
- Refusal categories: cyber, bio, frontier LLM, reasoning extraction, general harms. Drop instructions requesting reasoning in the reply and use summarised thinking.
