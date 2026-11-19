# Sources for the repo audit

## Contents

- How to use this file
- Generic sources: git history, review threads, issue labels, markers, suppressions, skipped tests, CI and lint config, CI outcome
- Agent-harness notes
- Runtime verification sources
- Adapter: pi-foreman (one example among several)
- Outcome numbers

## How to use this file

Run every command from the repository root. Each one is read-only. Use `git grep` rather than `grep -r` so that ignored and generated files stay out of the result, and add `-I` so binary files are skipped.

The commands assume a POSIX shell and git. Check a host CLI with `command -v <tool>` before using it. Where a tool is absent, use the language runtime for the same job (for example, a short Node script for a timeout), or record the source as missing and go on with the others.

A source is either read or missing. Record the window you used (a date range or a count) next to every number you report.

## Generic sources

These work on any repository, with or without agent tooling.

### Git history

Reverts, which show a change that had to be undone:

```
git log --since=<date> --grep='^Revert' --format='%h %s'
```

Merged changes, which are the denominator for the shares below. In a squash-merge history, the first-parent log holds one commit per change; its subject usually ends in `(#N)`:

```
git log --first-parent --format='%h %cs %s' <main>
```

In a merge-commit history, list the merges instead:

```
git log --merges --format='%h %cs %s' <main>
```

Quick follow-up fixes, which show a change that needed a second attempt. Use one window length for every change and report it. Two methods; use one and name it:

1. Same files, outside the hotspots. For each merged change, take the paths it touched, skip the paths in the hotspot list below, and count the fix commits in the window after it that touch the same remaining paths:

   ```
   git show --name-only --format= <sha>
   git log --since="<merge date>" --until="<merge date + 14 days>" --format='%h %s' -- <paths>
   ```

   Count only the commits whose subject starts with `fix` or `Fix`.
2. Named fixes. Count fix commits whose subject or body names the earlier change, by its `#N` or its short hash.

A share near 100% means the method saturated (a hot path is touched by almost every change). Report that as weak, not as a finding.

Hotspots, the files that change most often (candidates for a design change or for a check):

```
git log --since=<date> --name-only --format= | sort | uniq -c | sort -rn | head -20
```

Where a workaround came from and where its copies are:

```
git log -S'<pattern>' --oneline --reverse
git grep -I -n '<pattern>'
```

### Review threads (host CLI)

The host CLI is `gh` on GitHub; use the equivalent on another host. With no CLI, the review source is missing.

```
gh pr list --state merged --limit 100 --json number,mergedAt
gh api repos/<owner>/<repo>/pulls/<n>/comments --jq '.[].body'
gh pr view <n> --json reviews --jq '[.reviews[] | select(.state=="CHANGES_REQUESTED")] | length'
```

Group the comment bodies by cause. The third command gives host review rounds for one change: the count of change requests on that pull request.

If the count is zero or near zero for most recent merged changes, the reviews happen somewhere else: an agent harness, a findings store, or chat. Say so in the report, take review rounds from that store (see the adapters), and mark the host count as not meaningful. Do not report it as zero rounds.

### Issue labels

```
gh label list --limit 100
gh issue list --label <label> --state all --limit 200 --json number,title
```

Look for labels that name a recurring kind of defect, such as a regression label or a label for a class of bug. Count the issues per label; a label with two or more issues on one cause is a group.

### Markers

Markers that record a known compromise:

```
git grep -I -n -w -E 'TODO|FIXME|HACK|XXX'
git grep -I -n -i workaround
```

Use `-w` for word boundaries, not `\b`, because `\b` is not portable across git builds.

A marker that names something already removed is a stale doc. A marker that repeats the same text in several files is a copied workaround.

### Suppressions

Places where a check was switched off:

```
git grep -I -n -E 'eslint-disable|@ts-ignore|@ts-expect-error|# type: ignore|# noqa|nolint|#pragma warning disable'
```

Count by the rule or code named in each suppression. The same rule disabled in three or more places is a copied exception, and the rule may need a design change or a narrower check. Before proposing a removal, check that the config which would honour the suppression is tracked (`git ls-files | grep -E 'eslint|ruff'`); a suppression for a linter that is not configured suppresses nothing.

### Skipped tests

```
git grep -I -n -E '\.skip\(|(^|[^[:alnum:]_.])xit\(|@pytest\.mark\.(skip|xfail)|t\.Skip\(|#\[ignore\]'
```

A skipped test with a comment naming a bug is a finding with evidence. A skipped test with no reason is a gap in runtime verification.

### CI and lint config

List the CI workflow files and the lint and type configs, then read them:

```
git ls-files | grep -E '\.github/workflows/|\.gitlab-ci\.yml|Makefile|eslint|ruff|pyproject|tsconfig|biome|golangci'
```

Note which checks run on a pull request and which run only after a merge to main. A check that runs only after merge catches a mistake late, after the change has landed.

### CI outcome

Failure share over the most recent completed runs (GitHub):

```
gh run list --status completed --limit 200 --json conclusion,createdAt --jq '{window: [(map(.createdAt) | min), (map(.createdAt) | max)], runs: (map(.conclusion) | group_by(.) | map({conclusion: .[0], runs: length}))}'
```

Add `--workflow <file>` to count one workflow. Reruns of a failed run count as failures here; say so in the report. Report the `window` the command prints (first and last `createdAt` of the runs counted).

