// r79 item 6: the owner dialog (gatedialog.ts askOwner): four options, remember flow with the trust check passing and failing, deny with
// comment, deny and stop, dismissed denies, the full command in the title (head/tail plus trace file above 60 lines). Pi's selector title is a
// wrapping text without scrolling (extension-selector.js), hence the cut.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { askOwner, commandDisplay, DIALOG_OPTIONS, HEAD_LINES, STOP_TEXT, TAIL_LINES } from "../gatedialog.ts";
import type { OwnerAsk, OwnerDeps } from "../gatedialog.ts";
import { PermStore } from "../permconfig.ts";
import { OWNER_AWAY_TEXT } from "../presencewait.ts";

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
  cause: "danger-deploy: kubectl changes a cluster",
  classifierReason: "no allow entry covers it",
  remember: { sentence: 'Run "kubectl" "apply"', rules: ["Bash(kubectl apply *)"] },
};

function deps(u: ReturnType<typeof ui>, w: ReturnType<typeof world>, extra: Partial<OwnerDeps> = {}) {
  let after = 0;
  const d: OwnerDeps = { ui: u.ui, stateDir: w.state, remember: { store: w.store, afterWrite: () => void after++ }, ...extra };
  return { d, after: () => after };
}
const projectFile = (w: ReturnType<typeof world>) => path.join(w.root, ".workflow", "permissions.json");

test("the dialog offers the four options with cause, classifier reason, cwd and the whole command with the heredoc; allow once runs", async (t) => {
  const w = world(t);
  const u = ui({ select: ["allow once"] });
  const r = await askOwner(ASK, deps(u, w).d);
  assert.deepEqual(r, { allow: true, how: "once", notes: [] });
  assert.deepEqual(u.selects[0].options, [...DIALOG_OPTIONS]);
  const title = u.selects[0].title;
  assert.match(title, /^pi-foreman: bash asks\n/);
  assert.match(title, /cause: danger-deploy: kubectl changes a cluster\nclassifier: no allow entry covers it\ncwd: \/w\n\nkubectl apply -f - <<EOF\nkind: Pod\nEOF$/);
  assert.ok(u.selects[0].signal, "opened with the presence signal");
});

test("a child's ask names role and run", async (t) => {
  const w = world(t);
  const u = ui({ select: ["allow once"] });
  await askOwner({ ...ASK, child: { role: "builder", run: "ab12" } }, deps(u, w).d);
  assert.match(u.selects[0].title, /from the builder \(run ab12\)/);
});

test("no remember offer: three options", async (t) => {
  const w = world(t);
  const u = ui({ select: ["deny and stop"] });
  const r = await askOwner({ ...ASK, remember: undefined }, deps(u, w).d);
  assert.deepEqual(u.selects[0].options, ["allow once", "deny with comment", "deny and stop"]);
  assert.deepEqual(r, { allow: false, how: "stop", reason: STOP_TEXT });
});

test("deny with comment: the typed text reaches the agent; an empty text is a plain user deny", async (t) => {
  const w = world(t);
  const r = await askOwner(ASK, deps(ui({ select: ["deny with comment"], input: "not on prod" }), w).d);
  assert.deepEqual(r, { allow: false, how: "comment", reason: "pi-foreman: denied by the user: not on prod" });
  const plain = await askOwner(ASK, deps(ui({ select: ["deny with comment"], input: "" }), w).d);
  assert.equal(plain.allow === false && plain.reason, "pi-foreman: denied by the user.");
});

test("a dismissed dialog denies, at the first select and at the remember steps", async (t) => {
  const w = world(t);
  const first = await askOwner(ASK, deps(ui({ select: [undefined] }), w).d);
  assert.deepEqual(first, { allow: false, how: "dismissed", reason: "pi-foreman: denied by the user: the dialog was dismissed" });
  const mid = await askOwner(ASK, deps(ui({ select: ["allow and remember", undefined] }), w).d);
  assert.equal(mid.allow, false);
  const pattern = await askOwner(ASK, deps(ui({ select: ["allow and remember", "use this sentence", undefined] }), w).d);
  assert.equal(pattern.allow, false);
  assert.equal(fs.existsSync(projectFile(w)), false);
});

