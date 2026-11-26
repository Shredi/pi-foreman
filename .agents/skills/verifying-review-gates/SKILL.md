---
name: verifying-review-gates
description: "Checks that the finish verdict over the per-checkout review gates and the `mark V` refusal still follow the rule after a change to extensions/core-adapter/reviewgates.ts, bound.ts or ledgercall.ts. Use when editing those files or the finish readers in index.ts, or when asked to 'verify the review gates', 'rerun the review gate check' or 'sweep the review gate seeds'. Also checks the ended-dialog wording of extensions/core-adapter/childblocked.ts (rule c). Not for the end-to-end finish tests."
---

# Verifying the review gates

## Rule

The finish gate passes only when every checkout with work has a standing PASS; an entry whose checkout directory no longer exists is dropped whatever its state (D189b; the session-wide entry and an existing checkout never are). `mark V` is accepted only while a counted PASS exists and no checkout's last review failed; later revisions do not reopen V. A reviewer launch is refused as a repeat only when its checkout stands and `mark V` is accepted, so the two are never both refused (D203). (c) After a dialog episode of a child ends, the parent's words say "answered" only with a stored answer at or after the episode start, and a restart of the session wins over any answer (D159).

## Harm

A wrong drop lets a change finish with an unreviewed checkout; a missing drop traps the session behind a checkout that was deleted after its work was reviewed elsewhere; a wrong V rule lets the verifier item close with no review or refuses it after a PASS; a wrong dialog wording tells the parent the owner answered a dialog that a restart lost, so nothing asks the owner again.

## Tool and why

Two checks of the same rules. The main one is an exhaustive walk in the normal test runner: the question is every order of builds, reviews, deleted checkouts, `mark V`, a tier rise and a restart, and a unit test only covers the orders someone thought of, so the test walks every order up to a stated depth through the real pure entry points, no random sample. A model written from the events alone is the oracle. The second is a TLA+ model of the same states and rules (`model/ReviewGates.tla`) that TLC explores; it needs Java, runs in one Linux CI job (`review-gates-model`) and as a local command, and can drift from the code, so the TypeScript walk stays the main check.

## Covered

- Files and functions: `extensions/core-adapter/reviewgates.ts` (`gatesRevise`, `gatesVerdict`, `goneDropped`, `vAccepts`, `combined`), `extensions/core-adapter/bound.ts` (`onReviewVerdicts`, `onRevision`), `extensions/core-adapter/ledgercall.ts` (`planLedgerCall`, the V rule), `extensions/core-adapter/childblocked.ts` (`ChildBlocked.tick`, the ended-episode words)
- Check files: `extensions/core-adapter/test/review-gates-generator.test.ts` (the walk) and `.agents/skills/verifying-review-gates/model/ReviewGates.tla` with `.agents/skills/verifying-review-gates/model/ReviewGates.cfg` (the model). The model's actions map to the same files: builds (a builder launch is a build), verdicts and drops to `reviewgates.ts`, `mark V` and the V line to `ledgercall.ts`, answer and restart to `childblocked.ts`; each action has a comment naming its code.
- Walk bound: every order of 1 to 5 events from the 16 events build, launch, end, PASS, FAIL, delete (each in checkout c0 or c1), `mark V`, tier rise (trivial to standard: `withVItem` appends V once, D164), dialog answer, session restart (D159 c): 16^1 + ... + 16^5 = 1118480 steps, each checked after the step (rules A, B, D and, after an answer or restart, C). Measured: about 1.7 s for the walk, about 3 s for the test file, on a 10-core Mac. A failing prefix is not extended. One event per tick of a counter, so no two times tie. The dialog words come from the real `ChildBlocked` with a temp agent dir, once per distinct dialog (with and without an older answer). A second test keeps the rule-c sweep of every order of up to 3 answers and restarts (30 scenarios). A third test walks every order of 1 to 4 events over 3 checkouts (22 events, 245410 steps, about 0.5 s). `FOREMAN_REVIEW_GEN_DEPTH` raises the depth (each step multiplies the cases by 16; depth 6 is about 19 million steps, about half a minute).
- Model bound: `MaxSteps = 7` in the `.cfg`: every order of up to 7 events over 2 checkouts (59748 distinct states, TLC about 1 s on a 10-core Mac with Java 25). Invariants: `DropJustified`, `NoUnreviewedFinish`, `VRefusedAllowsLaunch`, `VClosedNeedsPass`, `VLineFollowsTier`, `DialogWords`; property `VStaysClosed`. Only the dialog rule uses time stamps, like the code; the invariants use history variables that record what happened without time stamps.
- Last confirmed at: `c2574051096aec6dfb3984d728adf7dde46ee998` (the walk and the model were both run green against the covered files on branch round/defects-13 on 2026-11-23, Java 25.0.5; the main-branch commit moves forward after the merge)

## Left out

- The finish assembly in `index.ts` (`liveGates` and its readers): covered by `review-gone-superseded.test.ts`.
- The session-wide entry (key ""), a verdict with no verdict (`none`), a verdict over several roots, a high-stakes FAIL (`gatesMarkStood`) and `stoodAtFail`.
- A resumed builder's roots and an unknown-checkout (null roots) builder end. A running builder holds nothing: `goneDropped` drops a gone checkout whether or not a builder runs in it, so the walk's launch and end events only check that an end changes no gate.
- A reload (the gates and the recorded running builders persisted through it): covered by `review-gone-running-reload.test.ts`.
- A deleted checkout that comes back, a checkout built or reviewed after its deletion, and any real git or file system.
- The model has no restart of the gate state (the gates persisted through a reload) and no session-wide entry; it has no builder launch or end action (a launch is a `Build`, an end changes no gate) and no model of the `index.ts` readers.
- Diff facts and the review records. Of `childblocked.ts` only the ended-episode words: not the reminders, the remote and hold wordings, `dismissed`, or the re-ask (`reAskOpenDialogs`).
- No open gap marks: every failure is a finding.

