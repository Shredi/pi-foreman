# Sources for the repo audit

## Contents

- How to use this file
- Generic sources: git history, review threads, issue labels, markers, suppressions, skipped tests, CI and lint config
- Agent-harness notes
- Adapter: pi-foreman (one example among several)
- Outcome numbers

## How to use this file

Run every command from the repository root. Each one is read-only. Use `git grep` rather than `grep -r` so that ignored and generated files stay out of the result, and add `-I` so binary files are skipped.

A source is either read or missing. When a host CLI is absent or not signed in, record the source as missing and go on with the others. Record the window you used (a date range or a count) next to every number you report.

## Generic sources

These work on any repository, with or without agent tooling.

### Git history

Reverts, which show a change that had to be undone:

```
git log --since=<date> --grep='^Revert' --format='%h %s'
```

Quick follow-up fixes, which show a change that needed a second attempt. For each merged change, take the paths it touched and look for fix commits in the days after it:

```
git show --name-only --format= <sha>
git log --since="<merge date>" --until="<merge date + 14 days>" --format='%h %s' -- <paths>
```

Count the commits whose subject starts with `fix` or `Fix`. Use the same window length for every change and report it.

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

Group the comment bodies by cause. The third command gives review rounds for one change: the count of change requests on that pull request.

### Issue labels

```
gh label list --limit 100
gh issue list --label <label> --state all --limit 200 --json number,title
```

Look for labels that name a recurring kind of defect, such as a regression label or a label for a class of bug. Count the issues per label; a label with two or more issues on one cause is a group.

### Markers

Markers that record a known compromise:

```
git grep -I -n -E '\b(TODO|FIXME|HACK|XXX)\b|workaround'
```

A marker that names something already removed is a stale doc. A marker that repeats the same text in several files is a copied workaround.

### Suppressions

Places where a check was switched off:

```
git grep -I -n -E 'eslint-disable|@ts-ignore|@ts-expect-error|# type: ignore|# noqa|nolint|#pragma warning disable'
```

Count by the rule or code named in each suppression. The same rule disabled in three or more places is a copied exception, and the rule may need a design change or a narrower check.

### Skipped tests

```
git grep -I -n -E '\.skip\(|\bxit\(|@pytest\.mark\.(skip|xfail)|t\.Skip\(|#\[ignore\]'
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
gh run list --limit 200 --json conclusion --jq 'map(.conclusion) | group_by(.) | map({conclusion: .[0], runs: length})'
```

Add `--workflow <file>` to count one workflow. Reruns of a failed run count as failures here; say so in the report.

## Agent-harness notes

Any repository where agents write changes may keep these stores. They are generic in kind; the names vary.

- Agent instruction files: `AGENTS.md`, `CLAUDE.md`, per-tool rule directories, role or persona files, and skill directories (`skills/*/SKILL.md`, `.agents/skills`). These are the source for the prose-rule scan in step 6.
- Hook and gate configuration: the checks that already run on an agent's actions, such as hook settings or a pre-commit config. Read them before proposing a new check, so that the proposal does not repeat one that exists.
- Retro or lessons files: sections that record what went wrong in a round. Search with `git grep -n -i -E 'lesson|retro|what went wrong'`.
- Findings stores: review or triage logs with ids, status and a rule or cause. Each finding id is the evidence for its group.
- Run logs: a record of agent runs with a pass or fail result. It is the basis for a run count, when one exists.

A store can be large. Sample it as step 3 says, and say how many items the store holds in total.

## Adapter: pi-foreman

This adapter is one example of a harness adapter. Use it only in a repository with pi-foreman's layout (`skills/`, `config/foreman.defaults.json`, and a `.workflow/` directory for round notes). Other harnesses have their own stores; the generic sources cover the rest.

- Findings store: `foreman findings` prints the findings store. Group its items by cause and use the finding ids as evidence.
- Retro backlog: the open items of the retro notes. Each open item is a candidate group; check whether a later round closed it.
- Closed rounds: `.workflow/closed/*/result.md`, the result file of each round. Its open-issues or left-open list is a source of repeated findings:

  ```
  grep -n -i -E 'left open|open issues' .workflow/closed/*/result.md
  ```

  There are many closed rounds. Sample the most recent 20 by directory name, as step 3 says.
- Release plan findings: the findings section of a release plan, when the repository keeps one.

## Outcome numbers

The repository may already produce these. Report each one with its window and its source.

| Number | Source | Command | Caveat |
| --- | --- | --- | --- |
| Revert share | git history | `git log --since=<date> --grep='^Revert' --format='%h %s'`, divided by merged changes in the same window | Counts undone changes only; a bug fixed in a later change is missing from it |
| Follow-up fix share per merged change | git history | the per-change fix search in "Git history" above | Needs a window length; report the one used |
| CI failure share | CI runs | the `gh run list` command in "CI outcome" above | Reruns count as failures |
| Review rounds per change | review threads | the `reviews` command in "Review threads" above | A round is one change request; a discussion without one is not counted |

Where the product has a user-facing measure, such as the timing of a key interaction from the repository's own test or benchmark output, add it next to these numbers. A count of changes says how fast the work moves; a user-facing measure says whether the product got better.
