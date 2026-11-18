// The session-open dialog in the owner-dialog shape: the question, the summary (the asking session's `summary`, else the brief's
// heading), the facts, no brief body, and the shaped-confirm wiring (inline and in the pending flow with the abort signal).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runSessionCommand, runSessionOpenTool } from "../session.ts";
import type { SessionDeps } from "../session.ts";
import type { DialogSpec } from "../ownerdialog.ts";
import { rig, sleep } from "./_session-open-rig.ts";

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-session-dialog-")));
fs.writeFileSync(path.join(root, "b.md"), "\n# Brief: **Finish** the `second` part\n\nSECRET BODY LINE\nmore body\n");
fs.writeFileSync(path.join(root, "nohead.md"), "just text\nand more\n");
fs.writeFileSync(path.join(root, "b.txt"), "# Heading in text\nbody\n");

function deps(over: Partial<SessionDeps> = {}): SessionDeps & { spawned: string[][] } {
  const spawned: string[][] = [];
  return {
    isChild: false,
    env: {},
    agentDir: path.join(root, "agent"),
    cwd: root,
    piSessionId: "sess-1",
    pkgRoot: "/pkg",
    python: "/usr/bin/python3",
    spawner: async (_c, args) => (spawned.push(args), { code: 0, stdout: "handoff: x", stderr: "", timedOut: false }),
    send: async () => "sent",
    spawned,
    ...over,
  };
}

/** The plain confirm of a session: records title and message, answers `yes`. */
function asking(yes = false) {
  const seen: { title: string; message: string }[] = [];
  return { seen, confirm: async (title: string, message: string) => (seen.push({ title, message }), yes) };
}

test("open dialog: the title is the question; the brief body is not shown, its heading is", async () => {
  const a = asking();
  const r = await runSessionCommand(deps({ confirm: a.confirm }), "open demo b.md");
  assert.match(r.text, /\[owner_declined\]/);
  assert.equal(a.seen[0].title, "Open a new session demo?");
  assert.match(a.seen[0].message, /Brief heading: Finish the second part/);
  assert.doesNotMatch(a.seen[0].message, /SECRET BODY|more body/);
  assert.match(a.seen[0].message, /Yes: the session starts +No: nothing opens\s*$/);
});

test("open dialog: no summary falls back to the brief heading (markdown signs and a leading Brief: removed)", async () => {
  const a = asking();
  await runSessionCommand(deps({ confirm: a.confirm }), "open demo b.md");
  assert.equal(a.seen[0].message.split("\n")[0], "Finish the second part");
  const t = asking();
  await runSessionCommand(deps({ confirm: t.confirm }), "open demo b.txt");
  assert.equal(t.seen[0].message.split("\n")[0], "Heading in text");
});

test("open dialog: no summary and no heading: 'A new session for <label>.' and no heading line", async () => {
  const a = asking();
  await runSessionCommand(deps({ confirm: a.confirm }), "open demo nohead.md");
  assert.equal(a.seen[0].message.split("\n")[0], "A new session for demo.");
  assert.doesNotMatch(a.seen[0].message, /Brief heading/);
});

test("open dialog: the tool's summary is the first line, cleaned and cut at 300 characters", async () => {
  const a = asking();
  await runSessionOpenTool(deps({ confirm: a.confirm }), { label: "demo", brief: "b.md", summary: "It does the second part.\x1b[31m red\x1b]8;;http://x\x07 now" });
  const first = a.seen[0].message.split("\n")[0];
  assert.equal(first, "It does the second part. red now");
  assert.doesNotMatch(a.seen[0].message, /\x1b/);
  const b = asking();
  await runSessionOpenTool(deps({ confirm: b.confirm }), { label: "demo", brief: "b.md", summary: "x".repeat(500) });
  assert.equal(b.seen[0].message.split("\n")[0].length, 300);
});

test("open dialog: worktree, plan step, machine and model wordings", async () => {
  const a = asking();
  await runSessionCommand(deps({ confirm: a.confirm }), "open demo b.md --worktree --base v1 --plan-first --model p/x");
  const m = a.seen[0].message;
  assert.match(m, /Worktree: +yes, new branch from v1/);
  assert.match(m, /Plan step: +yes, you approve its plan in its pane/);
  assert.match(m, /Model: +p\/x/);
  assert.match(m, /Machine: +this one/);
  const b = asking();
  await runSessionCommand(deps({ confirm: b.confirm }), "open demo b.md --worktree");
  assert.match(b.seen[0].message, /Worktree: +yes, new branch from the default branch/);
  const c = asking();
  await runSessionCommand(deps({ confirm: c.confirm }), "open demo b.md --machine box --cwd /srv/x");
  assert.match(c.seen[0].message, /Machine: +box/);
  assert.match(c.seen[0].message, /Worktree: +no, it uses this folder as it is/);
});

