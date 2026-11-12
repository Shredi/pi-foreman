// /foreman doctor and the child extension list after the git guard's removal: the INFO line for set `safety.git.commit.*` keys (and none when unset),
// no git-guard line or child extension, and an old `safety.requiredChildExtensions` entry with the removed guard's id is filtered out.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { r11Rig } from "./_r11rig.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";

type T = Parameters<typeof r11Rig>[0];
type Cmd = { handler: (args: string, ctx: unknown) => Promise<void> };

const INFO = /^INFO safety\.git\.commit\.\* is no longer used; commit messages are checked by the project's commit hooks$/m;
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** The text `/foreman doctor` prints in a rig whose user config carries `config`. */
async function doctor(t: T, config: Record<string, unknown> = {}): Promise<string> {
  const commands = new Map<string, Cmd>();
  const notes: string[] = [];
  const c = await r11Rig(t, {}, {
    config,
    piExtra: { registerCommand: (n: string, cmd: Cmd) => void commands.set(n, cmd) },
    ctx: { ui: { notify: (m: string) => void notes.push(m), confirm: async () => false, select: async () => "approve", setStatus: () => undefined, setWidget: () => undefined } },
  });
  await commands.get("foreman")!.handler("doctor", c.ctx);
  return notes[notes.length - 1];
}

const GUARD = /git[ -]?guard/i;
/** The doctor text without the package root (a checkout directory may carry any name). */
const guardText = (text: string): string => text.split(PKG_ROOT).join("<pkg>");
const extensionLines = (text: string): string[] => text.split("\n").filter((l) => /required child extension [\w.-]+:/.test(l));

/** An existing file `<id>.mjs` in a temp dir, as a `safety.requiredChildExtensions` entry. */
function extensionFile(t: T, id: string): string {
  const dir = fs.realpathSync(mkTestTmp("pf-childext-"));
  t.after(() => rmTestTmp(dir));
  const file = path.join(dir, `${id}.mjs`);
  fs.writeFileSync(file, "export default function () {}\n");
  return file;
}

test("doctor: with safety.git.commit.messagePattern set the config loads and the doctor prints the no-longer-used INFO line once", async (t: T) => {
  const text = await doctor(t, { safety: { git: { commit: { messagePattern: "^feat: " } } } });
  assert.match(text, INFO);
  assert.equal(text.split("\n").filter((l) => l.includes("no longer used")).length, 1);
  assert.match(text, /^OK +config loaded \(0 warning\(s\)\)$/m);
});

for (const commit of [{ requiredTrailers: ["Signed-off-by"] }, { forbiddenTrailers: ["Co-authored-by"] }, { checkCommand: ["true"] }]) {
  test(`doctor: ${Object.keys(commit)[0]} alone prints the INFO line`, async (t: T) => {
    assert.match(await doctor(t, { safety: { git: { commit } } }), INFO);
  });
}

test("doctor: with no commit key set there is no such line", async (t: T) => {
  assert.doesNotMatch(await doctor(t), /no longer used/);
});

test("doctor: other safety.git keys and blank commit values print no such line", async (t: T) => {
  assert.doesNotMatch(await doctor(t, { safety: { git: { protectedBranches: ["release/*"], commit: { messagePattern: "  ", requiredTrailers: [] } } } }), /no longer used/);
});

test("doctor: no git-guard line, and the required child extensions are the adapter alone", async (t: T) => {
  const text = guardText(await doctor(t));
  assert.doesNotMatch(text, GUARD);
  const lines = extensionLines(text);
  assert.equal(lines.length, 1, lines.join("\n"));
  assert.match(lines[0], /required child extension pi-foreman-core-adapter:/);
});

test("a configured safety.requiredChildExtensions entry with the removed guard's id is filtered out; the doctor stays free of it", async (t: T) => {
  // the schema takes path strings; the id is the file name without its extension
  const text = await doctor(t, { safety: { requiredChildExtensions: [extensionFile(t, "pi-foreman-git-guard")] } });
  assert.doesNotMatch(guardText(text), GUARD);
  assert.equal(extensionLines(text).length, 1, extensionLines(text).join("\n"));
});

test("a configured entry with another id is kept next to the adapter (the filter names the guard's id alone)", async (t: T) => {
  const text = await doctor(t, { safety: { requiredChildExtensions: [extensionFile(t, "pi-foreman-other")] } });
  assert.match(text, /required child extension pi-foreman-other:/);
  assert.equal(extensionLines(text).length, 2);
});
