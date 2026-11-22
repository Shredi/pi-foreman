---
name: skill-authoring
description: Writes, restructures and debugs agent skills (a folder with a SKILL.md) in any skill dir, whether this repo's skills, another project's .agents/skills, or the user's skill dir. Use when asked to "write a skill", "create a new skill", "convert this prompt to a skill", "review this skill", "my skill doesn't trigger", "skill triggers too often", or "give a role a skill". Covers folder rules, naming, description wording, progressive disclosure, degrees of freedom, scripts, evals, trigger tests, and how a Pi role gets a skill. Not for writing one-off prompts, project docs or tool extensions.
---

# Skill authoring

A skill is a folder the agent reads on demand. Only a one-line catalog entry (name, description, location) is always in context; the body is read when the task matches; references are read when the body points at them.

Beyond this page: for the fuller Anthropic guidance and its three checklists (core quality, scripts, testing), read `references/skills-best-practices.md`. When you need the guide's use-case categories, success criteria, pattern examples or troubleshooting, read `references/skills-guide.md`. When the skill is mostly prose guidance or the question is how to word a pointer, prune a body or phrase rules, read `references/writing-for-agents.md`. For the full source text in the foreman session only: when `foreman knowledge check` has run, read `<agentDir>/pi-foreman/knowledge/<id>.md` (a PDF id is `<id>.pdf`; ids `skills-best-practices`, `writing-for-agents`, `skills-guide`).

## Skill or role?

Write a skill by default. A skill loads only when its task matches and combines with other skills. A role costs a launch, a context and a config entry, so add one only for:

| You need | Do | Why |
|---|---|---|
| Domain facts, a playbook or a recurring procedure | Skill | loaded on demand, shared by every role that names it |
| MCP tools for a child | Role ceiling `roles.<id>.mcp`, plus `mcp: [...]` on the launch | MCP servers attach to the launched child, not to the skill |
| A distinct generic role: another model tier, a tool fence or an output contract | Role entry in config | the only case that needs its own role |

The generic role ids are `foreman` (the main session), `explorer` (read-only search), `builder` (one scoped change) and `reviewer` (review of a diff or plan). Explorer and reviewer deny `mcp__*` by default, so MCP work goes to a builder. A role body holds the role, its output contract and the skills it names; domain facts stay in the skill.

Set the role in the user or overlay config (project and session values of these two keys are ignored):

```json
{
  "roles": {
    "builder": {
      "skills": ["<skill-name>"],
      "mcp": ["<server-name>"]
    }
  }
}
```

Set the model under `providers.<p>.roles.<role>.model`, never under `roles.<id>`. Then ask for the launch with the skill and the servers the child needs, for example: launch a builder with `mcp: ["<server-name>"]` and this skill. Run `foreman setup` after a change to `skills`.

## Folder rules

- The directory name is the skill name: lowercase `[a-z0-9-]`, no leading, trailing or double hyphen, at most 64 characters.
- `SKILL.md` is required. Optional siblings: `references/` (long docs), `scripts/` (runnable helpers), `assets/` (templates, fixtures).
- `SKILL.md` starts with YAML frontmatter, then Markdown. Keep `name` equal to the directory name.
- One skill, one job. Two unrelated jobs are two skills.
- No `README.md` in the skill folder: the body and `references/` carry the documentation.

## Name and description

The description is the only text the agent sees before deciding to load the skill. It carries the whole trigger.

- Third person, present tense: "Writes release notes", not "I write" or "Use this to".
- Say what it does, then when to use it, with the phrases a user would actually type, in quotes.
- Say what it is not for, to cut false triggers.
- Stay under 1024 characters; one to three sentences is enough.
- Weak: "Helps with documents." Strong: "Converts a CSV export into a changelog table. Use when asked to 'format the export', 'build the changelog table'. Not for editing the CSV itself."

## Progressive disclosure

1. Catalog line: name and description. Always loaded, so keep it short.
2. Body: the workflow the agent follows. Aim for under 200 lines.
3. References: detail needed only in some cases (API tables, long examples, edge cases). Link them from the body with the condition: "For the field list, read `references/fields.md`." Keep links one level deep.

Move text out of the body when only some runs need it. Never repeat the description in the body. A reference over 100 lines starts with a table of contents, so a partial read still shows its scope.

## Writing the content

### Keep only what the model lacks

Assume the model is already smart. For each paragraph ask: does it need this, would it do this by default, does the paragraph earn its tokens? Delete a sentence the model obeys without being told (the no-op test); delete the whole sentence, not a word. If you cannot tell, run the skill with and without the line and compare.

