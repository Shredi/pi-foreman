# Lane A wiring for lane B (`index.ts`, harness-friction)

> Temporary hand-off from lane A3 to lane B: where `index.ts` calls `ownedRoots` and `resolveNpmRoot`, and what each consumer takes.
> Read it before wiring the owned dirs into the overlay, the shell write guard, `foreman_wait` and the recheck budget.
> The round's finalizer deletes this file once lane B has wired it.

Lane A3 added `extensions/core-adapter/owned.ts` (pure) and the policy grants (baseline + generator). Nothing is wired in `index.ts`; defaults keep today's behaviour. Lane B adds:

## 1. Session start (next to `buildOverlayRules`, ~index.ts:384, in the `Session` construction)

```ts
import { ownedRoots, resolveNpmRoot } from "./owned.ts";
import { defaultSpawner } from "./spawn.ts";
import { scratchRoot } from "./childscratch.ts";
...
const npmRootP = resolveNpmRoot({ spawn: defaultSpawner, env: process.env, platform: process.platform, execPath: process.execPath }); // once per session, 4 s cap
const tmpRoot = path.dirname(scratchRoot() ?? path.join(os.tmpdir(), "pi-foreman-scratch"));
const computeOwned = (npmRoot: string | null) => ownedRoots({ agentDir, workspaceRoot: workspaceOf(cwd).root, tmpRoot, npmRoot });
// s.owned = computeOwned(null) at construction; void npmRootP.then((r) => { s.owned = computeOwned(r); rebuild s.overlay });
```

`tmpRoot` must be the realpath'd temp dir (`scratchRoot()` returns `<realpath tmpdir>/pi-foreman-scratch`, so take its dirname). Never await the promise on the hot path.

## 2. Overlay (A2 adds the argument in `permoverlay.ts`)

Pass `s.owned` as the new `owned` argument of `buildOverlayRules(...)` / `MatchCtx`. The npm root is known only after the promise settles: rebuild `s.overlay` in the same `.then` (or pass a getter if A2 chose one). For children the overlay blocks the `readWrite` roots and `foreman.json`/`settings.json`; the child's own `$FOREMAN_SCRATCH` stays allowed (A2).

## 3. Shell write guard

At ~index.ts:1765 add the last argument of `shellWriteGuardPayload(...)`: `ownedDirs = mode === "main" ? literal readWrite dirs : []`. `s.owned.readWrite` has one wildcard entry (`<agentDir>/sessions/*/subagent-artifacts`): expand it with `fs.readdirSync(<agentDir>/sessions)` to the existing dirs, or leave it out (the guard takes literal dirs). Children get `[]`.

## 4. `foreman_wait`

`parseStart(params, limits, bound)`: add `owned: s.owned.readWrite` to the `PathBoundOpts` built for the foreman. `checkWaitPath` then accepts `kind: "file"` paths under those roots; siblings and symlink escapes stay refused (`test/wait-owned.test.ts`). Children have no `foreman_wait`.

## 5. Recheck exemptions (plan D3, `readBudgetCheck` ~index.ts:1019)

Exempt a read/bash/codemode call when every path operand is under `s.owned.readWrite` or `s.owned.readOnly` (`underOwned(root, p, platform)` from `owned.ts` handles the `*` segment) or is named `ruling.md`; exempt bash `git worktree add|list|prune`; exempt `foreman_wait`.

## 6. Doctor

`renderPermissions` (permsys.ts) needs no change: it runs `permissions_gen.py render`, which resolves `{scratchRoot}` and `{npmRoot}` itself with the same tmpdir and npm rules. If the doctor's env differs from the installer's (`TMPDIR`, npm prefix) the file reads `stale`: run `foreman setup` again.