test("open dialog: the brief is linked in the spec (a .md brief), with its plain path", async () => {
  const specs: DialogSpec[] = [];
  const d = deps({ confirm: asking().confirm, confirmShaped: async (s) => (specs.push(s), false) });
  await runSessionCommand(d, "open demo b.md");
  assert.equal(specs.length, 1);
  assert.deepEqual(specs[0].links, [{ label: "Brief", path: path.join(root, "b.md"), text: "open the brief", kind: "text" }]);
  assert.equal(specs[0].ask, "Open a new session demo?");
});

test("open dialog: No keeps owner_declined and spawns nothing; no answer opens nothing", async () => {
  const d = deps({ confirm: asking(false).confirm });
  assert.match((await runSessionCommand(d, "open demo b.md")).text, /\[owner_declined\]/);
  assert.equal(d.spawned.length, 0);
  const odd = deps({ confirm: (async () => undefined) as unknown as SessionDeps["confirm"] });
  assert.match((await runSessionCommand(odd, "open demo b.md")).text, /\[owner_declined\]/);
  assert.equal(odd.spawned.length, 0);
});

test("confirmShaped present: used inline instead of confirm; Yes opens, No declines", async () => {
  let plainCalls = 0;
  const specs: DialogSpec[] = [];
  const yes = deps({ confirm: async () => (plainCalls++, false), confirmShaped: async (s, signal) => (specs.push(s), assert.equal(signal, undefined), true) });
  const r = await runSessionCommand(yes, "open demo b.md");
  assert.equal(r.ok, true);
  assert.equal(yes.spawned.length, 1);
  assert.equal(plainCalls, 0);
  const no = deps({ confirm: async () => (plainCalls++, true), confirmShaped: async () => false });
  assert.match((await runSessionCommand(no, "open demo b.md")).text, /\[owner_declined\]/);
  assert.equal(no.spawned.length, 0);
  assert.equal(plainCalls, 0);
});

test("confirmShaped absent: the plain confirm runs with the new title and message", async () => {
  const a = asking(true);
  const d = deps({ confirm: a.confirm });
  assert.equal((await runSessionCommand(d, "open demo b.md")).ok, true);
  assert.equal(a.seen.length, 1);
  assert.equal(a.seen[0].title, "Open a new session demo?");
});

test("pending flow: the shaped dialog gets the abort signal; an abort withdraws it and opens nothing", async () => {
  const r = rig({ confirmWaitSeconds: 5 });
  try {
    const ac = new AbortController();
    const first = r.call({ summary: "It finishes the second part." }, ac.signal);
    await sleep(20);
    // the rig's ui has no theme or custom: the shaped dialog runs as the plain confirm with the signal
    assert.equal(r.dialogs.length, 1);
    assert.equal(r.dialogs[0].title, "Open a new session demo?");
    assert.match(r.dialogs[0].message, /^It finishes the second part\./);
    assert.ok(r.dialogs[0].signal, "the dialog got a signal");
    ac.abort();
    const res = await first;
    await sleep(20);
    assert.equal(r.spawned.length, 0);
    assert.doesNotMatch(r.text(res), /opened in Herdr/);
  } finally {
    r.cleanup();
  }
});

test("pending flow: Yes opens, with a stub confirmShaped that receives the signal", async () => {
  const signals: (AbortSignal | undefined)[] = [];
  const d = deps({
    pendingOpens: new Map(),
    confirmShaped: async (_s, signal) => (signals.push(signal), true),
    confirm: async () => false,
  });
  const r = await runSessionOpenTool(d, { label: "demo", brief: "b.md" });
  assert.equal(r.ok, true, r.text);
  assert.equal(d.spawned.length, 1);
  assert.ok(signals[0] instanceof AbortSignal);
});

test("open dialog: the brief heading's first letter is capitalised in the summary and the 'Brief heading:' line", async () => {
  fs.writeFileSync(path.join(root, "lower.md"), "# Brief: a throwaway test session\n\nbody\n");
  const a = asking();
  await runSessionCommand(deps({ confirm: a.confirm }), "open demo lower.md");
  assert.equal(a.seen[0].message.split("\n")[0], "A throwaway test session");
  assert.match(a.seen[0].message, /Brief heading: A throwaway test session/);
  assert.doesNotMatch(a.seen[0].message, /Brief: /);
});
