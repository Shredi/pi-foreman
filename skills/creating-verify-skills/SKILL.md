---
name: creating-verify-skills
description: Builds an automated check for the code where a bug hurts most and unit tests reach least (gates, parsers, state machines, races, retries), picks the cheapest tool for the question (generator or property test, TLA+ model checker, verifier), proves the check can fail, and leaves a project-local verify skill for the next agent. Use when asked to 'model-check this', 'prove this invariant', 'write a property test for the gate', 'tests cannot reach this', 'create a verify skill' or 'check every order of these steps'. Not for ordinary unit tests and not for a security review of a diff.
metadata:
  visibility: search
---

# Creating verify skills

A unit test runs the examples its author imagined. A verify check instead sweeps a whole stated scope: all inputs up to some depth, or all interleavings of a small model. This skill picks one promise of the code, builds that check, proves it can fail, and leaves a short project-local skill so the next agent can rerun it and read its result.

The rule that matters most: a finding stays a finding. Report it; never bend the rule, the model or the generator until the check passes, because a check that was bent proves nothing.

## Instructions

1. **Pick the target from the code.** Look for the guarantee whose failure would hurt most and whose failing case an example-based test is least likely to hit. Rank candidates by that pair and take the top one, even when an easier one is nearby. Ask the owner only what the code cannot tell; if the owner named an area, start there. Success looks like: one file or function set named, with the reason it ranks first.
2. **State the rule and the harm, one sentence each.** "A shell line that holds a delete outside the worktree never runs without a block or a look" is a rule; "the gate is correct" is not. The owner reads the rule and the left-out list (step 7), because no check proves the rule itself is right. Success looks like: two sentences the owner can accept or change.
3. **Let the question choose the cheapest tool**, and say why in one line.
   - Every input of real code: a generator (property) test on the real entry point, or a verifier where the language has one. Read `references/generator-tests.md`.
   - Sequencing questions (races, retries, hand-overs): a small model of the moving parts, explored by a model checker, TLA+ with TLC. Read `references/state-flow.md`.
   - Every size: a proof. Only with the owner's agreement, since it costs the most.
   - A tool that needs an install (Java, TLC, a verifier) is a local opt-in command. It becomes a CI or install dependency only on the owner's decision; state its cost (install size, run time) when you propose it.
4. **Build the check true to the code.** Use the repo's names, call the real entry point, and keep no hand copy of the function: a copy drifts and then checks itself. Success looks like: the check calls production code, or a model whose every action maps to one step of production code.
5. **See it fail.** Break the guarded code in a scratch change (remove a check, reorder two steps), run the check, watch it turn red, drop the change, run again and confirm green. A check never seen failing proves nothing, because it may be passing for the wrong reason. Where it fits, keep a permanent self-test too: run the checker against a fake subject that is broken on purpose and assert it reports the break. Success looks like: the red output saved for the verify skill ("Seen failing").
6. **Keep findings as findings.**
   - Report the shortest counterexample in the code's words: the command, input or step list, not the tool's internal state.
   - Never weaken the rule, the model or the generator to turn it green. Change no product code unless the task says so; the owner decides what to fix.
   - A known open finding gets an expected-fail mark with an id and a source. A mark whose case now passes fails the check ("gap `<id>` is closed: remove the mark"), so marks come off when the bug is fixed.
   - A failure with no mark fails the check; a mark is added only with an id and a source, never to silence an unexplained failure.
7. **Say the scope.** Write down what the check covers, its bounds (depth, constants, sample size, seed) and its assumptions, then list everything it skips. A bound the reader does not see reads as full coverage. Success looks like: a left-out list the owner can read in a minute.
8. **Give one rerun command.** It is short enough to run on every change (seconds, not minutes) and runs in the project's normal test runner when the tool is already a dependency. A longer sweep (more seeds, bigger bounds) is a separate opt-in command. Success looks like: the command printed in the verify skill and run once from a clean shell.
9. **Write the project-local verify skill** from `assets/verify-skill-template.md` in the project's own skill folder. It holds: rule, harm, left-out list, covered files and functions, the commit last confirmed, the rerun command, how to separate a genuine bug from a fault in the check or a model that lags the code, and how to update after an intended change. In a squash-merge repository record a commit on the main branch, since branch commits disappear after the merge. Move the commit forward only after confirming the check still describes the code. Make a test pin that the skill loads and names files that exist.
10. **Play the next agent.** Open only the new verify skill, make a scratch break inside a covered file, follow its rerun and reading steps, drop the break. Fix any line you had to guess. Then hand off: rule, tool and reason, bounds, findings with their shortest counterexample, the rerun command, the left-out list. For a state flow, show the Mermaid chart to the owner so they can judge the rule (in this harness: `foreman_show`, or the plan page, which draws Mermaid).

## Examples

Good:

> Target: the retry loop that re-sends a message after a lost acknowledgement.
> Rule: "every message is delivered exactly once, also when the acknowledgement is lost." Harm: a double charge.
> Tool: TLA+ model, because the question is every order of send, loss and retry. Cost: Java 17+ and a 3 MB jar, local only.
> Seen failing: the retry without a delivered-flag check turned the invariant red in 4 steps; reverted, green again.
> Hand-off: chart shown to the owner, bounds (2 messages, 1 loss), left out: crash during write.

Bad:

> Target: the easiest helper function. Rule: "works". Tool: a hand-copied version of the function in a test file, run with ten examples. The first failure is fixed by narrowing the generator to inputs that pass.
> Why it is bad: the target is not the riskiest, the rule cannot fail, the copy can drift, the check was never seen failing, and the generator was bent instead of the bug reported.

## Troubleshooting

| Symptom | Cause | Solution |
|---|---|---|
| The check is green on the first run and also on the scratch break | It does not reach the guarded code (wrong entry point, bound too small, rule too weak) | Fix the check until the break turns it red; do not ship it before |
| The check reports a failure you cannot reproduce by hand | The generator or model builds something the code never sees | Add a self-check that each generated case does what it claims; the case is then a generator fault, not a finding |
| A model counterexample does not happen in the real code | The model is wrong or fell behind the code | Replay the path against the code first; assume the model is wrong until shown otherwise |
| The run takes minutes | Bounds too large for every change | Shrink the default bounds; move the large run to the opt-in command |
| The same failure appears on every change | An open finding with no mark | Add a mark with id and source after the owner knows it, not before |
| The tool is not installed | Opt-in tool | Say so in the hand-off and name the install step; do not add it to CI |

## References

- `references/generator-tests.md`: seeded generators, composition, oracle, false-alarm twin, shrinking, marks, budget. Read for the "every input" tool.
- `references/state-flow.md`: TLA+ model, TLC run, Mermaid chart, bug replay, drift. Read for the "every order" tool.
- `assets/verify-skill-template.md`: skeleton of the project-local verify skill (step 9).
