# Claude prompting: index and general techniques

Source: https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices
Checked: 2026-11-01

Own-words digest. Model names and behaviour are as stated on that date.

## Contents

- Model table
- General techniques
- Output and formatting
- Tool use
- Thinking
- Agentic systems
- Migration notes

## Model table

Each current model has its own page; read it before the general techniques. Pages exist for the Fable 5.1 and Fable 5 line (with Mythos), Sonnet 5.5 and 5, Opus 5.5, 5 and 4.8, and Haiku 5.5. This skill digests the current four:

| Model | Digest | What differs |
| --- | --- | --- |
| Fable 5.1 (and Mythos 5.1) | `claude-fable-5-1.md` | Effort levels, finishing long tasks, progress updates, history rules, batching tool calls |
| Opus 5.5 | `claude-opus-5-5.md` | Default effort, no thinking-off, unattended runs, time signals |
| Sonnet 5.5 | `claude-sonnet-5-5.md` | Effort calibration, scope and initiative, JSON on reasoning tasks, mid-turn messages |
| Haiku 5.5 | `claude-haiku-5-5.md` | Effort levels, search, early stopping, verification, chatbot adherence |

The fetched index also lists the earlier generation pages (Fable 5, Sonnet 5, Opus 5, Opus 4.8). For those, follow the general techniques below and check the source page.

## General techniques

These apply to all current Claude models; where a technique names one model, treat it as measured there and recheck elsewhere.

- Be clear and direct. Treat the model as a capable new colleague without your context. Key test: hand the prompt to someone with no background; if they would be confused, so will the model. Give sequential steps as a list when order or completeness matters.
- Give motivation. A reason behind a rule lets the model generalise from it.
- Examples are among the most reliable steering tools. Make them relevant, diverse (cover edge cases, avoid unintended patterns) and structured (wrapped in example tags so they are not mistaken for instructions).
- Structure with XML-style tags when a prompt mixes instructions, context, examples and input. Use consistent, descriptive tag names; nest where content nests.
- Set a role in one sentence in the system prompt.
- Long context (about 20k tokens and up): put the long data at the top, above the question; tag each document with its source; ask the model to quote the relevant parts first, then answer.
- If the app needs the model to know its own name or model string, state it in the system prompt.

## Output and formatting

- Recent models are more concise and direct and may skip a recap after tool calls. Ask for summaries or visibility if you want them.
- Steer format by saying what to do ("smoothly flowing prose paragraphs"), not what to avoid. Tags that mark the format section also work.
- The style of the prompt leaks into the output: a prompt without markdown tends to get less markdown.
- For detailed formatting wishes, give explicit guidance. On models that already format sparingly (Fable 5.1), a long anti-formatting block can remove structure the content needs.
- Models default to LaTeX for maths; ask for plain text if you want it.
- Prefilling the last assistant turn is not supported from the 4.6 generation on (it returns an error). Replace it with an instruction, structured output, or a tool.

## Tool use

- Models follow instructions precisely. "Can you suggest changes" may get suggestions, not edits; say "make the changes" when you want action. A system-prompt line can make the model proactive by default; the opposite line makes it wait for a request.
- Newer models respond more strongly to the system prompt. Aggressive emphasis written to fix undertriggering now overtriggers; use plain wording ("Use this tool when ...").
- Independent tool calls run in parallel by default. The rate can be pushed toward always, or damped, with a short instruction. On Fable 5.1 in long loops, re-send the instruction as a turn-scoped system message after each tool round.

## Thinking

- Adaptive thinking (the model decides how much) replaces manual token budgets on 4.6 and later; budget control moves to the effort setting. On Fable 5.1, Mythos, Fable 5 and Opus 5.5 thinking is always on. On Opus 5, Sonnet 5.5 and Haiku 5.5 it is on when you omit the parameter. Read content blocks by type, not position, and leave room in the output limit for thinking.
- Overthinking: replace blanket defaults ("always use the tool") with targeted ones, drop "if in doubt, use it", and use effort as the fallback dial. Asking in prose to think less is unreliable.
- Prefer general instructions ("think thoroughly") to hand-written step plans. Worked examples shape the model's own reasoning.
- Without thinking, ask for step-by-step reasoning and a tagged final answer. On models that always think, rely on thinking instead; a prompt asking to write reasoning into the answer may be declined.
- Ask for a self-check before finishing ("verify against these criteria"), except on Opus 5, which verifies unprompted and over-verifies if told.

## Agentic systems

- Long tasks: state that context will be compacted or saved so the model does not wrap up early near the limit. Across several windows: use a different first prompt to set up tests and scripts, track tests in a structured file, keep progress notes in plain text, use git for state, and prefer a fresh window that re-discovers state from files over compaction when the harness allows. Provide ways to verify (browser automation, tests).
- Autonomy and safety: models may take hard-to-reverse actions (delete, force-push, post externally) unless told to confirm first.
- Research: give success criteria, ask for cross-checking sources, and use a structured loop of hypotheses and critique for large corpora.
- Subagents: recent models delegate on their own. Describe subagent tools well. Some models over-spawn (a direct search would do); say when delegation is and is not warranted.
- Prompt chaining pays off when you want to inspect intermediate output; the common pattern is draft, review against criteria, refine.
- Over-eagerness: models may add files, abstractions or flexibility nobody asked for; ask for minimal solutions. They may also chase passing tests with hardcoding; ask for general solutions. To cut hallucinated code claims, tell the model to open the files before answering about them. Models may create scratch files; ask for cleanup if unwanted.

## Migration notes

When moving a prompt to a current model:

1. Say exactly what you want; add modifiers for quality or breadth if you want more than the minimum.
2. Ask explicitly for features such as animation or interactivity.
3. Replace manual thinking budgets with adaptive thinking plus effort. Budget parameters error out on 4.7 and later.
4. Remove prefill on the last assistant turn.
5. Tune down anti-laziness prompting; newer models are more proactive.
6. Pass thinking blocks back unchanged and keep the history append-only: from 5.1 on, editing earlier turns, rebuilding the system prompt or tools, or summarising old turns in place invalidates the later thinking blocks. Send changes as mid-conversation system messages and use server-side context management.
