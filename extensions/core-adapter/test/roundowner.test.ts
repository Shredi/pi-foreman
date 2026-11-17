// Ledger 7c, owner ruling: per-child worktree ownership. The round worktree is written only by the foreman and its
// builder; every other child role reads it. An isolation worktree is written only by its own child.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { childSurface } from "../roundsurface.ts";

const posix = process.platform !== "win32";
const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-owner-")));
after(() => fs.rmSync(base, { recursive: true, force: true }));
const rt = path.join(base, "repo.worktrees", "round");
const isoA = path.join(base, "repo.worktrees", "worktrees", "round", "pi-worktree-a");
const isoB = path.join(base, "repo.worktrees", "worktrees", "round", "pi-worktree-b");
for (const d of [path.join(rt, "src"), path.join(isoA, "src"), path.join(isoB, "src")]) fs.mkdirSync(d, { recursive: true });
for (const f of [path.join(rt, "src", "a.ts"), path.join(isoA, "src", "a.ts"), path.join(isoB, "src", "a.ts")]) fs.writeFileSync(f, "x\n");
const top = (d: string): string | null => (d.startsWith(isoA) ? isoA : d.startsWith(isoB) ? isoB : d.startsWith(rt) ? rt : null);

test("childSurface: write roots by role", { skip: !posix }, () => {
  assert.deepEqual(childSurface([rt], rt, "builder", process.platform, top), { write: [rt], read: [rt] });
  assert.deepEqual(childSurface([rt], rt, "reviewer", process.platform, top), { write: [], read: [rt] });
  assert.deepEqual(childSurface([rt], isoA, "builder", process.platform, top), { write: [isoA], read: [rt] });
  assert.deepEqual(childSurface([rt], path.join(base, "elsewhere"), "builder", process.platform, top), { write: [], read: [] });
});
