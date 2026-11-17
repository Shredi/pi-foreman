# Agent design: instructions, roles, skills, gates, and when to use agents at all

Source: https://resources.anthropic.com/hubfs/Building%20Effective%20AI%20Agents-%20Architecture%20Patterns%20and%20Implementation%20Frameworks.pdf
Source: https://code.claude.com/docs/en/best-practices.md
Source: https://code.claude.com/docs/en/memory.md
Source: https://code.claude.com/docs/en/skills.md
Source: https://code.claude.com/docs/en/sub-agents.md
Source: https://code.claude.com/docs/en/hooks-guide.md
Source: https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5-2
Checked: 2026-11-17

Own-words digest, one rule per line, each ending with the section it comes from. Use it as a checklist when you edit `AGENTS.md`, `instructions/*`, `agents/*.md`, a `SKILL.md` or an adapter gate, and when you decide whether a task needs more than one agent. Section (a) is the agents PDF; section (b) is Claude Code's pages, translated to Pi. This page rules nothing for pi-foreman: the tiers and gates are this harness's own choice. For how to word a prompt for one model, read that model's page.

## Contents

- The rule behind the rest
- (a) Agents PDF: when and how to use agents
- (b) Claude Code pages, translated to Pi
  - Instruction files (`AGENTS.md`, `instructions/*`)
  - Skills
  - Roles and subagents (`agents/*.md`)
  - Gates and hooks
  - Checks and unattended runs
  - Pi translation table
  - Does not carry over

## The rule behind the rest

