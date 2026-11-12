// perms-remember-away part A: nothing a command or an edited sentence carries drives the owner's terminal. The notices after a remember
// (sentence, pattern rule, exact command) and after a refused write show control characters as `?`, as the dialog title does.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { askOwner, EXACT_OPTION } from "../gatedialog.ts";
import type { OwnerAsk, RememberStore } from "../gatedialog.ts";

const RAW = "evil\u001b]52;c;QUJD\u0007x\u0000y\u009bz";
const SHOWN = "evil?]52;c;QUJD?x?y?z";
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/;

function rig(select: (string | undefined)[], edited?: string) {
  const notes: string[] = [];
  const titles: string[] = [];
  const answers = [...select];
  return {
    notes,
    titles,
    ui: {
      select: async (title: string, _o: string[]) => (titles.push(title), answers.shift()),
      input: async () => "",
      editor: async () => edited,
      notify: (text: string) => void notes.push(text),
    },
  };
}

function store(t: { after(f: () => void): void }, ok: boolean): RememberStore {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-remember-printable-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "proj", ".workflow", "permissions.json");
  return { projectDistrust: () => null, writeRemember: () => (ok ? { ok: true, file } : { ok: false, reason: `not written: ${RAW}.` }), baseMode: () => "ask" };
}

const ASK: OwnerAsk = {
  tool: "bash",
  payload: `echo ${RAW}`,
  cwd: "/w",
  cause: "no rule matches",
  remember: { sentence: `Run ${RAW}`, rules: [`Bash(echo ${RAW} *)`], exact: [`Bash(echo ${RAW})`] },
};
const deps = (r: ReturnType<typeof rig>, s: RememberStore) => ({ ui: r.ui, remember: { store: s, afterWrite: () => undefined } });
const clean = (r: ReturnType<typeof rig>) => {
  assert.ok(r.notes.length > 0);
  for (const n of r.notes) assert.doesNotMatch(n, CONTROL, JSON.stringify(n));
};

test("the title shows the command with `?` for control characters (reference for the notices)", async (t) => {
  const r = rig(["allow once"]);
  await askOwner(ASK, deps(r, store(t, true)));
  assert.ok(r.titles[0].endsWith(`echo ${SHOWN}`), r.titles[0]);
});

test("sentence variant (edited sentence): the notice has no control character and shows what the title shows", async (t) => {
  const r = rig(["allow and remember", "edit the sentence", "no"], `Edited ${RAW}`);
  const a = await askOwner(ASK, deps(r, store(t, true)));
  assert.equal(a.allow && a.how, "remember");
  clean(r);
  assert.ok(r.notes.at(-1)!.includes(`sentence: Edited ${SHOWN}`), r.notes.at(-1));
  assert.ok(r.notes.at(-1)!.includes("only used under mode auto"));
});

test("pattern-rule variant: the rule question and the notice show `?`", async (t) => {
  const r = rig(["allow and remember", "use this sentence", "yes"]);
  await askOwner(ASK, deps(r, store(t, true)));
  clean(r);
  assert.ok(r.notes.at(-1)!.includes(`rule: Bash(echo ${SHOWN} *)`), r.notes.at(-1));
  assert.ok(r.notes.at(-1)!.includes(`sentence: Run ${SHOWN}`));
  for (const title of r.titles.slice(1)) assert.doesNotMatch(title, CONTROL, JSON.stringify(title));
});

test("exact-command variant: the notice shows `?` for the control characters of the command", async (t) => {
  const r = rig([EXACT_OPTION]);
  const a = await askOwner(ASK, deps(r, store(t, true)));
  assert.equal(a.allow && a.how, "remember");
  clean(r);
  assert.ok(r.notes.at(-1)!.includes(`rule: Bash(echo ${SHOWN})`), r.notes.at(-1));
  assert.ok(r.titles[0].endsWith(`echo ${SHOWN}`));
});

test("refused write: the notice has no control character", async (t) => {
  for (const pick of [["allow and remember", "use this sentence", "no"], [EXACT_OPTION]]) {
    const r = rig(pick);
    const a = await askOwner(ASK, deps(r, store(t, false)));
    assert.equal(a.allow && a.how, "once");
    clean(r);
    assert.ok(r.notes.at(-1)!.includes(`not written: ${SHOWN}.`), r.notes.at(-1));
  }
});
