# Building skills: the Anthropic guide (digest)

Source: https://resources.anthropic.com/hubfs/The-Complete-Guide-to-Building-Skill-for-Claude.pdf
Checked: 2026-11-22

An own-words digest of the parts of Anthropic's "Complete Guide to Building Skills" that `references/skills-best-practices.md` does not cover. This is a digest, not verbatim: the source text is not copied here. Read the cached PDF in the foreman session when a detail matters.

## Contents

- Use cases first
- Use-case categories
- Success criteria
- Three kinds of test
- Choosing a pattern
- Pattern examples
- Troubleshooting

## Use cases first

Before you write any instructions, name two or three concrete jobs the skill should make possible. For each, write down:

- the trigger: the words a user types;
- the steps, and which tool or MCP server each step uses;
- the result the user should have at the end.

If you cannot write the three lines, the skill is not yet scoped. Ask what the user wants to finish, which multi-step path it takes, and which domain knowledge the steps need.

## Use-case categories

Anthropic sees three kinds of skill in practice:

1. **Document and asset creation.** Consistent output such as documents, slides, designs or code. Techniques: embedded style rules, output templates, a quality checklist before the final answer. Needs no external tool.
2. **Workflow automation.** A multi-step process that must run the same way every time. Techniques: numbered steps with a validation gate after each, templates for common shapes, a refinement loop.
3. **MCP enhancement.** Guidance that makes an MCP server's tools usable: the order of calls, the domain rules, the context the user would otherwise have to supply, and what to do when a call fails.

Name the category in your own notes. It tells you which section of the body carries the weight.

## Success criteria

Set targets before testing. Anthropic presents these as rough benchmarks; expect some judgement in the assessment.

Quantitative:

- The skill loads on most relevant prompts. Measure with 10 to 20 test prompts and count automatic loads.
- The workflow finishes in fewer tool calls and tokens than the same task without the skill.
- No failed tool calls per run. Count retries and error codes in the MCP logs.

Qualitative:

- The user does not have to steer the next step.
- The same request gives the same structure across three to five runs.
- A new user gets the result on the first try with the skill's own instructions.

## Three kinds of test

Keep the three apart; each answers a different question.

- **Triggering**: does it load for paraphrases, and stay quiet for unrelated work? This is the should and should-not list in the body.
- **Functional**: given a set-up, when the skill runs, are the outputs right, the calls successful, and the edge cases handled? Write each as given, when, then.
- **Comparison**: with and without the skill, on the same task, what changes in calls, retries, tokens and clarifying questions? Record both columns.

## Choosing a pattern

- **Problem-first**: the user states an outcome, and the skill chooses and orders the tools. Most workflow skills lean this way.
- **Tool-first**: the user already has a tool connected, and the skill teaches the best way to use it. Most MCP-enhancement skills lean this way.

Most skills mix the two. Pick the one that matches the first sentence of the user's request.

## Pattern examples

Each pattern has one short example. The shapes are illustrative, not templates to copy.

- **Sequential workflow.** Onboard a customer: create the account, set up billing, create the subscription, send the welcome note. Each step checks that the previous one succeeded before it runs.
- **Multi-MCP coordination.** Hand a design to development: export assets from the design server, store them in the file service, create tasks in the tracker, notify the team chat. Validate each phase's output before the next phase starts, and pass only the identifiers between phases.
- **Iterative refinement.** Draft a report, run a quality check against stated criteria, fix the gaps, repeat until the check passes, then finalise. The check is a script or a checklist, not a feeling.
- **Context-aware tool selection.** Store a file in the cloud drive for large files, in the team chat for small ones, and in the repo for code. A short decision tree picks the tool; the skill says why it chose it.
- **Domain-specific intelligence.** Before a payment is processed, run the compliance check; record the result in an audit trail; only then act. The rule comes before the action, every time.

## Troubleshooting

Common failures, grouped by symptom. Each has a likely cause and a first check.

- **Skill does not load.** The file is not named `SKILL.md` exactly (case matters), or the frontmatter does not parse. Check the file name, then quote any description that contains a colon.
- **Skill loads too often.** The description is generic ("helps with documents"). Name the object and the trigger phrases, and add a "not for" clause.
- **Skill loads but MCP calls fail.** Test the server without the skill: ask for the same call directly. If it fails, the problem is the server, its connection or its credentials, not the skill. Check the tool names too; they are case-sensitive.
- **Skill loads but steps are skipped.** Instructions are long or buried. Put the critical checks first, in a short numbered list, with their reasons. A check that must hold is better as a script than as a sentence.
- **Output is lazy or shallow.** Ask for the depth in the request, not in the skill body; a general push for thoroughness in the skill adds little.
- **Responses slow down.** The body or the references are too large, or too many skills are visible at once. Move detail into references and keep the number of always-on skills small.
