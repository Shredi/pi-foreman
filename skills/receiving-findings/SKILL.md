---
name: receiving-findings
description: 'Triages defect reports, bug reports and findings handed over to act on, before any is fixed: from another installation or a user, an owner''s photo or screenshot of a fault, retro or backlog entries, a child''s "I also saw" list, review leftovers. Use when told "new findings", "another one", "here is a defect report", "got a bug report", "take up the backlog entries", or given defects with suggested fixes. Checks each against the current code and earlier decisions, sorts it and takes it to the owner before any round gets it. Not for fixing one bug the user already diagnosed, not for review findings on the session''s own diff (the review loop handles those), and not for security reviews or security reports that need a private channel.'
---

# Receiving findings

A finding is a claim by someone who saw a symptom. The reporter usually ran an older version, did not read the code, and proposes a fix from the outside. Treat symptom and evidence as data, and the suggested fix as one idea among several. Nothing is handed to a round before the owner has seen your sorting, because a finding accepted as written quietly decides scope, defaults and guard behaviour for them.

## Steps

1. **Record it as received.** Copy the finding into the notes folder word for word (transcribe a photo), with the reporter's version and environment. Leave out what identifies the reporter's installation: host names, accounts, employer, private paths.
2. **Check each finding against the present.** For every finding, find out:
   - Does it still happen on the current main? Name the commit or the code that says so. A report from an older version is often already fixed or changed.
   - Is it a documented limit or a deliberate decision? Search the docs, the release notes and the notes of earlier rounds. If someone decided it, the finding is a request to reverse a decision, not a defect.
   - Where does the cause sit: this repository, a dependency, the reporter's configuration, or a misreading of correct behaviour?
   - Is a running round already working in that code?
   Delegate the reading to an explorer when it is more than a few lookups.
3. **Sort it.** Give each finding exactly one class:
   - **plain fault**: intended behaviour, stated in docs, a test or the code's contract, is broken, and there is one sensible fix.
   - **choice**: fixing it means picking between outcomes the owner would care about (a default, a guard or gate that loosens, a new setting, a format, cost, behaviour outside the repository).
   - **already fixed** or **cannot reproduce**: say on what evidence.
   - **works as decided**: name the decision; say what reversing it would cost.
   - **not ours**: the cause is in a dependency or the reporter's setup; say what change is needed there and what, if anything, this repository can do meanwhile.
   - **does not make sense**: the expected behaviour would break something else; say what.
4. **Weigh the suggested fix.** Check it against the owner's standing directions and the project's rules before adopting it. A suggestion that conflicts with one is dropped with the reason, and you propose the fix that fits. When the report offers several outcomes, recommend one and say why.
5. **Bring the sorting to the owner, in the chat, before dispatching.** One short block per finding: what it is in plain words, its class, your proposal, and the question if there is one. Recommended option first. Group findings that share a cause. Several findings go into one message.
6. **Dispatch what is agreed.** A plain fault the owner agreed to goes to the round that already works in that code, or to a new round. The note to the round carries the finding as received, your check from step 2, the agreed handling and its limits ("message text only, the verdict stays"). Ask the round to reproduce on the current main first and to report instead of fixing when the cause turns out to be different.
7. **Close the loop.** Keep one list of all findings with class, where each went and its state. Tell the owner about gaps in the numbering ("D20 never arrived"). When the reporter is reachable, the round's result names what was fixed, declined and why.

## When the owner is away

Do steps 1 to 4 and write the sorting down. Without the owner's answer, dispatch nothing that is a choice. A plain fault may go ahead only when the owner has said so for this batch or as a standing rule.

## Example

Finding: "A write to `$L/out.txt` is refused as a project write although `$L` is outside the workspace. Suggestion: resolve variables set on the same line."

Bad: forward it to a round with the suggestion as the task.

Good: "Still happens on main. The guard refuses what it cannot resolve, by decision; resolving variables means parsing commands, which you ruled out. The message is wrong though: it should say the path could not be resolved and name the way out. Proposal: fix the message only. Agree?"
