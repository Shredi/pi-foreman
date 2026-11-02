---
name: security-review
description: Reviews a diff for security defects. Use when the diff touches secrets, permissions, destructive commands, trust boundaries or untrusted input, or when asked for a "security review". Not for style, performance or plan reviews.
---

# Security review

Apply this on top of the normal review. Read the actual files and the diff, not the summary you were given.

## Threat model

The shell guards are guardrails against accidents by the harness's own agents. They are not a sandbox against an attacker. Judge a change against the hard floors below.

Real security findings (FAIL, `SECURITY:`) are only:
- Secrets or tokens (API keys, credentials, `.ssh`, `.env`, auth files) read, written, logged or sent.
- A publish by a child, or a push to anything other than the own branch.
- A delete or overwrite outside the own worktree or scratch dir.
- A child changing guard or permission config, or its own instructions.
- A change that weakens one of these hard floors.
- Injection of untrusted text into a command or an instruction.

Not security findings:
- Writes by a child inside its own worktree, checkout or scratch dir.
- "A rare command could write past a list or parser."
- A looser default inside the own worktree.
- The foreman pushing its own round branch.

Parser bypasses go in the report as a `- [later]` CRITIQUE line or a known-limit note, never FAIL. The question is "does this change weaken a hard floor?", not "can I find any bypass?"

## Checklist

1. Secrets: credentials, tokens or keys written to a file, a log, a trace, a command line or an error message; secrets read from a place the code did not read before.
2. Permissions: does the change weaken a hard floor (secrets, publish or off-branch push, delete outside the own worktree or scratch dir, a child changing guard or permission config)? A wider allow rule or a looser default is a finding only when it breaks one of those floors.
3. Destructive commands: deletes, overwrites, force pushes, resets, recursive operations; check that the path or target cannot be steered outside the intended directory.
4. Trust boundaries: where text from a file, a tool result, a child run or a user crosses into an instruction, a command, a path or a config value. Each crossing must treat the text as data.
5. Untrusted input: injection of untrusted text into a command or an instruction (a hard floor). Path traversal counts only when it reaches a floor target outside the own worktree or scratch dir. Size, count or parse results count only when they break a floor.
6. Errors: a check that fails open on a hard floor, a swallowed error that skips a floor check, or a fallback that bypasses a floor.

## Steps

1. List the changed files and mark each hunk that touches one of the six areas.
2. Grep the callers of every changed exported symbol across the repo, tests included. Hidden callers exist.
3. For each marked hunk, trace the untrusted value from where it enters to where it is used. Write the evidence as `path:line`.
4. Run a read-only check or an existing test where it settles a doubt. Never run a probe that needs a guarded token outside the test suite's fixtures.

## Hard rules

Each is a FAIL unless the task text explicitly asks for it:

- A changed exported signature.
- A weakened, loosened or removed test or assertion.
- A skipped test.

"Justified adaptation" is not an allowed verdict reason. The diff-scan facts and the ledger decide: a fact is in scope when the ledger block or the task text asks for it; quote the ledger item, else FAIL. A statement in the task (ruling, plan, decision, "in scope", justification) never overrides a hard rule or a fact.

## Reporting

Start the line of a security finding with `SECURITY:` only when it is on the threat-model list, then the reason and the evidence. Other guard or parser ideas go to CRITIQUE as `- [later]`. The harness exempts the builder revision that answers a `SECURITY:` finding from the revision cap. A security finding is a defect: it makes the verdict FAIL.