### Degrees of freedom

Match how exact the instruction is to how fragile the task is.

- High: prose guidance. Several routes are valid and context decides (code review, research).
- Medium: a preferred pattern, a parameterised script or pseudocode. Some variation is fine.
- Low: an exact script, few or no parameters. The task is fragile or must be consistent (a migration, a format conversion).

### Words and names

- Prefer gerund names (`processing-pdfs`, `testing-code`) and one pattern across a collection. Avoid `helper`, `utils`, `tools`, and reserved words.
- One term per concept, everywhere: not field, box and control for one thing.
- Keep dated claims out. Put superseded approaches in a short "old patterns" section.
- State rules as the behaviour wanted ("write one-line comments"), not as prohibitions: a banned behaviour named in context becomes more likely. Keep a prohibition only for a hard guardrail, and pair it with the target.

### Pointers and load

- The wording of a pointer (a description, or a line that names a doc) decides when its target is reached. If a must-read file is missed, sharpen the pointer first; inline the file only if that fails.
- Lead with the distinctive word, give one trigger per distinct case, drop identity the body already carries.
- A line in the always-loaded context (a description, an `AGENTS.md` line) costs tokens every turn. Prune it harder than a body.
- The environment is a source of truth (config files, `--help`, directory layout, `package.json` scripts). A doc that restates it is a cache that goes stale. Write down what looking cannot find: the unwritten convention, the reason for a choice, the gotcha.

### Scripts and checks

- A script solves problems, with its own error handling; it does not fail and leave the agent to cope.
- No unexplained constants: if you cannot say why a value is right, the agent cannot either. Document each parameter.
- Say whether to run the script or read it; run is the default. List packages it needs and how to check them.
- Feedback loop: run the validator, fix what it reports, repeat. A style guide to compare against also works as the validator.
- For batch or destructive work, make the intermediate output verifiable: write a plan to a structured file, validate it with a script that names the problem and the valid options, then execute and verify.
- Paths use forward slashes always. Name MCP tools fully qualified (`Server:tool` in the API form, `mcp__server__tool` in this harness).

## Patterns

- **Step workflow**: numbered steps, each one action with a visible result. Put the decision points in the step where they occur.
- **Checklist**: for a task with many small must-dos, a list the agent ticks off before it reports done.
- **Examples**: one good and one bad input/output pair beats a paragraph of rules. Use real shapes, not placeholders.
- **Script wrapper**: when a step must be exact (a parse, a conversion, a lookup), put it in `scripts/` and tell the agent to run it and read its output, not to reimplement it. Document arguments and exit codes in the body in one line.
- **Defaults and escape hatches**: state the default path first, then the exception and its condition.
- **Multi-MCP coordination**: one phase per server; pass identifiers between phases and validate each phase before the next starts.
- **Context-aware tool selection**: a short decision tree picks the tool from the context, and the skill says why it picked it.
- **Domain rules before action**: check the domain rules (compliance, safety, naming) before the first write, and say what was checked.

Body shape: Instructions (numbered steps, each with a success check), Examples (one good and one bad pair), Troubleshooting (Error, Cause, Solution) and References. `assets/SKILL-template.md` is the fill-in skeleton.

Write instructions as imperatives. Explain why a rule exists when the reason changes what the agent does in edge cases.

## Testing

Trigger tests, run after every description edit:

1. Write three prompts that should load the skill and three that should not. Include near misses that share vocabulary with it.
2. Make the skill visible (a placement above, or `roles.<id>.skills` for a child role). Run each prompt headless in a fresh session:

   ```bash
   pi -p --no-session --mode json "<prompt>"
   ```

   Text mode prints only the final answer, so read the JSON event stream: a hit is a `read` tool call on the skill's `SKILL.md` path.
3. Pass at five of six. A should-prompt that misses needs the missing phrase in the description; a should-not prompt that fires needs a "not for" clause or a narrower verb.
4. Description probe: ask "When would you use the <skill-name> skill?" Whatever the answer leaves out is missing from the description.
5. Fix by symptom. Undertriggering: add the phrases users type, technical terms and file types. Overtriggering: add a "not for" clause that names the right skill, narrow the verbs, drop generic ones such as "helps with". Instructions ignored: move the key rule to the top of Instructions, shorten the body, move detail into `references/`, or turn the prose check into a script.

