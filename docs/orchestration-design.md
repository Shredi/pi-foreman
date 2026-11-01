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

Should you go multi-agent, pick the plainest pattern that could do the job (generator plus verifier, orchestrator plus workers). Cut the work along context lines: a subagent should depend on little outside its own task and return a short result. Fits include separate research threads, components behind clean interfaces and black-box verification. Cutting by problem type instead makes every handoff carry the full situation, like a game of telephone where fidelity decays with each hop.

When a subagent stays, let the main agent call it as a tool so the main agent keeps the conversation. Hand the conversation over only when the subagent must speak to the user directly. Agree a response schema, check the subagent's conclusion against real data, and trim what goes into any final synthesis step.

## The single-loop design

- One model, one context window, an open tool loop. Limits (turn and cost budgets, write gates) live in the harness.
- On every turn the model produces several tool calls at once. The harness executes them concurrently and feeds the unprocessed results back to that same model, which picks the next step.
- Termination comes from the model giving an answer or from a budget running out; a goal or verifier check can optionally run afterwards.
- On turn one the model puts its plan into the context and amends it as results come in. Since the author of the plan also carries it out, it may alter course within a turn.
- Context handling shifts to the agent. A code step that rewrites plans from a catalogue of rules becomes unnecessary. Skills take over ordering and domain procedure. Tools take over hard limits (validation, approval gates) and whatever surfaces mid-conversation (memory lookup). Code may still preload cheap, nearly always relevant items such as entity resolution, and tools handle mechanical work like building payloads or parsing streams.

Why it works: shared context lets the agent connect earlier results, so output is richer than summaries handed back by a subagent. Skills and tool search disclose context progressively, so one agent can cover many tasks without one huge prompt; the article cites a system prompt cut by more than 80 percent for newer Claude models in Claude Code. And each model generation can take over more decisions that the harness used to make. A simple loop moves to the next model easily; rigid multi-agent structure often held a new model back.

The price is discipline: a managed system prompt, skill and tool descriptions that fire at the right moment, deliberate context, memory and note-taking.

## Eval-first folding

1. Build a small end-to-end eval before the first merge. Ten golden examples are a start. Grade the final message against a rubric.
2. While an orchestrator exists, track routing accuracy. After folding, check that the agent loaded the right skill or called the right tool.
3. Keep one shared end-to-end set owned centrally, plus a small set shipped with each skill.
4. Record timestamps on key events so runs can be replayed as targeted evals.
5. Fold one subagent at a time (prompt becomes a skill, API call becomes a tool), beginning with the busiest ones, and with specialists that feed each other, share data or tend to be invoked together. Compare runs with and without the subagent. Inspect which individual tasks changed outcome rather than only the aggregate; repeat each task. The article's example: folding cut latency yet broke a flow that used to pass, because the main agent replied from a single tool and never consulted the specialist.
6. Add an eval task for each agent chain that runs together in production, and for each rule the agent must never violate.

Principle: measure, change a single thing, retain what survives. A subagent stays only when the folded variant scores worse. Repeat as models improve.

## Skills, tools and knowledge bases

- **Tools** suit taking actions, reading live data and returning results of a fixed shape. Organise them around user intent, not one per API, because choosing among more than roughly 30 to 50 definitions gets worse. Combine tool search with deferred loading. Enforce hard preconditions inside the tool itself: when Y depends on X's output, the Y tool verifies this and replies with an instruction the model can follow. Per-user permission checks follow the same shape and end in a plain-language refusal.
- **Skills** suit the way a team works: the steps, rules and judgment calls that used to live in a specialist subagent's prompt. Whoever owns the work owns the skill and ships evals with it. Models can help author, test and prune skills.
- **Knowledge bases** suit reference material needed only occasionally. Put them behind a lookup tool or into reference files within a skill, and avoid code that fetches the material and pastes it into prompts.

In this model teams hold skills and tools instead of whole agents. A single small central team is responsible for the system prompt and overall quality, and it approves each new skill, tool and eval.

## Questions for pi-foreman

Open questions only; none is decided here.

- Roles: which of the roles exist because of context or tool conflicts, and which because a classifier-like split felt natural? What would an eval for folding one into a skill look like?
- Fan-out: does each fan-out give a piece of work with a compact result, or does it split by problem type and force handoffs?
- Explorer versus own reads: when does a fresh-context explorer beat the main agent reading the files itself, and is that measured?
- Skills for procedure: which role prompts hold procedure that a skill could load on demand, so the prompt shrinks?
- Verifier subagents: where is an independent verifier worth its latency, and where could a check run as a tool or a rubric?
- Ownership: who owns end-to-end quality and the foreman system prompt, and which evals exist for it?
- Handoffs: where does the foreman pass summaries between children, and what detail gets lost?
