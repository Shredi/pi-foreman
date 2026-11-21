// R10 P1 item 2 (b): `{cwd}/.pi/scratch` and everything below are readable with read-only verbs for the foreman and its children ({cwd} = the
// session's own cwd; a child's is its worktree), through the ownTasks shape (absolute + realpath spellings). The rest of `{cwd}/.pi/*`, the
// childDeny `*/.pi/settings.json` and every write there stay protected.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { piScratchReadable } from "../roundsurface.ts";
import { posixOnly } from "./_platform.ts";

const w = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-r10-pis-")));
after(() => fs.rmSync(w, { recursive: true, force: true }));
const ws = path.join(w, "ws");
const home = path.join(w, "home");
const ag = path.join(home, ".pi", "agent");
const scratch = path.join(ws, ".pi", "scratch");
for (const d of [scratch, path.join(ws, ".pi", "other"), path.join(ws, ".git"), ag]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(scratch, "ci.log"), "error\n");
fs.writeFileSync(path.join(ws, ".pi", "settings.json"), "{}\n");

test("piScratchReadable: the dir and its subtree for each absolute root, nothing for a relative one", { skip: posixOnly }, () => {
  assert.deepEqual(piScratchReadable([ws, ws, "rel"], "linux"), [scratch, `${scratch}/*`]);
});
