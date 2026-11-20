// PR5 work folders through the adapter rig (a user permissions.json names the folder). Since PR C there is no mode step: the folder's `auto` relaxation
// (`mode:folder:auto`) is gone with the modes, a foreman write outside the worktree runs with no dialog and no judge call, and the floors still apply.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { r11Rig, RIG_PERMISSIONS } from "./_r11rig.ts";
import { shPath } from "./_shpath.ts";

// the folder lives below the home dir (a folder outside it only warns), outside every gate tmp root
const homeBase = path.join(os.homedir(), ".cache", "pi-foreman-tests");
fs.mkdirSync(homeBase, { recursive: true });
const folder = fs.realpathSync(fs.mkdtempSync(path.join(homeBase, "pf-wf-mode-")));
fs.mkdirSync(path.join(folder, "repo", ".git", "hooks"), { recursive: true });
// the folder as a shell word: a win32 backslash path would lose its separators to the parser
const fw = shPath(folder);
after(() => fs.rmSync(folder, { recursive: true, force: true }));

async function rig(t: Parameters<typeof r11Rig>[0], mode: "auto" | "read") {
  const titles: string[] = [];
  const r = await r11Rig(t, {}, {
    ctx: { [RIG_PERMISSIONS]: { workFolders: [{ path: folder, mode }] }, ui: { notify: () => undefined, confirm: async () => false, select: async (title: string) => (titles.push(title), undefined), setStatus: () => undefined, setWidget: () => undefined } },
    config: { presence: { enabled: false } },
  });
  return { ...r, titles };
}

const w = (name: string) => ({ path: path.join(folder, name), content: "x" });

test("a write and a shell write into a work folder run with no dialog, whichever the folder mode", async (t) => {
  for (const mode of ["auto", "read"] as const) {
    const r = await rig(t, mode);
    assert.equal(await r.call("write", w("a.txt")), undefined, mode);
    assert.equal(await r.call("bash", { command: `touch ${fw}/x` }), undefined, mode);
    assert.equal(await r.call("bash", { command: `echo x > ${fw}/notes.txt` }), undefined, mode);
    assert.deepEqual(r.titles, [], mode);
  }
});

test("floors inside a work folder still deny: a git push of main and a recursive extract over a repo", async (t) => {
  const r = await rig(t, "auto");
  for (const command of [`touch ${fw}/x && git push origin main`, `tar -xf a.tgz -C ${fw}/repo`]) {
    const res = await r.call("bash", { command });
    assert.equal(res?.block, true, command);
    assert.match(String(res?.reason), /denied by the permission floor/, command);
  }
  assert.deepEqual(r.titles, []);
});

test("a write to a repo's .git/config in the folder meets the secret-path floor", async (t) => {
  const r = await rig(t, "auto");
  const res = await r.call("write", { path: path.join(folder, "repo", ".git", "config"), content: "x" });
  assert.equal(res?.block, true);
  assert.match(String(res?.reason), /permission floor/);
});