## Agent-harness notes

Any repository where agents write changes may keep these stores. They are generic in kind; the names vary.

- Agent instruction files: `AGENTS.md`, `CLAUDE.md`, per-tool rule directories, role or persona files, and skill directories (`skills/*/SKILL.md`, `.agents/skills`). These are the source for the prose-rule scan in step 6.
- Hook and gate configuration: the checks that already run on an agent's actions, such as hook settings or a pre-commit config. Read them before proposing a new check, so that the proposal does not repeat one that exists.
- Retro or lessons files: sections that record what went wrong in a round. Search with `git grep -n -i -E 'lesson|retro|what went wrong'`.
- Findings stores: review or triage logs with ids, status and a rule or cause. Each finding id is the evidence for its group.
- Run logs: a record of agent runs with a pass or fail result. It is the basis for a run count, when one exists.

A store can be large. Sample it as step 3 says, and say how many items the store holds in total. A store may also hold rows from other repositories; keep the target repository's rows (`foreman findings list --repo OWNER/NAME` or `--workspace here`, see the adapters) and report how many rows you kept.

## Runtime verification sources

Step 7 looks for these. Each one is a candidate for a driven run an agent can repeat:

- A generated feature inventory or site map, built from a config file and read as the user's view of the product. Its presence means the product has a written feature list an agent can check against.
- A replay or end-to-end rig: a directory of recorded scenarios and a runner, with a command that replays them.
- A driver script or CLI with its own tests. A driver without tests is a proposal, not a verification source.
- Snapshot files of screens or terminal output. They show what a run looked like, and a diff against them is a check.
- Kept evidence: screenshots, logs or result files written by a run.

Count what is tracked (`git ls-files | grep -c -E '\.(png|gif|jpe?g)$'` for images), not what exists only on one machine.

## Adapter: pi-foreman

Use this adapter when the repository has pi-foreman's stores for this repository: `skills/` and `config/foreman.defaults.json` in the tree, and round notes in a `.workflow/` directory. The notes may be in this checkout or in another checkout of the same repository; use the notes path the caller names when one is given. A worktree's `.workflow/` may hold only the ledger and scratch files. When the local one lacks `closed/`, look in the checkout that has it.

The `foreman` command is the shell wrapper `bin/foreman` in the pi-foreman checkout. Run it as a command (`bin/foreman findings list`).

- Findings store: `foreman findings list` prints the findings. The subcommands are `record`, `list`, `dismiss` and `export`; `foreman findings` alone prints a usage error. Add `--json` to parse the output. The store belongs to the user account, not to the repository, so it holds rows from other repositories too. Rows written by a current harness carry `workspace`, `repo` and `branch`: `--workspace here` (run from the target checkout) or `--repo OWNER/NAME` keeps only that repository. Older rows have no key and match neither filter, so also filter them by the paths in each row. Report how many rows belong to the repository and how many you kept. Group the kept rows by cause and use the finding ids as evidence. `foreman rounds --workspace here --json` gives the review rounds per change (fail and pass counts, high-stakes rounds, plan reviews, PR number).
- Retro backlog: `foreman backlog list` prints the open items; `foreman backlog list --min-count 2 --json` keeps the entries seen at least twice (`backlog brief --min-count 2` builds the same list but always writes a file, so it is not for the audit, which is read-only). Use `--json` to parse the output, `--workspace <path>` or `--all` to choose the workspace, and `--status all` to include closed items. `foreman backlog -h` shows the `--cwd` option. Each open item is a candidate group; check whether a later round closed it.
- Closed rounds: `.workflow/closed/*/result.md`, the result file of each round. Its open-issues or left-open list is a source of repeated findings:

  ```
  grep -n -i -E 'left open|open issues' .workflow/closed/*/result.md
  ```

  Round directories are named by slug and carry no date, so the directory name does not sort them by time. Sort the result files by the date of their last commit (`git log -1 --format=%cs -- <file>`), or by mtime (`ls -t`) when a file has no commit yet, and say which one you used. Sample the 20 most recent.
- Feature map and driver: `docs/features.md` is generated from `config/features.json` and is the user's-view feature list. The replay rig is `tests/replay/` with the runner `scripts/replay_run.mjs`. Installer screen snapshots are in `tests/installer/screens/`.
- Release plan findings: the findings section of a release plan, when the repository keeps one.

## Outcome numbers

The repository may already produce these. Report each one with its window and its source.

| Number | Source | Command | Caveat |
| --- | --- | --- | --- |
| Revert share | git history | `git log --since=<date> --grep='^Revert' --format='%h %s'`, divided by merged changes in the same window | Counts undone changes only; a bug fixed in a later change is missing from it. A `^Revert` match inside a body line is not a revert: check the subject |
| Follow-up fix share per merged change | git history | the two methods in "Git history" above | Name the method and the window length; a share near 100% is weak |
| CI failure share | CI runs | the `gh run list` command in "CI outcome" above | Reruns count as failures |
| Review rounds per change | review threads, or the harness's store | the `reviews` command in "Review threads" above, or the adapter's store | A host count of zero is not meaningful when reviews happen elsewhere |

Where the product has a user-facing measure, such as the timing of a key interaction from the repository's own test or benchmark output, add it next to these numbers. A count of changes says how fast the work moves; a user-facing measure says whether the product got better.