## Rerun

Default, the walk (about 3 s, also in `npm run test:node` and CI):

```
node scripts/foreman_test_run.mjs --targeted extensions/core-adapter/test/review-gates-generator.test.ts
```

Deeper walk (opt-in, never in CI):

```
FOREMAN_REVIEW_GEN_DEPTH=6 node scripts/foreman_test_run.mjs --targeted extensions/core-adapter/test/review-gates-generator.test.ts
```

The model (TLC). CI runs it in the Linux job `review-gates-model`; locally it is opt-in, no setup step in the repo. Cost: Java 25 (a JDK; 17 or later runs it), `tla2tools.jar` (TLA+ tools release v1.7.4, the latest stable release, 2274532 bytes, SHA-256 `936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88`), about 21 s of TLC on a 10-core Mac (CI: the earlier run on v1.8.0 took 1m6s for the job, 53 s of it TLC; the v1.7.4 job time is re-measured on the PR), a few hundred MB of RAM. Download the jar once into a cache outside the repo, check the hash (`sha256sum -c` on Linux, `shasum -a 256 -c` on macOS; a mismatch means stop), then run (Java on `PATH` or in `$JAVA_HOME`):

```
curl -fsSL --create-dirs -o ~/.cache/tla/tla2tools.jar https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar
echo "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88  $HOME/.cache/tla/tla2tools.jar" | shasum -a 256 -c -   # sha256sum -c - on Linux
cd .agents/skills/verifying-review-gates/model
java -cp ~/.cache/tla/tla2tools.jar tlc2.TLC -config ReviewGates.cfg -workers auto -metadir "$(mktemp -d)" ReviewGates.tla
```

Green reads `Model checking completed. No error has been found.` Nothing about Java or the jar is in `package.json`, setup or the installer; only the one Linux CI job fetches them.

## Seen failing

The walk. Break made (rules a, b): `extensions/core-adapter/reviewgates.ts`, `goneDropped` stopped dropping a gone checkout. The check printed: `build c0; delete c0: step 2 after delete c0: dropped [], want [/w/c0]`, with the rerun line.
Break made (rule D): `extensions/core-adapter/ledgercall.ts`, `withVItem` stopped looking for an existing V line. The check printed: `tier; tier: step 2 after tier: 2 V lines in the ledger, want 1`.
Break made (rule c): `extensions/core-adapter/childblocked.ts`, `clearOf` checked the restart after the answer again. The check printed: `stale answer: true; episode: answer, restart: said answered, want restart`.
Reverted and green again: yes, the default command: 7 of 7 pass (6 before the 3-checkout walk was added). The self-test also runs six broken rules (never drops, keeps a failed entry, last-verdict V rule, a launch refusal that ignores V, a V line appended on every tier rise, the old dialog words) and needs each reported.

The model, on a scratch copy, TLC on Java 25:
- `Words` put the answer before the restart: `Error: Invariant DialogWords is violated.` after `Restart`, `Answer`.
- Break made (v1.7.4 jar, Java 25): `Dropped` dropped nothing. TLC printed `Error: Invariant DropJustified is violated.` after `Build(1)`, `Delete(1)`: a deleted checkout stayed in the finish gate.
Restored and green again: yes, 278942 states generated, 59748 distinct, no error.

## Drift

The model is a second description of the rules; it can fall behind the code. On any change to `extensions/core-adapter/reviewgates.ts`, `extensions/core-adapter/bound.ts`, `extensions/core-adapter/ledgercall.ts` or `extensions/core-adapter/childblocked.ts`, reread each action comment of `ReviewGates.tla` against the diff and update the model in the same change; the CI job lists these four files in its log as a reminder, and it cannot see a drift by itself (a model that lags the code stays green). The TypeScript walk calls the real code and is the main check: when the two disagree, believe the walk, replay the model's path through it, and fix the model.

## Reading a failure

- Real bug: the printed sequence is the shortest one (a fixed point of dropping one event); read it as builds, reviews and deletes in checkouts `c0`..`c2`. Report it in those words to the owner of the gate code.
- Fault of the check: the self-check test fails first (the sequences no longer reach a dropped checkout, a finish pass or both V outcomes), or the self-test says a broken rule went unseen. Fix the generator, not the code.
- Model behind the code: the model in `step` (the walk) and `ReviewGates.tla` states the rule from the events; when the rule changed on purpose, change both and say why. A TLC trace is replayed in the walk first: the path `pass c0; build c1; delete c1` is the same steps in both.
- Stale mark: none exist.

## After an intended change

1. Confirm the check still describes the code: reread `step` against `goneDropped`, `withVItem` and the V rule (`vAccepts`), and the actions of `ReviewGates.tla` against the same.
2. Rerun the default command, a deeper walk and TLC; fix the model the change moved, naming why.
3. Move "Last confirmed at" forward to the new main-branch commit (`git merge-base HEAD origin/main`), only after steps 1 and 2.
4. Adding a case: an event is an `Op` in `OPS` plus its branch in `step`, an action in `ReviewGates.tla` and the self-check; extend the self-test with a broken rule for it, and see the model fail for it too.
