---
name: prompting-guides
description: Writes or reviews system prompts, role files (agents/*.md), instructions, skill bodies, launch briefs and tool descriptions for a given target model, using that model family's prompting guide. Use when asked to "write a system prompt", "write a role file", "review this prompt", "tune this prompt for <model>", "write a launch brief", "port this prompt to another model" or "remove instructions written for older models". Covers Claude (Fable, Opus, Sonnet, Haiku) and OpenAI GPT-6 (Luna, Sol, Terra). Not for choosing a model or ladder rung, and not for user-facing docs.
---

# Prompting guides

Prompt advice differs by model family and changes with each release. Pick the guide for the model that will read the prompt, then apply the rules every model shares.

## 1. Identify the target model family

The model that reads the prompt decides, not the model writing it.

- Role file or instruction: the model the role runs on (`docs/roles.md`, the role's `model` and the ladder rungs).
- Launch brief: the model named in the launch call.
- A prompt for an app or an API call: the model ID in that code.
- Unknown or mixed: ask which model reads it. If it cannot be settled, use step 2's fallback.

## 2. Read the one matching reference

| Target family | Read |
| --- | --- |
| Claude Fable 5.1 (also Mythos 5.1) | `references/claude-fable-5-1.md` |
| Claude Opus 5.5 | `references/claude-opus-5-5.md` |
| Claude Sonnet 5.5 | `references/claude-sonnet-5-5.md` |
| Claude Haiku 5.5 | `references/claude-haiku-5-5.md` |
| OpenAI GPT-6 Luna, GPT-6.1 Sol, GPT-6.1 Terra | `references/openai-gpt-6.md` (one section per model) |
| Another Claude model, or a family not listed | `references/claude.md`, general techniques only |

`references/claude.md` is the index of the Claude pages: the model table, the techniques shared by all current Claude models, and migration notes. Read it too when the prompt must work on more than one Claude model. Read only the file or section for your family, not all of them.

The reference pages are digests written on the date at their top. For the full source text in the foreman session only: when `foreman knowledge check` has run, read `<agentDir>/pi-foreman/knowledge/<id>.md` (ids `claude-prompting`, `claude-fable-5-1`, `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`, `gpt-6-luna`, `gpt-6-1-sol`, `gpt-6-1-terra`). If a digest looks stale next to a newer model, say so in the report.

## 3. Rules for every model

1. Be clear and direct. Test the prompt on a reader with no context: would they know what to do and what done looks like? If you want more than the minimum, ask for it.
2. Show the shape. One or two diverse examples of the wanted output steer format and tone better than a paragraph of rules. Mark them off from instructions (for example tags).
3. Say why. A reason lets the model apply a rule to cases you did not list.
4. Fix scope and stop conditions. State what is in the task, what is out, what counts as done, and when to stop, ask or escalate. Name the checks to run before reporting.
5. Phrase positively. Say what to do; keep a prohibition only for a hard limit, paired with the target behaviour.
6. Put long data first and the question last; give the role in one line; keep instructions and input separate.
7. Remove what the model no longer needs. Instructions written to push an older model (shouting emphasis, "if in doubt use the tool", "think step by step" on a model that always thinks, anti-laziness prods) can make a newer model overdo it. Delete a line the model already obeys by default.
8. Keep effort and reasoning settings in the runtime, not in the prompt text; the family reference says what the setting does.
9. Test the prompt on a few real tasks and compare with the old version before keeping a change.

For the wording of skill bodies and descriptions, also read the `skill-authoring` skill.

## 4. Checklist

- [ ] The target model family was named, and its reference read.
- [ ] Goal, scope, done condition and stop or escalation rule are stated.
- [ ] Rules carry their reason; examples are real and diverse.
- [ ] Phrasing is positive; no instruction written only for an older model remains.
- [ ] Verification the model should run is named.
- [ ] Output format is asked for in the shape wanted.
- [ ] Runtime settings (effort, thinking, API choice for tools) are not left to prose.
- [ ] The prompt was tried on real tasks.
