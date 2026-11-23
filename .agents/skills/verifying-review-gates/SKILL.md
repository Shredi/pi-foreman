---
name: verifying-review-gates
description: "Checks that the finish verdict over the per-checkout review gates and the `mark V` refusal still follow the rule after a change to extensions/core-adapter/reviewgates.ts, bound.ts or ledgercall.ts. Use when editing those files or the finish readers in index.ts, or when asked to 'verify the review gates', 'rerun the review gate check' or 'sweep the review gate seeds'. Also checks the ended-dialog wording of extensions/core-adapter/childblocked.ts (rule c). Not for the end-to-end finish tests."
---

# Verifying the review gates

## Rule

The finish gate passes only when every checkout with work has a standing PASS; a deleted checkout that is open is dropped only when another existing checkout got a PASS after its last work (a builder launch or end) and last FAIL, and none is held by a builder launched there that has not ended (D165). `mark V` is accepted only while a counted PASS exists and no checkout's last review failed; later revisions do not reopen V. (c) After a dialog episode of a child ends, the parent's words say "answered" only with a stored answer at or after the episode start, and a restart of the session wins over any answer (D159).

## Harm

A wrong drop lets a change finish with an unreviewed checkout; a missing drop traps the session behind a checkout that was deleted after its work was reviewed elsewhere; a wrong V rule lets the verifier item close with no review or refuses it after a PASS; a wrong dialog wording tells the parent the owner answered a dialog that a restart lost, so nothing asks the owner again.

## Tool and why

A seeded generator test on the pure entry points: the question is every order of builds, reviews and deleted checkouts, and a unit test only covers the orders someone thought of. A model written from the events alone is the oracle. No dependency; it runs in the normal test runner.

## Covered

- Files and functions: `extensions/core-adapter/reviewgates.ts` (`gatesRevise`, `gatesVerdict`, `supersededGone`, `combined`), `extensions/core-adapter/bound.ts` (`onReviewVerdicts`, `onRevision`), `extensions/core-adapter/ledgercall.ts` (`planLedgerCall`, the V rule), `extensions/core-adapter/childblocked.ts` (`ChildBlocked.tick`, the ended-episode words)
- Check file: `extensions/core-adapter/test/review-gates-generator.test.ts`
- Bounds and assumptions: every sequence of up to 4 events (build, builder launch, builder end, PASS, FAIL, delete) over 2 checkouts (the sequence count is printed by the self-check; about 25000) plus 3000 seeded sequences of 2 to 12 events over 3 checkouts, checked after every step; default seed 1; one event per tick of a counter, so no two times tie. Rule c: every order of up to 3 answers and restarts inside one episode, with and without an older answer (30 scenarios), through the real `ChildBlocked` with a temp agent dir. About 0.2 s.
- Last confirmed at: `c2574051096aec6dfb3984d728adf7dde46ee998`

## Left out

- The finish assembly in `index.ts` (`liveGates` and its readers): covered by `review-gone-superseded.test.ts`.
- The session-wide entry (key ""), a verdict with no verdict (`none`), a verdict over several roots, a high-stakes FAIL (`gatesMarkStood`) and `stoodAtFail`.
- A builder whose end event never arrives (its checkout stays held until the session ends), a builder end with no recorded launch, a resumed builder's roots, and an unknown-checkout (null roots) end.
- A reload (the running builders and gate times persisted through it): covered by `review-gone-running-reload.test.ts`.
- A deleted checkout that comes back, a checkout built or reviewed after its deletion, and any real git or file system.
- Diff facts and the review records. Of `childblocked.ts` only the ended-episode words: not the reminders, the remote and hold wordings, `dismissed`, or the re-ask (`reAskOpenDialogs`).
- No open gap marks: every failure is a finding.

## Rerun

Default (under a second, also in `npm run test:node`):

```
node scripts/foreman_test_run.mjs --targeted extensions/core-adapter/test/review-gates-generator.test.ts
```

Longer sweep (opt-in, never in CI):

```
FOREMAN_REVIEW_GEN_SEED=1 FOREMAN_REVIEW_GEN_SEEDS=200 node scripts/foreman_test_run.mjs --targeted extensions/core-adapter/test/review-gates-generator.test.ts
```

## Seen failing

Break made (rule c): `extensions/core-adapter/childblocked.ts`, `clearOf` checked the restart after the answer again. The check printed: `stale answer: true; episode: answer, restart: said answered, want restart`.
Break made (rules a, b): `extensions/core-adapter/reviewgates.ts`, `supersededGone` stopped comparing the PASS time (`x.passAt > at` removed).
The check printed: `seed 1 case 215: pass c0; build c1; delete c1: after step 3 (delete c1): dropped [/w/c1], want []`, with the rerun line.
Reverted and green again: yes, the default command: 6 of 6 pass.

## Reading a failure

- Real bug: the printed sequence is the shortest one (a fixed point of dropping one event); read it as builds, reviews and deletes in checkouts `c0`..`c2`. Report it in those words to the owner of the gate code.
- Fault of the check: the self-check test fails first (the sequences no longer reach a dropped checkout, a finish pass or both V outcomes), or the self-test says a broken rule went unseen. Fix the generator, not the code.
- Model behind the code: the model in `replay` states the rule from the events; when the rule changed on purpose, change the model and say why.
- Stale mark: none exist.

## After an intended change

1. Confirm the check still describes the code: reread `replay` against `supersededGone` and the V rule in `planLedgerCall`.
2. Rerun the default command, then a sweep; fix the model the change moved, naming why.
3. Move "Last confirmed at" forward to the new main-branch commit (`git merge-base HEAD origin/main`), only after steps 1 and 2.
4. Adding a case: an event is an `Ev` op in `OPS` plus its branch in `replay` and the self-check; extend the self-test with a broken rule for it.
