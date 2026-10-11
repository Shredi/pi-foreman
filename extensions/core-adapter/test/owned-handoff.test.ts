import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { handoffsRootOf, ownedRoots, ownHandoffDirs } from "../owned.ts";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-own-")));
const root = path.join(tmp, "handoffs");
const mk = (name: string, files: Record<string, string>): string => {
  const d = path.join(root, name);
  fs.mkdirSync(d, { recursive: true });
  for (const [f, t] of Object.entries(files)) fs.writeFileSync(path.join(d, f), t);
  return d;
};

test("owned: handoffsRootOf finds the handoffs root", () => {
  const r = ownedRoots({ agentDir: path.resolve("/t/agent"), workspaceRoot: path.resolve("/t/w"), tmpRoot: path.resolve("/t/tmp") });
  assert.equal(handoffsRootOf(r.readWrite), path.join(path.resolve("/t/agent"), "pi-foreman", "handoffs"));
  assert.equal(handoffsRootOf([]), undefined);
});

test("owned: ownHandoffDirs matches the parent or child file against the session's intercom id", () => {
  const asOpener = mk("a-opener", { parent: "me\n", child: "fm-a-111111\n" });
  const asOpened = mk("b-opened", { parent: "boss\n", child: "me\n" });
  mk("c-other", { parent: "someone\n", child: "fm-c-222222\n" });
  mk("d-bare", { "plan.md": "# plan\n" });
  assert.deepEqual(ownHandoffDirs(root, "me").sort(), [asOpener, asOpened]);
  assert.deepEqual(ownHandoffDirs(root, "fm-c-2222"), [], "an id prefix does not match");
  assert.deepEqual(ownHandoffDirs(root, ""), []);
  assert.deepEqual(ownHandoffDirs(root, null), []);
  assert.deepEqual(ownHandoffDirs(undefined, "me"), []);
  assert.deepEqual(ownHandoffDirs(path.join(tmp, "missing"), "me"), []);
});
