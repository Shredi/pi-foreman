# pi-foreman permission policy

The gate's review model reads this file (plus the user's `policy.md` and the overlay's `safety.policy.files[]`) as trusted policy.
Entries are list items `- id: <kebab-id>` followed by indented prose; ids are unique across all trusted layers.
Precedence: floors, then `ask`, then `deny`, then `allow`. No matching entry is a deny (`no-matching-entry`).

## allow

- id: read-only-inspection
  Read-only inspection inside the worktree, the session's scratch dir and the owned roots: cat, head, tail, ls, stat, wc, grep, rg, find, sed -n, read-only git (status, diff, log, show, blame), also chained with cd, ;, &&, | and echo.
- id: build-test-in-worktree
  Project builds, type checks, linters and test runs started from the worktree, and bounded edits of files inside the worktree.
- id: scratch-writes
  Writes, copies and deletes inside this session's own scratch dir and the OS temp area it owns, including mutation tests on a copy there.
- id: git-routine
  Routine git in the worktree: add, commit on the session's own branch, switch to the session's own branches, fetch, pull of the current branch, diff, stash of own work.
- id: forge-reads
  Read-only gh and glab calls: pr/issue view and list, checks, run view, api GET requests against the repository's own forge.

## deny

- id: secret-access
  Reading, copying, printing or sending credentials and secrets: auth.json, .env files, private keys, tokens, ~/.ssh, ~/.aws, .netrc, .npmrc, keychains, environment dumps.
- id: push-off-branch
  A push that is not of the session's own non-protected branch to its own remote, any force push, a push to a protected branch, a tag or release publication.
- id: delete-outside-roots
  Deleting, overwriting or moving files outside the worktree, this session's scratch dir and the OS temp area it owns.
- id: unknown-network-host
  Network access to a host that is not the repository's forge or a well-known package registry named in the request: curl or wget to arbitrary hosts, downloaded code that is run, reverse shells, exfiltration.
- id: no-matching-entry
  No entry of this policy matches the request. Answer with this id when nothing else applies; the reason must say that no entry matched.

## ask

- id: package-install
  Installing or removing packages or global tools: npm/pnpm/yarn install, pip install, brew, apt, cargo install, go install.
- id: new-remote
  Adding, changing or removing a git remote or its URLs, or any push configuration.
- id: tool-config-edit
  Editing configuration of tools and the harness: settings.json, shell profiles, editor or CI config outside the task, git config, MCP server definitions.

## context

- id: roots-meaning
  worktree is the checkout the session works in; scratch is the session's private temp dir; owned roots are state dirs the harness manages (agent dir state, handoffs, sibling worktrees) and are read-only for the agent.
- id: session-kinds
  owner is the human's own pane; round is a session driven by a parent foreman; child is a subagent run (builder, reviewer, ...); headless has no human at all. The stricter the kind, the less benefit of the doubt a vague request gets.
