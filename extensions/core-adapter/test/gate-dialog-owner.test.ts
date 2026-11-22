// r79 item 6: the owner dialog (gatedialog.ts askOwner): three options (allow once, deny with comment, deny and stop), deny with
// comment, deny and stop, dismissed denies, the full command in the title (head/tail plus trace file above 60 lines). Pi's selector title is a
// wrapping text without scrolling (extension-selector.js), hence the cut.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { askOwner, commandDisplay, DIALOG_OPTIONS, HEAD_LINES, TAIL_LINES } from "../gatedialog.ts";
import type { OwnerAsk, OwnerDeps } from "../gatedialog.ts";
import { PermStore } from "../permconfig.ts";

function world(t: { after(f: () => void): void }, trusted = true) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-owner-dialog-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (args: string[]) => {
    if (args[0] === "worktree") return { status: 0, stdout: `worktree ${root}\n` };
    if (args[0] === "ls-files") return { status: 1, stdout: "" };
    if (args[0] === "check-ignore") return { status: trusted ? 0 : 1, stdout: "" };
    return { status: 1, stdout: "" };
  };
  const store = new PermStore({ agentDir: path.join(root, "agent"), cwd: root, home: root, git });
  const state = path.join(root, "state");
  return { root, store, state };
}

type Script = { select?: (string | undefined)[]; input?: string; editor?: string | undefined };
function ui(s: Script) {
  const selects: { title: string; options: string[]; signal?: AbortSignal }[] = [];
  const editors: { title: string; prefill?: string }[] = [];
  const notes: string[] = [];
  const answers = [...(s.select ?? [])];
  return {
    selects,
    editors,
    notes,
    ui: {
      select: async (title: string, options: string[], opts?: { signal?: AbortSignal }) => (selects.push({ title, options, signal: opts?.signal }), answers.shift()),
      input: async () => s.input,
      editor: async (title: string, prefill?: string) => (editors.push({ title, prefill }), s.editor),
      notify: (m: string) => void notes.push(m),
    },
  };
}

const ASK: OwnerAsk = {
  tool: "bash",
  payload: "kubectl apply -f - <<EOF\nkind: Pod\nEOF",
  cwd: "/w",
  cause: "danger-git: git config change",
  classifierReason: "the judge was unsure",
};

function deps(u: ReturnType<typeof ui>, w: ReturnType<typeof world>, extra: Partial<OwnerDeps> = {}) {
  let after = 0;
  const d: OwnerDeps = { ui: u.ui, stateDir: w.state, ...extra };
  return { d, after: () => after };
}

test("the dialog offers the three options (no remember) with cause, classifier reason, cwd and the whole command with the heredoc; allow once runs", async (t) => {
  const w = world(t);
  const u = ui({ select: ["allow once"] });
  const r = await askOwner(ASK, deps(u, w).d);
  assert.deepEqual(r, { allow: true, how: "once", notes: [] });
  assert.deepEqual(u.selects[0].options, [...DIALOG_OPTIONS]);
  const title = u.selects[0].title;
  assert.match(title, /^pi-foreman: bash asks\n/);
  assert.match(title, /cause: danger-git: git config change\nclassifier: the judge was unsure\ncwd: \/w\n\nkubectl apply -f - <<EOF\nkind: Pod\nEOF$/);
  assert.ok(u.selects[0].signal, "opened with the presence signal");
});

test("a child's ask names role and run", async (t) => {
  const w = world(t);
  const u = ui({ select: ["allow once"] });
  await askOwner({ ...ASK, child: { role: "builder", run: "ab12" } }, deps(u, w).d);
  assert.match(u.selects[0].title, /from the builder \(run ab12\)/);
});

test("deny with comment: the typed text reaches the agent; an empty text is a plain user deny", async (t) => {
  const w = world(t);
  const r = await askOwner(ASK, deps(ui({ select: ["deny with comment"], input: "not on prod" }), w).d);
  assert.deepEqual(r, { allow: false, how: "comment", reason: "pi-foreman: denied by the user: not on prod" });
  const plain = await askOwner(ASK, deps(ui({ select: ["deny with comment"], input: "" }), w).d);
  assert.equal(plain.allow === false && plain.reason, "pi-foreman: denied by the user.");
});

test("an away owner: the dialog is opened and the absent text is never the answer", async (t) => {
  const w = world(t);
  const u = ui({ select: ["allow once"] });
  const r = await askOwner(ASK, deps(u, w, { presence: { refresh: async () => undefined, away: () => true } }).d);
  assert.equal(r.allow, true);
  assert.notEqual((r as { how?: string }).how, "away");
  assert.equal(u.selects.length, 1);
});

test("presence disabled: an away-reporting presence is never probed and the dialog opens", async (t) => {
  const w = world(t);
  const u = ui({ select: ["allow once"] });
  let refreshed = 0;
  const presence = { refresh: async () => void refreshed++, away: () => true };
  const r = await askOwner(ASK, deps(u, w, { presence, presenceEnabled: false }).d);
  assert.notEqual((r as { how?: string }).how, "away");
  assert.equal(refreshed, 0);
  assert.equal(u.selects.length, 1);
});