1. Instruct with the reason first. A line the model can apply to cases you did not list beats a bare command, and most guidelines have exceptions that the model, with the code in front of it, judges better than a rule written in advance. (Best practices: Deterministic and non-deterministic instructions; `claude.md`: Give motivation)
2. Enforce in code only what has no exceptions and does harm when missed. A deny rule, gate or hook runs every time whatever the model decides, so it is the place for "never edit the generated client" and "always run the check before finishing". (Best practices: Enforce the rules that can't have exceptions)
3. Drop enforcement that only polices a preference. A gate that fires when it should not costs a refusal plus upkeep; if you are at dozens of them, most are preferences the agent could weigh itself. (Best practices: Deterministic and non-deterministic instructions; Choose who a rule applies to)
4. A line that keeps being missed despite added emphasis is one of two things: a rule for code (rule 2) or a file grown too long to be read. Do not add capitals. (Best practices: Keep CLAUDE.md short; What you can stop doing)
5. Write "ask before X" where X has exceptions, not "never X": a recent model reads "never" as absolute and holds back work it should do. Keep "never" for what code enforces. (Prompting Fable 5.2: Keep caution from piling up; see `claude-fable-5-2.md`)

## (a) Agents PDF: when and how to use agents

Start small

1. Begin with a single-purpose agent that does one thing well and grow it from measured need; simple systems cost fewer tokens, debug more easily and give metrics tied to outcomes. (PDF: Agent design best practices)
2. Match the model to the job: the most capable model for hard coding or analysis, a lighter one for routine high-volume work; a premium model on a simple task is slower and costlier at scale. (PDF: Choose the right model for the job)
3. Add complexity only when it brings measurable value; the best architecture is the simplest one that meets today's needs and leaves a path forward. (PDF: Pattern selection guide; Decision framework)
4. Do not over-engineer: straightforward repeatable work is served by one well-designed agent. (PDF: Decision framework, complexity question)
5. Evolve in steps (one agent, then routing, then specialists, then coordination, then evaluators) and prove value at each step. (PDF: Real-world evolution)

Skills before agents

6. Package domain knowledge and standard procedures as skills instead of encoding them in the prompt; skills load when needed and work in single- and multi-agent set-ups. (PDF: Extend capabilities with Agent Skills)
7. Before moving to several agents, try specialist skills on one agent: they may meet the accuracy you need at far lower cost and complexity. (PDF: Single-agent systems, When to avoid; Skills)
8. If you do split, give each agent the skills of its specialty and only the tools its task needs. (PDF: Multi-agent systems, Architecture overview; Practice modular design)

When one agent is enough, and when it is not

9. A single agent suits open-ended problems where the steps are not known up front. (PDF: Single-agent systems, When to use)
10. Several agents suit work that has outgrown one: open-ended with the need to pivot, expertise that overwhelms a generalist (single agents degrade sharply once two or more distractor domains are present), or broad queries with independent directions worth running in parallel. (PDF: Multi-agent systems, When to use)
11. Multi-agent systems use roughly 10 to 15 times the tokens of a single agent; work out the cost at expected volume before committing, and scale effort so simple requests never trigger the expensive path. (PDF: Decision framework, resource constraints; Multi-agent systems, Implementation considerations)
12. Where decisions must be explained and audited (compliance, money, safety), start with one agent or a sequential workflow; several agents blur who decided what. (PDF: Decision framework, control question)
13. A single agent ships in weeks, a multi-agent system takes months to get right; under time pressure build one agent and plan the path. (PDF: Decision framework, time-to-market)
14. Let a simple agent handle routine cases and escalate to a multi-agent path only for edge cases; that keeps cost down and capability available. (PDF: Hybrid architecture strategies)

Patterns, when each fits

15. Sequential workflow: fixed subtasks with clear dependencies and a need for audit trails; skip it for a few stages one agent can do, or when work needs backtracking. (PDF: Sequential workflows)
16. Parallel workflow: independent subtasks or several views for confidence; skip it when agents build on each other, share state with no conflict rule, or aggregation is too complex. (PDF: Parallel workflows)
17. Evaluator-optimizer: only with clear criteria and demonstrable gain from iteration; skip it when the first attempt is enough, criteria are subjective, or a deterministic check exists. (PDF: Evaluator-optimizer)
18. Supervisor design: treat subagents as tools the supervisor calls and keep the conversation with the supervisor. (PDF: Hierarchical/supervisory systems)
19. Collaborative (peer) systems: set division of labour and effort budgets rather than strict instructions; stop agents bouncing tasks forever and define conflict resolution. (PDF: Collaborative systems, Key challenge)
20. Dynamic agent creation at run time is experimental; no production system was reported using it. (PDF: Emerging patterns)

Context and observability

21. Context management is the main limit of a supervisor: clear stale tool results near the limit, keep memory outside the window in files, and cap tool output with pagination, filtering and truncation (the PDF names about 25,000 tokens). (PDF: Hierarchical systems, Key challenge)
22. Build observability in from day one: trace prompts, decisions, retrieval, token use and how agents hand off; with several agents it is the only way to find a coordination failure. (PDF: Build observable systems; Multi-agent systems, Observability)
23. Keep prompts in central configuration and tools as reusable modules so a better prompt or tool rolls out everywhere. (PDF: Practice modular design)

## (b) Claude Code pages, translated to Pi

In Pi, `CLAUDE.md` is `AGENTS.md`. The rules below are Claude Code's, kept where they hold for any agent harness.

### Instruction files (`AGENTS.md`, `instructions/*`)

24. Write down only what the agent cannot find by reading the repo, or would spend time rediscovering each session; test: could it find this, and would it actually look? If both, cut it. (Best practices: Tell Claude what it can't see)
25. Good content: the commands that confirm work and how to run one test, places where the code misleads, decisions made outside the repo, anything corrected twice. (Best practices: Keep CLAUDE.md short; Memory: When to add to CLAUDE.md)
26. Do not describe architecture or file layout the agent reads itself. (Best practices: What you can stop doing)
27. Every line costs attention on every task, so shorter is better; the Claude Code guide aims under about 200 lines per file, and imports split a file without lowering its context cost. (Best practices: Keep CLAUDE.md short; Memory: Write effective instructions)
28. Make lines concrete enough to check ("run `npm test` before committing", not "test your changes"). (Memory: Write effective instructions)
29. Contradictory lines are resolved arbitrarily; sweep every instruction file for conflicts and for lines written for older models or pointing at files that no longer exist. (Memory: Write effective instructions; Audit your instruction files)
30. A multi-step procedure, or a rule for one part of the code, belongs in a skill or a narrower file, not in the always-loaded file. (Memory: When to add to CLAUDE.md)
31. An instruction that must run at a fixed point (before every commit, after every edit) is a hook or gate, not a sentence. (Memory: Claude isn't following my CLAUDE.md)
32. A rule given only in conversation is lost at compaction; put what must persist in the file. (Memory: Instructions seem lost after /compact)
33. Drop old workarounds for older models: aggressive context management, capital-letter emphasis, "think hard", "keep going, don't be lazy". Effort and a check to pass replace them. (Best practices: What you can stop doing)
34. Cautions pile up in notes and instruction files; when a reason no longer holds, delete the line. (Prompting Fable 5.2: Keep caution from piling up)

### Skills

35. Put team knowledge and procedures a model cannot guess (how a release is cut, an incident runbook) in a skill: only name and description sit in context, the body loads when the task calls for it. (Best practices: Put team procedures in skills)
36. The same test applies as for instruction files: write only what the agent cannot find on its own. (Best practices: Put team procedures in skills, note)
37. Lead the description with the key use case and the words a user would say; the listing is length-capped (1,536 characters combined in Claude Code, under 1,024 in this repo) and long lists drop descriptions. (Skills: Frontmatter reference; Skill descriptions are cut short)
38. Not triggering: add the user's own keywords to the description. Triggering too often: make it more specific. (Skills: Skill not triggering; Skill triggers too often)
39. Keep `SKILL.md` under 500 lines and move detail into reference files that `SKILL.md` names, with when to read each. (Skills: Add supporting files)
40. Once loaded, the body stays in context and is not re-read; write guidance that holds for the whole task, not one-time steps. (Skills: Skill content lifecycle; Claude stops following a skill)
41. After compaction only the start of a skill survives, so the most important instructions go first. (Skills: Skill content lifecycle)
42. A rule that must hold every time does not belong in a skill; make it a hook or gate and let the skill carry the judgment. (Skills: Claude stops following a skill)
43. Frontmatter must start on the first line and parse; if it does not, the body loads with no metadata and the description never matches. (Skills: Frontmatter reference; Skill not triggering)

### Roles and subagents (`agents/*.md`)

44. A role file is the child's whole system prompt; its tool list is enforced by the harness, not requested in prose. A reviewer limited to read tools cannot edit. In Pi that is the `tools:` frontmatter of `agents/*.md` and `roles.<role>.tools`, with `roles.<role>.denyTools` for denies. (Best practices: Know what subagents cost; Sub-agents: Restrict which tools a subagent can use)
45. The description says when to delegate to the role; keep it short, since all of them are loaded and capped in total. (Sub-agents: Understand automatic delegation)
46. A child starts with a fresh context and sees none of the conversation; the brief is all it has. In Claude Code a child still gets the project instruction files; a Pi child launches without `AGENTS.md` and, unless its role names skills, without the skill catalog, so restate the rules the task needs in the brief. (Sub-agents: Manage subagent context, What loads at startup)
47. Give a child the skills it needs: `roles.<role>.skills` for a standing set, or the `skill` key of the `subagent` call for one launch (see `docs/roles.md` for what a child can read). Preloading puts the skill in; it does not restrict what else the child may read. (Sub-agents: Preload skills into subagents)
48. Subagents earn their cost for parallel work, noisy output kept out of the main context, an independent reviewer, or a narrower tool set. (Best practices: Know what subagents cost)
49. They cost tokens (each sends its own requests) and sometimes time (a fresh child must regather context), and a child on the same model gives parallelism or fresh eyes, not a smarter answer. (Best practices: Know what subagents cost; What you can stop doing)
50. Use the main conversation for back-and-forth, phases that share context, a quick targeted change, or when latency matters. (Sub-agents: Choose between subagents and main conversation)
51. Put simple jobs on a cheaper model and ask for short summaries back. In Pi the model comes from the provider's role map and the ladder, not the role file. (Best practices: Know what subagents cost)
52. A reviewer helps because it has not seen the reasoning behind the code; hand it the spec, name what to check and say "skip style", or it will always find something and each fix adds layers. (Best practices: Review against your spec; What you can stop doing)
53. Do not tell a recent model to delegate by default; it delegates readily, so state in the tool or role description what a child costs and when it pays. (Prompting Fable 5.2: Set expectations for subagents)

### Gates and hooks

54. A hook or gate runs every time its event fires, whatever the model decided; a prompt, an instruction file or a skill is advice the model may skip. In Pi the hooks are extension events (`tool_call`, `agent_before_settle`, `session_compact` and others) and the adapter gates built on them, such as the stop gate. (Hooks guide: intro; Best practices: Deterministic and non-deterministic instructions)
55. Deny at the tool call, before any permission overlay, so the deny holds in every mode. (Hooks guide: Hooks and permission modes)
56. A gate decided by a model (a prompt or agent hook, an auto-mode classifier) is judgment, not enforcement; "never" rules belong in a deterministic gate. (Best practices: Enforce steps with hooks; Change the permission mode)
57. Decide what happens when the gate itself fails: for a security scan, block rather than let the action through unchecked. (Best practices: Enforce steps with hooks)
58. Rules match tool calls, not intent: a read rule catches `cat .env` but not a script that opens the file, and a fetch deny does not cover `curl` unless the sandbox is on. List such holes; do not claim more than the gate does. (Best practices: Limit access with permission rules and the sandbox)
59. A stop gate that sends the agent back must say why in its reason; the reason is the agent's only feedback. (Hooks guide: Hook output; Best practices: Enforce the check with a Stop hook)
60. Bound stop gates: Claude Code overrides a stop hook after eight blocks in a row and tells hooks to check a continuation flag; in Pi each run gets one stop-gate continue. A gate that cannot converge must not loop. (Hooks guide: Stop hook hits the block cap)
61. A stop event fires whenever the agent finishes responding, not only at task end, so test "is the work done" in the gate, not "did it stop". (Hooks guide: Limitations)
62. A post-action hook cannot undo what the tool already did; put a safeguard before the action. (Hooks guide: Limitations)
63. Two hooks rewriting the same tool input give an unpredictable result; give each input one owner. (Hooks guide: Limitations)
64. To keep a reminder across compaction, re-inject it after compaction (in Pi the `session_compact` event); for every session, the instruction file is simpler. (Hooks guide: Re-inject context after compaction)
65. A gate should be small and few, each with an owner; every one will fire when it should not. (Best practices: Choose who a rule applies to)

### Checks and unattended runs

66. Give the agent a pass-or-fail check it can run (a test, a build exit code, a linter, a diff against a fixture); without one, "looks done" is all it has, and the most useful line in an instruction file is the command that runs it. (Best practices: Give Claude a check to run)
67. Strictness is a ladder: ask in the prompt, set a goal a separate model checks, enforce with a stop gate, have someone who did not write the code review it. Pick the lowest rung that is enough. (Best practices: Give Claude a check to run)
68. Ask for evidence (the command run and its output), not "all tests pass". (Best practices: Give Claude a check to run)
69. Before an unattended run, answer five questions: what done looks like, how it checks its own work, what it may touch, what stops it, and who signs off the result. (Best practices: Let Claude run without you)
70. Tell the agent exactly what you want; a recent model reads a request conservatively, and scope is what only you know. (Best practices: Write a specific prompt)

### Pi translation table

| Claude Code | Pi here |
| --- | --- |
| `CLAUDE.md` | `AGENTS.md`, plus `instructions/*` for the foreman and reviewer |
| Hooks in `settings.json` | Extension events and adapter gates (`extensions/core-adapter`), for example the stop gate on `agent_before_settle` |
| `tools:` and `disallowedTools` in a subagent file | `tools:` in `agents/*.md`, `roles.<role>.tools`, `roles.<role>.denyTools` |
| Subagent `skills:` preload | `roles.<role>.skills` (catalog entries), or the `skill` key per launch |
| Subagent `maxTurns`, `model` | `roles.<role>.childMaxTurns`, `ladder.*` and the provider role map |
| Skill `disable-model-invocation: true` | The same key: Pi hides the skill from the catalog, so it is used only when named explicitly (`skills/skill-authoring/SKILL.md`) |
| Subagent `memory:`, forked context, nested subagents | pi-subagents has its own `memory`, `context: fork` and `maxSubagentDepth`; pi-foreman's roles do not set them |
| Built-in Explore agent | The `explorer` role |
| Deny rules and permission modes | The permission overlay and `denyTools` (`docs/permissions.md`, `docs/roles.md`) |

### Does not carry over

Each exists on the Claude Code page named. For what Pi does instead, see `docs/roles.md` and `docs/permissions.md`.

- Path-scoped rules (`.claude/rules/` with `paths:`) and nested on-demand instruction files. (Memory: Path-specific rules)
- `@path` imports, `CLAUDE.local.md`, `claudeMdExcludes` and organisation-wide managed instruction files. (Memory: Import additional files; Manage CLAUDE.md for large teams)
- The commands `/doctor`, `/doctor prompt-audit`, `/context`, `/memory`, `/init`, `/usage`, `/goal`, `/code-review`: do the audit and the checks by hand. (Best practices; Memory)
- Claude Code's auto memory. (Memory: Auto memory)
- Claude Code hook names (`PreToolUse`, `PostToolUse`, `Stop`, `SessionStart` and so on), the exit-code-2 protocol, `settings.json` hook blocks and `prompt`, `agent`, `http` hook types. (Hooks guide: How hooks work)
- Skill frontmatter keys `allowed-tools`, `context: fork`, `agent`, `paths`, `model`, `effort`; Pi's loader reads only `name`, `description` and `disable-model-invocation`, and ignores the rest. (Skills: Frontmatter reference)
- Subagent frontmatter `permissionMode`, `omitClaudeMd` and `hooks`; Pi sets the equivalents through role config and launch keys. (Sub-agents: Frontmatter reference)
- Background-by-default subagents and the 15,000-token description cap. (Sub-agents: Let subagents spawn their own subagents)
- Auto mode, `--bare`, `/loop`, `/schedule`, `.worktreeinclude` and cloud scheduled tasks. (Best practices: Change the permission mode; Let Claude run without you)
