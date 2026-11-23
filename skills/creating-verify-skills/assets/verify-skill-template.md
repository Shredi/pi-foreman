---
# kebab-case, equal to the folder name, for example verifying-<thing>
name: verifying-[thing]
# What it checks, which files it covers (so a session that edits them loads it), when to run it, quoted trigger phrases. Under 1024 characters; quote it if it holds a colon followed by a space.
description: "Checks that [rule in a few words] still holds after a change to [covered files]. Use when editing [file or area], or when asked to 'verify [thing]' or 'rerun the [thing] check'. Not for [neighbouring job]."
---

# Verifying [thing]

## Rule

[One sentence: the promise the code makes.]

## Harm

[One sentence: what goes wrong for users when the rule breaks.]

## Tool and why

[Generator test / TLA+ model / verifier, and the question that chose it. If it needs an install: what, how big, local opt-in only.]

## Covered

- Files and functions: `[path]` `[function]`, ... (every path exists; a test pins this)
- Check file: `[path to the test or model]`
- Bounds and assumptions: [depth, constants, sample size, default seed]
- Last confirmed at: `[commit on the main branch]` (in a squash-merge repository use a main-branch commit; a branch commit disappears)

## Left out

[The constructs, actors, roles, platforms and cases the check does not cover, and every blind spot (for example, a mark that covers all payloads of its shape). The owner reads this list with the rule.]

## Rerun

Default (seconds, runs on every change):

```
[one command]
```

Longer sweep (opt-in, never in CI):

```
[command]
```

## Seen failing

Break made: [file, what was removed or reordered]
The check printed: [the construct or step list and the shortest case]
Reverted and green again: [yes, with the command]

## Reading a failure

- Real bug: [how it looks, for example the shrunk case is a plain input the code should refuse]. Report the shortest case in the code's words to [owner of the code]. Add a mark only with an id and a source.
- Fault of the check: [which self-check or precondition fails first, for example the generated case does not run its payload].
- Model behind the code: [the replay does not show the path; fix the model to match the code].
- Stale mark: [the check says which id is closed; remove its line].

## After an intended change

1. Confirm the check still describes the code: [which lines or action comments to reread].
2. Rerun the default command; fix marks and pinned values the change moved, naming why.
3. Move "Last confirmed at" forward to the new main-branch commit, only after steps 1 and 2.
4. Adding a case: [how to add a construct, payload or action, and the self-test to extend].