test("allow and remember with the sentence and the pattern rule: written to the project file, then reload and clear", async (t) => {
  const w = world(t);
  const u = ui({ select: ["allow and remember", "use this sentence", "yes"] });
  const x = deps(u, w);
  const r = await askOwner(ASK, x.d);
  assert.equal(r.allow, true);
  assert.equal(r.allow && r.how, "remember");
  assert.equal(u.selects[1].title.includes('Run "kubectl" "apply"'), true, "the proposal sentence is in the title");
  assert.deepEqual(u.selects[1].options, ["use this sentence", "edit the sentence", "cancel"]);
  assert.match(u.selects[2].title, /Bash\(kubectl apply \*\)/);
  assert.deepEqual(u.selects[2].options, ["yes", "no"]);
  const f = JSON.parse(fs.readFileSync(projectFile(w), "utf8"));
  assert.deepEqual(f, { allow: ["Bash(kubectl apply *)"], classifier: { allow: ['Run "kubectl" "apply"'] } });
  assert.equal(x.after(), 1);
});

test("allow and remember, pattern step answered no: only the sentence is written", async (t) => {
  const w = world(t);
  const r = await askOwner(ASK, deps(ui({ select: ["allow and remember", "use this sentence", "no"] }), w).d);
  assert.equal(r.allow, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(projectFile(w), "utf8")), { classifier: { allow: ['Run "kubectl" "apply"'] } });
});

test("no derivable pattern rule: the pattern step is skipped", async (t) => {
  const w = world(t);
  const u = ui({ select: ["allow and remember", "use this sentence"] });
  const r = await askOwner({ ...ASK, remember: { sentence: "Run a shell line the parser cannot read exactly", rules: null } }, deps(u, w).d);
  assert.equal(r.allow, true);
  assert.equal(u.selects.length, 2);
});

test("edit the sentence opens the editor prefilled; the edited text is what is written", async (t) => {
  const w = world(t);
  const u = ui({ select: ["allow and remember", "edit the sentence", "no"], editor: "Apply manifests to the staging cluster." });
  const r = await askOwner(ASK, deps(u, w).d);
  assert.equal(r.allow, true);
  assert.equal(u.editors[0].prefill, 'Run "kubectl" "apply"');
  assert.deepEqual(JSON.parse(fs.readFileSync(projectFile(w), "utf8")).classifier.allow, ["Apply manifests to the staging cluster."]);
});

test("cancel and an emptied editor deny; nothing is written", async (t) => {
  const w = world(t);
  const c = await askOwner(ASK, deps(ui({ select: ["allow and remember", "cancel"] }), w).d);
  assert.deepEqual([c.allow, c.allow === false && c.how], [false, "cancelled"]);
  const e = await askOwner(ASK, deps(ui({ select: ["allow and remember", "edit the sentence"], editor: "  " }), w).d);
  assert.equal(e.allow, false);
  assert.equal(fs.existsSync(projectFile(w)), false);
});

test("the trust check fails: nothing is written, the refusal is shown, the call runs once", async (t) => {
  const w = world(t, false);
  const u = ui({ select: ["allow and remember"] });
  const x = deps(u, w);
  const r = await askOwner(ASK, x.d);
  assert.equal(r.allow, true);
  assert.equal(r.allow && r.how, "once");
  assert.match(u.notes[0], /not remembered: the file is not ignored by git.*\.git\/info\/exclude/);
  assert.equal(fs.existsSync(projectFile(w)), false);
  assert.equal(x.after(), 0);
  assert.equal(u.selects.length, 1, "the owner is not walked through the sentence step first");
});

test("a sentence the writer refuses (over 300 characters) is shown and the call runs once", async (t) => {
  const w = world(t);
  const u = ui({ select: ["allow and remember", "edit the sentence", "no"], editor: "x".repeat(301) });
  const r = await askOwner(ASK, deps(u, w).d);
  assert.equal(r.allow && r.how, "once");
  assert.match(u.notes.at(-1)!, /1 to 300 characters/);
  assert.equal(fs.existsSync(projectFile(w)), false);
});

test("an away owner: denied with the absent text, the dialog is never opened", async (t) => {
  const w = world(t);
  const u = ui({ select: ["allow once"] });
  const r = await askOwner(ASK, deps(u, w, { presence: { refresh: async () => undefined, away: () => true } }).d);
  assert.deepEqual(r, { allow: false, how: "away", reason: OWNER_AWAY_TEXT });
  assert.equal(u.selects.length, 0);
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
