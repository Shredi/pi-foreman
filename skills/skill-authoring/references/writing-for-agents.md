# Writing for agents

Source: https://github.com/mattpocock/skills/blob/main/skills/productivity/writing-for-agents/SKILL.md (MIT)
Checked: 2026-11-01

An own-words digest of the ideas. It covers any document an agent reads: a skill, an `AGENTS.md`, a doc reached through a pointer. The source text is not copied here.

## Contents

- Context pointers
- Two loads
- Information hierarchy
- Completion criteria
- When to split
- Leading words and negation
- Pruning

## Context pointers

A context pointer is a short line in the always-loaded context that names material outside it and says when to fetch it. A skill description is one; a line in `AGENTS.md` naming a doc is another. The wording of the pointer, not the target, decides whether and when the agent goes there. If a must-read target sits behind a weak pointer, the runs vary: sharpen the wording first, and inline the material only when sharpening fails.

A pointer states what the material is and lists the distinct cases that should trigger a read.

- Put the most telling word first.
- One trigger per case. Synonyms for one case are the same case twice; collapse them.
- Drop identity the body already carries.

## Two loads

- Context load: tokens and attention an always-loaded line costs on every turn, whether or not it fires.
- Cognitive load: the effort a person spends remembering which documents exist and when to open each. Spend it where human judgement matters.

Material behind a pointer pays only the pointer's line. Material with no pointer relies entirely on the person remembering it.

## Information hierarchy

Document content is steps (what to do, in order) and reference (facts and rules to consult). Place each piece on a ladder:

1. In-file step: what the agent does, in order.
2. In-file reference: consulted on demand. A flat list of peer rules is fine here.
3. Disclosed reference: in another file, reached by a pointer, loaded only when that fires.

Pushing too little down bloats the top; pushing too much hides what the agent needs. Test by branching: inline what every path needs and disclose what only some paths reach. Keep a concept's definition, rules and caveats under one heading. A document can also be too long with every line useful; then split by branch or sequence so each path carries only its own part.

## Completion criteria

Each step ends on a condition that says it is done. Make it clear (the agent can tell done from not done; vague bounds invite stopping early) and demanding (it forces the legwork: "every changed module accounted for" asks more than "write a change list"). The best criteria are checkable and exhaustive. If a vague bound cannot be sharpened and the agent still rushes, hide the later steps by splitting at a real context boundary such as a handoff.

## When to split

Split a document only when the cut earns its cost. One good reason: later steps tempt the agent to rush the current one, so split by sequence.

## Leading words and negation

A leading word is a compact concept the model already knows from training (for example "tracer bullet"). Use it as a token, not an explanation, and use it in both the body and the pointer so the shared vocabulary links them. Prefer an existing word to a coined one, because a coined word carries no prior meaning.

Steering by prohibition keeps the banned behaviour in context and makes it more likely. State the target behaviour instead. Keep a prohibition only as a hard guardrail with no positive phrasing, and pair it with the target.

## Pruning

- One meaning, one place. Duplicates cost upkeep and tokens and inflate a point's apparent rank.
- The environment is a source of truth: scripts in `package.json`, config files, directory layout, `--help` output. A document that restates them is a cache. Cache only what cannot be found by looking: unwritten conventions, the reason behind a choice, a gotcha no config admits.
- Check each line for relevance. Without pruning, stale layers pile up because adding feels safe and removing feels risky.
- Hunt no-ops sentence by sentence: an instruction the model already follows by default costs load and says nothing. Judge by whether the line changes behaviour against the default, and settle disputes by running the document. Delete the whole sentence. A leading word too weak to beat the default ("be thorough") is a no-op; swap in a stronger one.