test("long commands: 60 lines show in full; more show head and tail, name the trace file, and the file holds everything", (t) => {
  const w = world(t);
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`);
  const full = commandDisplay(lines(60).join("\n"), w.state);
  assert.equal(full.file, undefined);
  assert.equal(full.text.split("\n").length, 60);
  const text = lines(100).join("\n");
  const cut = commandDisplay(text, w.state);
  const shown = cut.text.split("\n");
  assert.equal(shown.length, HEAD_LINES + 1 + TAIL_LINES);
  assert.equal(shown[0], "line 1");
  assert.equal(shown[HEAD_LINES - 1], `line ${HEAD_LINES}`);
  assert.match(shown[HEAD_LINES], /^\.\.\. \[40 lines omitted; the full text is in .*gate-ask-1\.txt\]$/);
  assert.equal(shown.at(-1), "line 100");
  assert.equal(fs.readFileSync(cut.file!, "utf8"), text);
  assert.match(commandDisplay(text, w.state).file!, /gate-ask-2\.txt$/);
});

test("the dialog title for a long command carries the omission line; no 4000-character cut", async (t) => {
  const w = world(t);
  const u = ui({ select: ["allow once"] });
  const payload = `echo ${"y".repeat(5000)}`;
  await askOwner({ ...ASK, payload }, deps(u, w).d);
  assert.ok(u.selects[0].title.includes(payload));
});

test("control characters of a command do not reach the terminal", (t) => {
  const w = world(t);
  assert.equal(commandDisplay("echo \u001b[2Jx\ry", w.state).text, "echo ?[2Jx?y");
});

// ------------------------------------------------------------------ plan asks-wait-for-owner D1: presence never closes or denies a dialog

/** A ui whose select stays open until the owner answers (`answer`) or its signal aborts (which resolves undefined, as Pi's selector does). */
function holdingUi() {
  const selects: { signal?: AbortSignal }[] = [];
  let answer: (v: string | undefined) => void = () => undefined;
  const u = {
    select: (_title: string, _options: string[], opts?: { signal?: AbortSignal }) =>
      new Promise<string | undefined>((res) => {
        selects.push({ signal: opts?.signal });
        answer = res;
        opts?.signal?.addEventListener("abort", () => res(undefined), { once: true });
      }),
    input: async () => undefined,
    editor: async () => undefined,
    notify: () => undefined,
  };
  return { selects, u, answer: (v: string | undefined) => answer(v) };
}

test("an away owner: the dialog opens with a signal of its own and its answer applies", async (t) => {
  const w = world(t);
  const u = ui({ select: ["allow once"] });
  const r = await askOwner(ASK, deps(u, w, { presence: { refresh: async () => undefined, away: () => true } }).d);
  assert.equal(r.allow && r.how, "once");
  assert.equal(u.selects.length, 1);
  assert.ok(u.selects[0].signal instanceof AbortSignal);
});

test("an owner who turns away while the dialog is open: no probe, no watchdog, the signal is not aborted", async (t) => {
  const w = world(t);
  const h = holdingUi();
  let away = false;
  let refreshed = 0;
  let timersSet = 0;
  const timers = { set: () => (timersSet++, 1), clear: () => undefined };
  const p = askOwner(ASK, deps({ ui: h.u } as never, w, { ui: h.u, presence: { refresh: async () => void refreshed++, away: () => away }, presenceTimers: timers, presenceIntervalMs: 5 }).d);
  await new Promise((r) => setTimeout(r, 30));
  away = true;
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(h.selects.length, 1);
  assert.equal(h.selects[0].signal?.aborted, false);
  assert.equal(timersSet, 0, "no presence timer runs during a dialog");
  assert.equal(refreshed, 0);
  h.answer("allow once");
  const r = await p;
  assert.equal(r.allow && r.how, "once");
});

test("the call's abort signal closes the dialog without an answer: aborted, not dismissed, not away; an aborted signal opens nothing", async (t) => {
  const w = world(t);
  const h = holdingUi();
  const ac = new AbortController();
  const p = askOwner(ASK, deps({ ui: h.u } as never, w, { ui: h.u, signal: ac.signal }).d);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(h.selects[0].signal?.aborted, false);
  ac.abort();
  const r = await p;
  assert.equal(r.allow, false);
  assert.equal((r as { how?: string }).how, "aborted");
  const h2 = holdingUi();
  const r2 = await askOwner(ASK, deps({ ui: h2.u } as never, w, { ui: h2.u, signal: ac.signal }).d);
  assert.equal((r2 as { how?: string }).how, "aborted");
  assert.equal(h2.selects.length, 0);
});

test("the owner's own dismissal still denies", async (t) => {
  const w = world(t);
  const u = ui({ select: [undefined] });
  const r = await askOwner(ASK, deps(u, w).d);
  assert.equal((r as { how?: string }).how, "dismissed");
});

test("the options carry no remember entry", () => {
  assert.deepEqual([...DIALOG_OPTIONS], ["allow once", "deny with comment", "deny and stop"]);
});
