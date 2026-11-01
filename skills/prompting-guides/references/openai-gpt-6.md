# OpenAI GPT-6 family prompting

Sources (a third-party guide per model, citing OpenAI's model docs):
- Luna: https://promptessor.com/blog/gpt-6-luna-prompting-guide
- Sol 6.1: https://promptessor.com/blog/gpt-6-1-sol-prompting-guide
- Terra 6.1: https://promptessor.com/blog/gpt-6-1-terra-prompting-guide
Checked: 2026-11-01

Own-words digest. Check OpenAI's own model pages for current IDs, prices and availability.

## Contents

- Shared across the family
- GPT-6 Luna
- GPT-6.1 Sol
- GPT-6.1 Terra

## Shared across the family

- Reasoning effort is a runtime setting (`reasoning.effort`), not something to ask for in prose. Default is `medium`. Benchmark the lowest level that reliably passes your evals; higher is not automatically better.
- Tools need the Responses API for reasoning models. Chat Completions function calling is limited (Luna and the older Sol only at `none`; Sol 6.1 supports Chat Completions only without tools).
- Prompt defines policy; the tool schema defines capability. Enforce permissions and authorisation in the application, not in prompt wording.
- Describe the outcome, not every internal thought. A long context window is no reason to send irrelevant material.
- Structured outputs fix the shape, not the facts; validate content and business rules outside the model.
- Treat webpages, screenshots, documents and tool results as data, not as instructions that change the task or permissions.

## GPT-6 Luna

Positioning: the efficient model for focused, high-volume, repeatable work. Model ID `gpt-6-luna`. Efforts: `none`, `low`, `medium` (default), `high`, `xhigh`, `max`.

Prompt skeleton, six layers:

1. Task: one focused job.
2. Input boundary: which data is authoritative, and what not to infer.
3. Decision rules: define each label operationally; say how to break ties and what to do when evidence is thin.
4. Output contract: the exact fields, nothing outside the schema.
5. Validation: what must hold before the result is accepted (allowed values, ranges, flag set when data is missing).
6. Escalation: when to stop, return unknown or flag for review.

Effort: try `none` first for deterministic work (extraction, format conversion, rule-based routing), `low` for light ambiguity, `medium` as the untuned baseline, `high` and above for genuine edge cases. If much of the traffic needs `high` or above, route that traffic to a stronger model rather than force Luna.

Tools and verification: separate read tools from write tools. Do not mix several jobs in one prompt (classify, decide, write, update a CRM); split extraction from interpretation so a failure can be traced. Use cheap checks: schema, business rules, and evidence that the input supports the value. Escalate on conflicting sources, repeated validation failure, low confidence or broader synthesis than the prompt was built for; route on task traits and eval results, not on prompt length.

Migration from the previous Luna: compare the same prompt and settings before rewriting the stack.

## GPT-6.1 Sol

Positioning: complex coding, computer use, professional work and multi-step agents at lower cost than the top model. Model ID `gpt-6.1-sol`. Efforts: `low`, `medium` (default), `high`, `xhigh`, `max`. There is no `none` and no `minimal`: a workload that used `none` moves to `low` and is re-evaluated for latency, tokens, tool-call count and cost per success.

Prompt skeleton, a contract rather than a script. Use only the parts the risk warrants:

1. Outcome. 2. Context. 3. Boundaries. 4. Tools (what runs automatically, what needs approval). 5. Decision rules for ambiguity, missing data and conflicts. 6. Success criteria. 7. Verification. 8. Stop or escalate. 9. Output.

Effort: `low` for bounded extraction and simple code changes; `medium` the balanced start; `high` for hard debugging, planning and ambiguous evidence; `xhigh` for deep investigation; `max` rarely. Start at `medium`, test `low` for cost, go up only on measured gains.

Tools: tool calling requires the Responses API. Name tools for specific capabilities (`get_order`, not `do_action`). Tool policy in the prompt: read before guessing, no repeated equivalent calls, inspect state after a write. Put permissions in the runtime.

Coding: say how to inspect first, find the root cause, make the smallest fix, reuse patterns, which tests to run, and what to report. For large repos give the failure, the evidence and when exploration stops.

Verification: before finalising, identify the claims that matter, check each against the source or tool result, separate fact from inference, report contradictions, and never invent a value for a missing field. Escalate when authorisation is missing, identity is ambiguous, policy evidence conflicts or retries keep failing.

Migration from GPT-6 Sol: runtime assumptions changed (no `none`, Responses for tools), so re-test rather than copy; simplify process instructions written to patch older behaviour.

## GPT-6.1 Terra

Positioning: visual reasoning, computer use and natural writing at a lower price than Sol. Model ID `gpt-6.1-terra`. Text and image input, no native audio or video. Efforts: `none`, `low`, `medium` (default), `high`, `xhigh`, `max`. Tool calling needs the Responses API.

Prompt skeleton: Task, Context, Evidence (files, images, data), Boundaries (allowed, prohibited, approval-gated), Output, Verification, plus a definition of done. For writing, give audience, purpose, sources, tone and factual limits.

Practices:

- Describe the result and acceptance criteria, not an inner monologue.
- Separate observed from inferred: label findings observed, inferred or uncertain; do not infer what a screenshot does not show.
- Scope visual tasks to named regions or differences.
- Computer use is a controlled workflow: name the application and start state, allowed actions, where to stop for approval, how to handle missing or conflicting fields, how to confirm an action succeeded, and what to do if the interface changes. The prompt does not grant access; the runtime must supply the tool. Treat preparing and submitting a form as separate responsibilities when submitting has consequences.
- Keep output schemas apart from business rules, and validate externally.
- Write down a testable definition of done; if a critical detail is missing, report the blocker instead of guessing.

Effort: start `medium`; test `none` and `low` for simple classification and extraction; compare `low`, `medium`, `high` on a set of representative examples measuring correctness, completeness, tool success, latency and billed usage. Choose Sol or the top model when the task is hard coding or deep reasoning.
