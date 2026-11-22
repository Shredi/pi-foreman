---
# kebab-case, equal to the folder name
name: skill-name
# What it does, when to use it (quoted trigger phrases), what it is not for. One line, under 1024 characters.
description: "[What it does]. Use when asked to '[phrase]' or '[phrase]'. Not for [neighbouring job] (use [other skill])."
# optional: leave out to keep the skill always listed; search = found with tool_search (rarely used skills)
metadata:
  visibility: search
---

# [Skill title]

[One or two sentences: what the reader gets from this skill, and the one rule that matters most, with its reason.]

## Instructions

1. [First step, with the exact command or tool call.] Success looks like: [observable result].
2. [Next step.] If it fails, see Troubleshooting.
3. [Check step: prefer a script in `scripts/` over a prose check.] Success looks like: [observable result].

## Examples

Good:

> User: "[typical request]"
> Actions: [step 1], [step 2]
> Result: [what the user gets back]

Bad:

> User: "[request]"
> Actions: [what goes wrong, for example a skipped check]
> Why it is bad: [the rule it breaks]

## Troubleshooting

Error: [message or symptom]
Cause: [why it happens]
Solution: [what to do]

## References

- `references/[topic].md`: [what it holds and when to read it]
