# Skill best practices (digest)

Source: https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices
Checked: 2026-11-01

An own-words digest of Anthropic's guidance on writing skills. The source text is not copied here.

## Contents

- Concise and degrees of freedom
- Models to test with
- Structure
- Workflows and feedback loops
- Content
- Evaluation and iteration
- Skills with code
- Frontmatter limits
- Checklists

## Concise and degrees of freedom

- Context is shared with the conversation. The catalog line is always loaded, the body when the skill fires, other files only when read. Every body token competes with the task.
- Start from the assumption that the model is already capable. For each paragraph ask: does it need this, can it be assumed, does the paragraph earn its tokens? A three-line code sample beats a paragraph explaining what a PDF is.
- Match the freedom you give to how fragile the task is:
  - High (prose guidance): several valid routes, context decides, heuristics are enough. Example: code review.
  - Medium (pseudocode or a script with parameters): a preferred pattern exists, some variation is fine.
  - Low (an exact script, few or no parameters): fragile, consistency matters, one sequence must be followed. Example: a database migration.
  The picture: a narrow bridge with drops on both sides needs exact steps; an open field needs only a direction.

## Models to test with

A skill that works on a small model may over-explain for a large one. Check that the small model gets enough guidance, the mid model finds it clear and efficient, and the large model is not bored by explanation. Aim for wording that works on all you use.

## Structure

- Names: prefer the gerund form (`processing-pdfs`, `testing-code`); noun phrases and verb-first names are acceptable. Avoid vague words (`helper`, `utils`), over-generic ones (`files`, `data`), reserved words, and mixed patterns inside one collection. Lowercase letters, digits and hyphens only.
- Description: the only text read before the skill loads, and the model picks among possibly 100+ skills by it. Say what the skill does and when to use it, with the key terms a user would say.
- The body is an overview that points to detail, like a table of contents. Keep it under 500 lines in Anthropic's guidance (this repo uses 200).
- Patterns for splitting: a guide that links reference files; domain-split references (a sales question loads only the sales file); conditional detail ("for tracked changes, read the redlining file").
- Keep references one level deep from `SKILL.md`. Files linked from linked files may be read only in part.
- A reference file over 100 lines gets a table of contents at the top, so a partial read still shows the full scope.
- Scripts are run, not loaded: their code never costs context.

## Workflows and feedback loops

- Break complex work into numbered steps. For long ones, give a checklist the agent copies into its reply and ticks off. This works for non-code tasks too.
- Feedback loop: run a validator, fix what it reports, repeat. The validator can be a script or a style guide the agent compares against. It catches errors early and improves quality a lot.

## Content

- Leave out dated claims ("before month X use A, after use B"). Put superseded approaches in a short "old patterns" section.
- One term per concept, everywhere: always "field" or always "control", not a mix of synonyms.
- Templates: strict where the output feeds a parser, loose where adapting helps.
- Examples: input and output pairs show style and detail better than description.
- Conditional workflow: lead the agent through the decision points (if X do A, otherwise B).
- Do not offer many options where one default will do; state the default and the exception.

## Evaluation and iteration

Evaluation first, before long documentation:

1. Run the agent on representative tasks without the skill and note where it fails.
2. Write three scenarios that expose those gaps.
3. Record a baseline without the skill.
4. Write the minimum instructions that close the gaps.
5. Rerun, compare to the baseline, iterate.

Iterate with two agent instances: one (the author) helps design the skill, a fresh one uses it on real tasks. Watch the second, bring specifics back ("it forgot to filter test accounts"), apply changes, retest. Creating a skill: finish a task by hand first, notice the context you keep supplying, capture it, prune what the model knows, move bulky schema into a reference.

Watch how the agent navigates the skill:

- Unexpected reading order: the structure is not intuitive.
- Missed links: references are not explicit enough.
- One section read again and again: move it into the body.
- A file never opened: it is unnecessary or badly signposted.

Iterate on observation, not assumption. Name and description decide triggering.

## Skills with code

- Solve, don't defer: a script handles its own error cases instead of failing and leaving the agent to cope.
- No unexplained constants. If the author does not know why a value is right, neither will the agent. Document each parameter.
- Prefer a ready script over generated code: more reliable, cheaper, consistent. Say whether the agent should run it ("Run `x` to extract the fields") or read it as reference ("See `x` for the algorithm"); running is the default.
- Verifiable intermediate outputs (plan, validate, execute): for batch or destructive work, have the agent write a plan to a structured file, validate it with a script, then execute and verify. Validators should be specific ("field `signature_date` not found; available: ...").
- When inputs can be rendered as images, let the agent look at them.
- Do not assume tools or packages exist: list what is needed, say how to check or install. Some runtimes have no network or package installation.
- Paths use forward slashes always. File names describe content (`form_validation_rules.md`, not `doc2.md`).
- MCP tool references use the fully qualified form `Server:tool_name`, or this harness's `mcp__server__tool`, to avoid "tool not found".

## Frontmatter limits

`name`: at most 64 characters, lowercase letters, digits and hyphens, no XML tags, no reserved words. `description`: non-empty, at most 1024 characters, no XML tags.

## Checklists

Core quality
- [ ] Description is specific, has key terms, says what and when.
- [ ] Body is short; detail lives in separate files.
- [ ] No time-sensitive claims (or they sit in an old-patterns section).
- [ ] One term per concept.
- [ ] Concrete examples.
- [ ] References one level deep; progressive disclosure used.
- [ ] Workflows have clear steps.

Code and scripts
- [ ] Scripts solve problems instead of deferring them.
- [ ] Error handling is explicit and helpful.
- [ ] No unexplained constants.
- [ ] Required packages listed and checked.
- [ ] Scripts documented; forward-slash paths.
- [ ] Validation steps for critical operations.
- [ ] Feedback loops for quality-critical work.

Testing
- [ ] At least three evaluations.
- [ ] Tried on every model size you plan to use.
- [ ] Tried on real usage.
- [ ] Teammate feedback folded in.
