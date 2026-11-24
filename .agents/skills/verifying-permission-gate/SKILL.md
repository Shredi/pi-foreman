---
name: verifying-permission-gate
description: "Checks that a shell line holding a dangerous command never runs without a block, a judge look or an owner ask, whatever construct hides it, after a change to extensions/core-adapter/shellast.ts, effects.ts, floors.ts, classifier.ts, gate.ts, defaults.ts or the tool_call handler in index.ts. Use when editing those files, or when asked to 'verify the permission gate', 'rerun the gate check' or 'sweep the gate seeds'. Not for a security review of a diff and not for the main session's own rules."
---

# Verifying the permission gate

## Rule

A shell line that holds a dangerous command (a delete or write outside the worktree, a push, a credential read, a pipe into a shell, a git write outside the worktree) is blocked, judged or asked for a builder or reviewer child, however many shell constructs wrap it. A harmless twin of each construct is not stricter than today.

## Harm

A construct the gate does not read lets a child run a command the floors exist to stop, with no block and no look.

## Tool and why

A seeded generator test on the real entry point `gateEvaluate`: the question is every wrapper around a payload, and a unit test only covers the wrappers someone thought of. It adds no dependency and runs in the normal test runner.

## Covered

- Files and functions: `extensions/core-adapter/shellast.ts`, `extensions/core-adapter/effects.ts`, `extensions/core-adapter/floors.ts`, `extensions/core-adapter/classifier.ts`, `extensions/core-adapter/gate.ts` (`gateEvaluate`), `extensions/core-adapter/defaults.ts`, `extensions/core-adapter/index.ts` (the `tool_call` handler)
- Check files: `extensions/core-adapter/test/gate-generator.test.ts` (the properties) and `extensions/core-adapter/test/_gate-gen.ts` (payloads, constructs, generator, checker, `KNOWN_GAPS`, `TWIN_PINS`, `LEFT_OUT`); sweep script `scripts/gate_sweep.mjs`
- Bounds and assumptions: 7 dangerous and 3 harmless payloads, 55 constructs (52 wrappers); every construct alone (734 gate calls), every ordered pair a `KNOWN_GAPS` entry names, and per seed 120 chains of depth 2 and 60 of depth 3; roles builder and reviewer; default seed 1; the fast oracle is cross-checked against the real `tool_call` handler on about 20 lines (judge stubbed). Whole file about 12 s.
- Last confirmed at: `8917c56d0cc3e5846467a860882ca64e2e8356cd`

## Marks

Open gaps are expected-fail marks with an id and a source: `KNOWN_GAPS` (shapes found through constructs) and `PLAIN_GAPS` (plain lines, evaluated per role). `git-outside-tilde` is the plain line `git -C ~/other stash push`, silent for a builder today (new, found by the generator); the check fails with "gap git-outside-tilde is closed" once it stops being silent.

## Left out

- The main (owner) session in properties A and B: it has its own roots and mode step. `ROLE_MATRIX` pins it next to builder and reviewer at the gate layer only (no mode step, no judge dialog).
- Constructs that are not in `CONSTRUCTS` and payloads that are not in `DANGEROUS`.
- Every payload of a shape whose `KNOWN_GAPS` mark names no payload: a blind spot until that gap closes.
- Chains are composed only with the `/opt` form of the git-outside payload (`git -C /opt/other stash push`). The `~` form (`git -C ~/other stash push`) is a plain line in `PLAIN_GAPS` (gap `git-outside-tilde`, silent for a builder, blocked for a reviewer); no wrapper is tried around it.
- `wait -p` and the two friction notes of the #347 follow-up list (about too strict verdicts).
- PowerShell, tools other than bash, Windows (the file is skipped there).
- The judge's own verdict quality: a judge look counts as seen.
- The quoting test runs a construct for real only where this machine has what it needs (bash 4.4, `busybox`, `strace` and so on); otherwise it checks syntax with `bash -n` and the test log says which cases (`syntax check only`). `npx` is never run.

## Rerun

Default (about 12 s, also in `npm run test:node`):

```
node scripts/foreman_test_run.mjs --targeted --import ./extensions/core-adapter/test/_hermetic-env.mjs extensions/core-adapter/test/gate-generator.test.ts
```

Longer sweep (opt-in, never in CI; about 2.5 s per seed; skips the stale-mark check):

```
npm run test:gate-sweep -- --seeds 20 --seed 1
```

`FOREMAN_GATE_GEN_SEED` and `FOREMAN_GATE_GEN_SEEDS` set the same by hand.

## Seen failing

Break made: `extensions/core-adapter/shellast.ts`, the `While` case stopped walking the condition (`walkLists([n.clause, n.body], sc)` became `walkLists([n.body], sc)`).
The check printed: "12 dangerous line shape(s) run silent with no gap mark (seed 1)", for example `[builder] payload rm-outside, depth 1`, shrunk command `while rm -rf ~/x; do break; done`, with the rerun line.
Reverted and green again: yes, `git checkout -- extensions/core-adapter/shellast.ts`, then the default command: 10 of 10 pass.

## Reading a failure

- Real bug: property A prints seed, construct names, the shrunk command and a rerun line, and the shrunk command is a plain construct around a payload that runs with no look. Report the shortest case to the owner of the gate. Add a `KNOWN_GAPS` line only with a slug id and its source, never to silence an unexplained failure.
- Fault of the check: the precondition test fails first (a plain payload already runs silent), or the quoting test says "the marker payload did not run" (a construct builds a line that does not run its payload; fix the construct in `_gate-gen.ts`, it is not a finding).
- Stricter than today: property B names the construct, role and class (`sss` is silent for the three harmless payloads). If the change meant it, edit `TWIN_PINS` and say why in the change.
- Stale mark: "gap `<id>` is closed: remove its line from `KNOWN_GAPS`" (or from `PLAIN_GAPS` for a plain line such as `git-outside-tilde`). Checked at the default seed only. A plain line silent for a role its entry does not list is a new find: report it.
- Too many harmless chains judged: the pinned ceiling in `gate-generator.test.ts` (`MEASURED_SHARE` plus 2 points); change `MEASURED_SHARE` only for an intended change, with the measured figure.

## After an intended change

1. Confirm the check still describes the code: reread `LEFT_OUT`, the `KNOWN_GAPS` source lines and the `TWIN_PINS` comment in `_gate-gen.ts`, and the roots and floor environment `gateOracle` builds against the `tool_call` handler in `index.ts` (`floorEnvOf`, `gateRootsOf`).
2. Rerun the default command, then a sweep (`npm run test:gate-sweep -- --seeds 20`); fix marks and pins the change moved, naming why.
3. Move "Last confirmed at" forward to the new main-branch commit (`git merge-base HEAD origin/main`), only after steps 1 and 2.
4. Adding a case: a construct is one `wrap(...)` or `fixed(...)` line in `CONSTRUCTS` (set `Needs` so the quoting test can run it, and `bashy`/`posix`/`oneLine`/`multi` when its text needs them) plus its `TWIN_PINS` letters; a payload is a line in `DANGEROUS` or `HARMLESS`. Extend the self-tests at the end of `gate-generator.test.ts` when the checker itself changes.
