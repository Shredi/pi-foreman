The release script needs to find the newest existing tag for a tag prefix. Its `--prefix` option is passed through from the command line (teams use prefixes like `v`, `cli-v` or `api/`).

- Add `tagsMatching(repoDir: string, pattern: string): string[]` to `src/release.ts`: the tags of `repoDir` that match a git glob pattern, in version order (oldest first).
- Add `latestTag(repoDir: string, prefix: string): string | null`: the newest tag that starts with `prefix`, or null when there is none.
- Add tests that build a throwaway repo with a few tags.
