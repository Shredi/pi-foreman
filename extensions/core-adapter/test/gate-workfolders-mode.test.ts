// PR5 work folders at the mode step (index.ts folderRelaxes): a relaxed call runs under auto when the resolved mode is ask or deny, only for the
// default/user/profile mode sources, never for dangerous calls; the allowed trace event carries mode, source and no path. Driven through the adapter rig
// with a user permissions.json that names the folder.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { r11Rig, RIG_PERMISSIONS } from "./_r11rig.ts";

// the folder lives below the home dir (a folder outside it only warns), outside every gate tmp root
const homeBase = path.join(os.homedir(), ".cache", "pi-foreman-tests");
fs.mkdirSync(homeBase, { recursive: true });
const folder = fs.realpathSync(fs.mkdtempSync(path.join(homeBase, "pf-wf-mode-")));
const other = fs.realpathSync(fs.mkdtempSync(path.join(homeBase, "pf-wf-other-")));
fs.mkdirSync(path.join(folder, "repo", ".git", "hooks"), { recursive: true });
after(() => {
  fs.rmSync(folder, { recursive: true, force: true });
  fs.rmSync(other, { recursive: true, force: true });
});

type Handler = (args: string, ctx: unknown) => Promise<void> | void;

async function rig(t: Parameters<typeof r11Rig>[0], perms: Record<string, unknown>, config: Record<string, unknown> = {}) {
  const notes: string[] = [];
  let command: Handler | undefined;
  const r = await r11Rig(t, {}, {
    ctx: { [RIG_PERMISSIONS]: perms, ui: { notify: (m: string) => void notes.push(m), confirm: async () => false, select: async () => undefined, setStatus: () => undefined, setWidget: () => undefined } },
    config: { presence: { enabled: false }, ...config },
    piExtra: { registerCommand: (name: string, def: { handler: Handler }) => { if (name === "foreman") command = def.handler; } },
  });
  const last = (): Record<string, unknown> | undefined => r.events("guard").filter((x) => x.guard === "gate").at(-1);
  return { ...r, notes, last, cmd: (a: string) => command!(a, r.ctx) };
}

const wfs = (mode: "auto" | "read" = "auto") => [{ path: folder, mode }];
const w = (name: string) => ({ path: path.join(folder, name), content: "x" });

test("2 an uncovered write in an auto folder runs under auto when the global mode is ask or deny", async (t) => {
  for (const mode of ["ask", "deny"]) {
    const r = await rig(t, { mode, workFolders: wfs() });
    assert.equal(await r.call("write", w("a.txt")), undefined, mode);
    assert.equal(r.last()?.decision, "allowed", mode);
    assert.equal(r.last()?.rule, "mode:folder:auto", mode);
    assert.equal(await r.call("bash", { command: `touch ${folder}/x` }), undefined, mode);
    assert.equal(r.last()?.rule, "mode:folder:auto", mode);
    assert.equal(await r.call("bash", { command: `mkdir ${folder}/d` }), undefined, mode);
  }
});

test("13 trace: the allowed event carries mode auto and source workFolder and no path", async (t) => {
  const r = await rig(t, { mode: "deny", workFolders: wfs() });
  assert.equal(await r.call("write", w("a.txt")), undefined);
  const g = r.last()!;
  assert.equal(g.mode, "auto");
  assert.equal(g.source, "workFolder");
  assert.ok(!JSON.stringify(r.trace()).includes(folder), "no folder path in the trace");
});

test("2 a read folder, no folder, a redirect and a non-default segment keep the global mode (deny refuses)", async (t) => {
  const ro = await rig(t, { mode: "deny", workFolders: wfs("read") });
  const blocked = async (r: Awaited<ReturnType<typeof rig>>, tool: string, input: Record<string, unknown>): Promise<boolean> => !!(await r.call(tool, input))?.block;
  assert.equal(await blocked(ro, "write", w("a.txt")), true);
  const none = await rig(t, { mode: "deny" });
  assert.equal(await blocked(none, "write", w("a.txt")), true);
  const r = await rig(t, { mode: "deny", workFolders: wfs() });
  assert.equal(await blocked(r, "bash", { command: `echo x > ${folder}/notes.txt` }), true);
  assert.equal(await blocked(r, "bash", { command: `python3 build.py > ${folder}/out.txt` }), true);
  assert.equal(await blocked(r, "bash", { command: `cat /etc/hosts > ${folder}/y` }), true);
  assert.equal(await blocked(r, "bash", { command: `tar -xf a.tgz -C ${folder}/repo` }), true);
});

test("4 protected places and a dangerous class inside the folder are not relaxed", async (t) => {
  const r = await rig(t, { mode: "deny", workFolders: wfs() });
  for (const [tool, input] of [
    ["write", { path: path.join(folder, "repo", ".git", "config"), content: "x" }],
    ["write", { path: path.join(folder, "repo", ".pi", "extensions", "x.ts"), content: "x" }],
    ["bash", { command: `touch ${folder}/repo/.GIT/hooks/x` }],
    ["bash", { command: `touch ${folder}/x && git push origin main` }],
  ] as [string, Record<string, unknown>][]) {
    await r.call(tool, input);
    assert.notEqual(r.last()?.rule, "mode:folder:auto", JSON.stringify(input));
  }
  // .pi/scratch relaxes
  assert.equal(await r.call("write", { path: path.join(folder, "repo", ".pi", "scratch", "n"), content: "x" }), undefined);
  assert.equal(r.last()?.rule, "mode:folder:auto");
});

test("6 a session override and a floors-only session do not consult the folders", async (t) => {
  const r = await rig(t, { mode: "ask", workFolders: wfs() });
  await r.cmd("perms mode deny");
  assert.equal((await r.call("write", w("a.txt")))?.block, true);
  await r.cmd("perms mode auto");
  assert.equal(await r.call("write", w("b.txt")), undefined);
  assert.notEqual(r.last()?.rule, "mode:folder:auto");
  const f = await rig(t, { mode: "deny", workFolders: wfs() }, { gate: { mode: "floors-only" } });
  assert.equal(await f.call("write", w("c.txt")), undefined);
  assert.notEqual(f.last()?.rule, "mode:folder:auto");
  assert.equal(f.last()?.source, undefined);
});

test("8 paths in two folders or one outside: the resolved mode stands", async (t) => {
  const r = await rig(t, { mode: "deny", workFolders: [{ path: folder, mode: "auto" }, { path: other, mode: "auto" }] });
  assert.equal((await r.call("foreman_move", { src: path.join(folder, "a.txt"), dst: path.join(other, "b.txt") }))?.block, true);
  assert.equal((await r.call("foreman_move", { src: path.join(folder, "a.txt"), dst: path.join(os.tmpdir(), "..", "zz-out.txt") }))?.block, true);
  assert.equal(await r.call("foreman_move", { src: path.join(folder, "a.txt"), dst: path.join(folder, "b.txt") }), undefined);
});

test("with the global mode auto or allow nothing changes: no folder label", async (t) => {
  for (const mode of ["auto", "allow"]) {
    const r = await rig(t, { mode, workFolders: wfs() });
    await r.call("write", w("a.txt"));
    assert.notEqual(r.last()?.rule, "mode:folder:auto", mode);
  }
});