Behaviour test: run one realistic task in a fresh session with the skill loaded. Check that the output follows the steps and that the agent read only the references it needed. Fix the body where it deviated, then rerun the trigger set.

Evals first, before long documentation:

1. Run representative tasks without the skill; note where the agent fails.
2. Write three scenarios that expose those gaps.
3. Record the baseline without the skill.
4. Write the minimum instructions that close the gaps.
5. Rerun against the baseline and iterate.

Watch how the agent moves through the skill, then fix from what you see: an odd reading order means the structure is unclear; a missed reference means the link is vague; a section read every time belongs in the body; a file never opened is dead weight or badly signposted. Where cost matters, try the skill on each model size you will use.

## Checklist

- [ ] Directory name is lowercase `[a-z0-9-]` and equals `name`.
- [ ] Description: third person, what and when, quoted trigger phrases, a "not for" boundary, under 1024 characters.
- [ ] Body under about 200 lines; long detail lives in `references/`, linked with a condition.
- [ ] Steps are imperative, one action each.
- [ ] Scripts have a documented call and are run, not retyped; no unexplained constants.
- [ ] Every line passes the no-op test; one term per concept; no dated claims outside an old-patterns section.
- [ ] Paths use forward slashes; MCP tool names are fully qualified.
- [ ] Three evals and a baseline exist for anything non-trivial.
- [ ] Should-trigger and should-not-trigger prompts were run; results recorded.
- [ ] One behaviour run followed the steps.
- [ ] No secrets, personal paths or machine names in the skill.
- [ ] MCP work is stated as a launch with `mcp: [...]` on the role, not as a skill setting.
- [ ] No domain facts in a role body; the role names the skill that holds them.
- [ ] `metadata.visibility: search` considered for a rarely used domain skill.
- [ ] Per-model wording follows `skills/prompting-guides`; no per-model notes are kept here.

## Pi

How the Pi harness (and the pi-foreman package on top of it) loads a skill.

### Giving a role a skill

- Name the skill in `roles.<id>.skills` on the user layer or an overlay. Project and session layers are ignored, because a skill is instructions the role follows.
- A child role gets only the skills it names. `inheritSkills` stays off, so other installed skills are not listed.
- The child sees the catalog entry (name, description, location), not the body. It reads the body with the `read` tool when the task matches, so the description must carry the trigger.
- Run `foreman setup` after changing `skills`: it renders the read permissions for the named skill dirs. Shell reads are scoped per role; the `read` tool sees the union of all named skills.
- Residual: a skill shipped by a package under `{agentDir}/npm/node_modules`, or from a path in settings `skills`, still asks when a child reads its body.

### Always on or searchable

With pi-foreman a skill is either listed in every prompt (always on) or left out of the list and found with `tool_search` (searchable). Searchable saves the catalog line in every turn; the cost is that the agent must think to search.

- Always on: a skill a session needs before it knows to search, such as a routing or safety skill, or one used in most sessions.
- Searchable: a domain skill used in a minority of sessions. The retro says which skills were read rarely.

Mark a skill searchable in its own frontmatter:

```yaml
metadata:
  visibility: search
```

Anything else, or no `metadata`, keeps the skill always on. The config keys `skills.visible` and `skills.hidden` (globs of skill names) override the frontmatter; a non-empty `skills.visible` makes every other skill searchable. A searchable skill keeps its `/skill:<name>` command.

### Placement and precedence

Highest first:

1. Project skills: `<repo>/.agents/skills` (also collected from ancestor directories) and `<repo>/.pi/skills`. They load only when the project is trusted.
2. User skills: `~/.agents/skills` and `<agentDir>/skills`.
3. Package skills: the paths in the package's `package.json` `pi.skills`.

When two skills share a name, the earlier one wins. Pi's loader takes the frontmatter `name` and falls back to the directory name; the subagent role resolver matches by directory name, so keep the two equal.

### Frontmatter the loader honours

`name`, `description`, `disable-model-invocation` (hides the skill from the catalog; it is then used only when named explicitly). `metadata` is ignored by Pi; pi-foreman reads `metadata.visibility` (see above). Other keys (`compatibility`, `allowed-tools`, `context`, `agent`) are ignored silently. A YAML error drops the skill and logs a warning, so check the warning when a skill is missing. Quote a description that contains a colon followed by a space: YAML reads an unquoted one as a nested key and fails. A description over 1024 characters warns.

### Trigger-test recipe

The trigger-test recipe is under Testing above. Use its `--mode json` form: `--no-session` keeps no transcript, so the read shows only in the event stream.
