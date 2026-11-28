// Owner allow sentences, step 1 (D1): `classifier.allow` of the user file and the trusted project file is read again, numbered A1.., capped per entry,
// never counted, and shown by the doctor. The tracked file and a distrusted project file are never read.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { ALLOW_WARN_ENTRIES, PROSE_MAX, PermStore, userFilePath } from "../permconfig.ts";
import type { GitRun } from "../permconfig.ts";
import { permissionLines } from "../doctorlines.ts";
import { mkTestTmp } from "./_tmpbase.ts";

const root = fs.realpathSync(mkTestTmp("pfc-allow-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));
let n = 0;

function store(o: { user?: unknown; project?: unknown; tracked?: unknown; ignored?: boolean } = {}): { s: PermStore; agentDir: string; wt: string; main: string } {
  const base = path.join(root, `w${++n}`);
  const agentDir = path.join(base, "agent");
  const main = path.join(base, "main");
  const wt = path.join(base, "wt");
  for (const d of [path.join(agentDir, "pi-foreman"), path.join(main, ".workflow"), path.join(wt, ".pi")]) fs.mkdirSync(d, { recursive: true });
  if (o.user !== undefined) fs.writeFileSync(userFilePath(agentDir), JSON.stringify(o.user));
  if (o.project !== undefined) fs.writeFileSync(path.join(main, ".workflow", "permissions.json"), JSON.stringify(o.project));
  if (o.tracked !== undefined) fs.writeFileSync(path.join(wt, ".pi", "permissions.json"), JSON.stringify(o.tracked));
  const ignored = o.ignored ?? true;
  const git: GitRun = (args) => {
    if (args[0] === "worktree") return { status: 0, stdout: `worktree ${main}\nHEAD abc\n\nworktree ${wt}\nHEAD abc\n` };
    return { status: args[0] === "check-ignore" ? (ignored ? 0 : 1) : 1, stdout: "" };
  };
  return { s: new PermStore({ agentDir, cwd: wt, home: path.join(base, "home"), git }), agentDir, wt, main };
}
const allow = (...a: string[]) => ({ classifier: { allow: a } });
const doctor = (x: ReturnType<typeof store>): string[] => permissionLines({ store: x.s, agentDir: x.agentDir, cwd: x.wt, pkgRoot: root, config: {}, env: {}, homedir: root });

test("user then trusted project sentences are read, numbered A1.. in that order, with source and hash", () => {
  const x = store({ user: allow("Installing updates on the example servers is fine."), project: allow("Restarting the example service is fine.") });
  const r = x.s.resolve();
  assert.deepEqual(r.allow.map((e) => [e.id, e.text, e.source]), [["A1", "Installing updates on the example servers is fine.", "user"], ["A2", "Restarting the example service is fine.", "project"]]);
  assert.deepEqual(r.allowNotes, []);
  assert.deepEqual(r.ignored, [], "the old key is no longer pushed to ignored");
});

test("the hash is the first 8 hex of sha256 of the text (known vector) and survives renumbering", () => {
  assert.equal(crypto.createHash("sha256").update("abc").digest("hex").slice(0, 8), "ba7816bf");
  const a = store({ user: allow("abc", "second") }).s.resolve();
  assert.deepEqual([a.allow[0].id, a.allow[0].hash], ["A1", "ba7816bf"]);
  const hashOfSecond = a.allow[1].hash;
  const b = store({ user: allow("second") }).s.resolve();
  assert.deepEqual([b.allow[0].id, b.allow[0].hash], ["A1", hashOfSecond]);
});

test("the tracked file and a distrusted project file are never read", () => {
  const tracked = store({ tracked: allow("From a pull.") });
  const t = tracked.s.resolve();
  assert.deepEqual(t.allow, []);
  assert.ok(tracked.s.drainNotices().some((m) => m.includes("classifier.allow") && m.includes("tracked")));
  const dis = store({ project: allow("Not trusted."), ignored: false });
  assert.deepEqual(dis.s.resolve().allow, []);
  assert.ok(dis.s.drainNotices().some((m) => m.includes("classifier.allow sentences are not read")));
});

test("a 300-character entry is read, a 301-character one is skipped with a notice and a doctor WARN naming layer and index", () => {
  const ok = "a".repeat(PROSE_MAX);
  const long = "b".repeat(PROSE_MAX + 1);
  const x = store({ user: allow("first", ok), project: allow("p1", long) });
  const r = x.s.resolve();
  assert.deepEqual(r.allow.map((e) => e.text.length), [5, PROSE_MAX, 2]);
  assert.deepEqual(r.allowNotes, [`project classifier.allow entry 2 skipped: it is longer than ${PROSE_MAX} characters`]);
  assert.ok(x.s.drainNotices().some((m) => m.includes("project classifier.allow entry 2")));
  const lines = doctor(x);
  assert.ok(lines.includes(`WARN permissions: project classifier.allow entry 2 skipped: it is longer than ${PROSE_MAX} characters`), lines.join("\n"));
  const clean = doctor(store({ user: allow(ok) }));
  assert.equal(clean.some((l) => l.startsWith("WARN permissions:")), false);
});

test("hidden characters (newline, C1 control, U+2028/2029, bidi, zero-width) skip the entry with layer, index and reason", () => {
  for (const bad of ["a\nb", "a\u0085b", "a\u2028b", "a\u2029b", "a\u202eb", "a\u2066b", "a\u200bb", "a\ufeffb", "a\u0007b"]) {
    const x = store({ user: allow("good", bad) });
    const r = x.s.resolve();
    assert.deepEqual(r.allow.map((e) => e.text), ["good"], JSON.stringify(bad));
    assert.equal(r.allowNotes.length, 1);
    assert.match(r.allowNotes[0], /^user classifier\.allow entry 2 skipped: it holds a control, line-break, invisible or direction-changing character$/);
    assert.ok(doctor(x).some((l) => l.startsWith("WARN permissions: user classifier.allow entry 2 skipped")));
  }
});

test("no count cap: 41 entries are all read; the doctor warns at 41 and not at 40", () => {
  const list = (k: number) => Array.from({ length: k }, (_, i) => `Sentence number ${i + 1}.`);
  const at40 = store({ user: allow(...list(ALLOW_WARN_ENTRIES)) });
  assert.equal(at40.s.resolve().allow.length, 40);
  assert.equal(doctor(at40).some((l) => l.startsWith("WARN permissions:")), false);
  const at41 = store({ user: allow(...list(41)) });
  assert.equal(at41.s.resolve().allow.length, 41);
  const w = doctor(at41).filter((l) => l.startsWith("WARN permissions:"));
  assert.equal(w.length, 1);
  assert.match(w[0], /41 allow sentences \(\d+ characters, about \d+ tokens\) go to the judge with every call/);
  assert.equal(at41.s.resolve().allow.at(-1)?.id, "A41");
});

test("doctor: the per-layer INFO count (0, 1, 41) and no 'no longer used' line for classifier.allow", () => {
  const info = (x: ReturnType<typeof store>): string => doctor(x).find((l) => l.includes("allow sentences (user"))!;
  assert.equal(info(store()), "INFO permissions: 0 allow sentences (user 0, project 0)");
  assert.equal(info(store({ user: allow("One.") })), "INFO permissions: 1 allow sentences (user 1, project 0)");
  const many = Array.from({ length: 41 }, (_, i) => `S${i}.`);
  assert.equal(info(store({ user: allow(...many.slice(0, 40)), project: allow(many[40]) })), "INFO permissions: 41 allow sentences (user 40, project 1)");
  const lines = doctor(store({ user: { ...allow("One."), allow: ["Bash(ls)"] } }));
  assert.equal(lines.some((l) => l.includes("classifier.allow is no longer used")), false);
  assert.ok(lines.some((l) => l.includes("user allow is no longer used")), "the other leftover keys still print");
});

test("a non-string entry is skipped with a notice; a non-list key invalidates the file like deny", () => {
  const x = store({ user: allow("ok", 5 as unknown as string) });
  assert.deepEqual(x.s.resolve().allow.map((e) => e.text), ["ok"]);
  assert.ok(x.s.drainNotices().some((m) => m.includes("classifier.allow[1] is not a non-empty string")));
  const bad = store({ user: { classifier: { allow: "nope" } } });
  assert.deepEqual(bad.s.resolve().allow, []);
  assert.ok(bad.s.drainNotices().some((m) => m.includes("classifier.allow must be a list of strings")));
});
