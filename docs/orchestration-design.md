# Orchestration design

> Digest, in our own words, of Anthropic's article on folding subagents into a single agent loop.
> Read it before you design roles, delegation or fan-out in the harness.
> It rules nothing for pi-foreman; the last section lists the open questions the article raises.

Source: https://claude.com/de/resources/articles/building-agents-when-to-fold-subagents-into-your-main-agent-loop
Checked: 2026-11-01

The article reports on enterprise agents built by Anthropic's applied AI team. A recurring finding: a single agent that loads skills on demand often beat both the giant-prompt design and the subagent design on quality, and often cost less and ran faster. The article ships a migration kit (`github.com/anthropics/single-agent-loop-kit`) for working through this step by step.

## What the pattern looks like

Teams tend to grow the same stack: an intent classifier, a fixed reasoning pipeline, buckets per user segment, a branch per recommendation type, and an orchestrator over all of it. The article's observation is that much of this structure compensated for weaknesses the model no longer has. One clear system prompt, a handful of thin data tools and firm output guardrails covered most of the use case.

Large organisations add their own failure modes:

- **Lossy handoffs.** Whatever one agent passes to the next is a summary; detail drops out.
- **Sprawl.** Many overlapping subagents with no owner and no shared standard.
- **The patchwork prompt.** Every team adds a sentence; the rules conflict and the voice drifts.
- **Local evals.** Each team optimises its own slice; nobody owns the whole.
- **Latency.** One customer saw about half the runtime after moving to a single loop.
- **Org-chart architecture.** One subagent per team or problem type mirrors the company, not the task.

## When subagents still earn their place

Keep or add a subagent when at least one holds:

1. A single loop measurably degrades from context bloat.
2. Several pieces of work can run in parallel, each in a fresh context that is thrown away afterwards.
3. One agent cannot choose between its tools, or its prompt holds rules that conflict.

The article also names verification and permission separation as strengths of subagents.

## Divide by context, not by problem type

If you do go multi-agent, start with the simplest pattern that could work (generator and verifier, orchestrator and workers). Give each subagent a piece of work that needs little from the rest and returns a compact result: independent research paths, components with clean interfaces, a black-box check. Splitting by problem type forces each handoff to carry the whole situation, and fidelity drops at every hop.

When a subagent stays, let the main agent call it as a tool so the main agent keeps the conversation. Hand the conversation over only when the subagent must speak to the user directly. Agree a response schema, check the subagent's conclusion against real data, and trim what goes into any final synthesis step.

## The single-loop design

- One model, one context window, an open tool loop. Limits (turn and cost budgets, write gates) live in the harness.
- Each turn the model emits a batch of tool calls; the harness runs them in parallel and returns raw results to the same model.
- The loop ends when the model answers or a budget is hit. A goal or verifier check may follow the answer.
- The model writes its plan into the context on the first turn and revises it as results arrive. The planner is also the executor, so it can change course mid-turn.
- Code that rewrites the plan from a rule catalogue goes away. Ordering and domain procedure move into skills. Hard limits (validation, approval gates) and mid-conversation needs (memory lookup) move into tools. Code still loads what is cheap and almost always relevant, and does the mechanical parts inside tools.

Why it works: shared context lets the agent connect earlier results, so output is richer than summaries handed back by a subagent. Skills and tool search disclose context progressively, so one agent can cover many tasks without one huge prompt; the article cites a system prompt cut by more than 80 percent for newer Claude models in Claude Code. And each model generation can take over more decisions that the harness used to make. A simple loop moves to the next model easily; rigid multi-agent structure often held a new model back.

The price is discipline: a managed system prompt, skill and tool descriptions that fire at the right moment, deliberate context, memory and note-taking.

## Eval-first folding

1. Build a small end-to-end eval before the first merge. Ten golden examples are a start. Grade the final message against a rubric.
2. While an orchestrator exists, track routing accuracy. After folding, check that the agent loaded the right skill or called the right tool.
3. Keep one shared end-to-end set owned centrally, plus a small set shipped with each skill.
4. Record timestamps on key events so runs can be replayed as targeted evals.
5. Fold one subagent at a time (prompt becomes a skill, API call becomes a tool), starting with the most used or those that chain on each other's output, touch the same data or are often called together. Compare with and without. Look at which tasks flipped, not just the score; run each task more than once. In the article's example, folding sped things up but broke a process that used to pass, because the main agent answered from one tool and never asked the specialist.
6. Write an eval task for every chain of agents that runs together in production and for every rule the agent must not break.

Principle: measure, change one thing, keep what holds up. Keep a subagent only if the folded version scores worse; repeat as models improve.

## Skills, tools and knowledge bases

- **Tools** fit actions, live data and fixed-shape results. Group them by user intent rather than one per API; beyond roughly 30 to 50 definitions, choice degrades. Use deferred loading with tool search. Put hard preconditions inside the tool: if Y needs X's output, Y checks and returns an instruction the model can act on. Per-user permission checks work the same way, returning a plain refusal.
- **Skills** fit how a team works: the steps, rules and judgment calls a specialist subagent's prompt used to hold. The team that owns the work owns the skill, with evals shipped alongside. Models can help write, test and prune skills.
- **Knowledge bases** fit reference material needed only some of the time: behind a lookup tool or as reference files inside a skill. Avoid code that retrieves and pastes them into prompts.

Ownership moves from agents to skills and tools; one small central team owns the system prompt and end-to-end quality and vets new skills, tools and evals.

## Questions for pi-foreman

Open questions only; none is decided here.

- Roles: which of the roles exist because of context or tool conflicts, and which because a classifier-like split felt natural? What would an eval for folding one into a skill look like?
- Fan-out: does each fan-out give a piece of work with a compact result, or does it split by problem type and force handoffs?
- Explorer versus own reads: when does a fresh-context explorer beat the main agent reading the files itself, and is that measured?
- Skills for procedure: which role prompts hold procedure that a skill could load on demand, so the prompt shrinks?
- Verifier subagents: where is an independent verifier worth its latency, and where could a check run as a tool or a rubric?
- Ownership: who owns end-to-end quality and the foreman system prompt, and which evals exist for it?
- Handoffs: where does the foreman pass summaries between children, and what detail gets lost?
