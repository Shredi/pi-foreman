---
name: handoff
description: Writes a handoff document that lets a fresh agent session continue the current work. Use when asked to "hand off", "write a handoff", "write a brief for the next session", "summarise this for another agent" or "prepare a result for the parent session". Not for compacting the current session or for a status report to the owner.
---

# Handoff

Write a document a fresh agent can pick up and continue, without this conversation.

1. Tailor it to what the next session is for (the argument, or the brief's goal). Leave out what that goal does not need.
2. End with a `## Suggested skills` section: each skill the next agent should use, with its name and location. Pi has no Skill tool; the agent reads the `SKILL.md`.
3. Reference existing artifacts (plan, ledger, spec, ADR, issue, PR, commit, diff, earlier brief) by path, URL or hash; do not restate them. Link `AGENTS.md` for the shared repo rules instead of copying them.
4. Redact secrets (keys, tokens, passwords) and personal data the next agent does not need. Text bound for a public place (PR, issue, commit) follows the repo's public rules.
5. Save to the path the harness names (the session handoff dir: `brief.md`, `brief-<n>.md`, `result.md`; the close result file). Otherwise save to the OS temp dir (`$TMPDIR`, else `/tmp`; `%TEMP%` on Windows), never the workspace.

Source: https://github.com/mattpocock/skills/tree/main/skills/productivity/handoff (MIT, adapted; see NOTICE).
