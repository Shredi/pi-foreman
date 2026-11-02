// PR5 work folders: the "Work folders" block of `/foreman perms list` (folders, mode, matched spelling, warnings).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { workFoldersBlock } from "../permconfig.ts";
import { r11Rig, RIG_PERMISSIONS } from "./_r11rig.ts";

const homeBase = path.join(os.homedir(), ".cache", "pi-foreman-tests");
fs.mkdirSync(homeBase, { recursive: true });
const folder = fs.realpathSync(fs.mkdtempSync(path.join(homeBase, "pf-wf-stat-")));
const link = `${folder}-link`;
fs.symlinkSync(folder, link);
after(() => {
  fs.rmSync(link, { force: true });
  fs.rmSync(folder, { recursive: true, force: true });
});

test("12 workFoldersBlock: nothing when there are no folders and no warnings", () => {
  assert.deepEqual(workFoldersBlock({ workFolders: [], workFolderNotes: [] }), []);
});

test("12 workFoldersBlock lists folder, mode, the real spelling when it differs, and warnings", () => {
  const lines = workFoldersBlock({ workFolders: [{ path: "/a/b", mode: "auto" }, { path: "/c/d", mode: "read" }], workFolderNotes: ["workFolders 'x' is not an absolute path; dropped"] }, (p) => (p === "/c/d" ? "/real/d" : p));
  assert.equal(lines[0], "Work folders:");
  assert.match(lines[1], /^ {2}\/a\/b \(auto: /);
  assert.doesNotMatch(lines[1], /also matched/);
  assert.match(lines[2], /^ {2}\/c\/d \(read: reads allowed\), also matched as \/real\/d$/);
  assert.equal(lines[3], "  warning: workFolders 'x' is not an absolute path; dropped");
});

test("12 /foreman perms list shows the block with folders, modes, spelling and warnings", async (t) => {
  const notes: string[] = [];
  let command: ((a: string, c: unknown) => Promise<void> | void) | undefined;
  const r = await r11Rig(t, {}, {
    ctx: {
      [RIG_PERMISSIONS]: { workFolders: [{ path: link, mode: "auto" }, { path: path.join(folder, "..", "..", "..", "x-relative-not-absolute") }, { path: "relative/dir", mode: "read" }] },
      ui: { notify: (m: string) => void notes.push(m), confirm: async () => false, select: async () => undefined, setStatus: () => undefined, setWidget: () => undefined },
    },
    config: { presence: { enabled: false } },
    piExtra: { registerCommand: (name: string, def: { handler: (a: string, c: unknown) => Promise<void> | void }) => { if (name === "foreman") command = def.handler; } },
  });
  await command!("perms list", r.ctx);
  const out = notes.join("\n");
  assert.match(out, /Work folders:/);
  assert.ok(out.includes(`${link} (auto:`), out);
  assert.ok(out.includes(`also matched as ${folder}`), out);
  assert.match(out, /warning: workFolders 'relative\/dir' is not an absolute path; dropped/);
});
