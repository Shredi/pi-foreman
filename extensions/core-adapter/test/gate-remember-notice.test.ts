// perms-remember-away part A (dialog side): what the owner is told after a remember (project name, file, stored sentence and rules, the
// only-under-auto line), after a refused remember (the call ran once, nothing or only some rules stored), and the options of a child-ask dialog.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { askOwner, EXACT_OPTION } from "../gatedialog.ts";
import type { OwnerAsk, OwnerDeps, RememberStore } from "../gatedialog.ts";
import { PermStore } from "../permconfig.ts";

function world(t: { after(f: () => void): void }, trusted = true) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-remember-notice-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (args: string[]) => {
    if (args[0] === "worktree") return { status: 0, stdout: `worktree ${root}\n` };
    if (args[0] === "ls-files") return { status: 1, stdout: "" };
    if (args[0] === "check-ignore") return { status: trusted ? 0 : 1, stdout: "" };
    return { status: 1, stdout: "" };
  };
  const agentDir = path.join(root, "agent");
  const store = new PermStore({ agentDir, cwd: root, home: root, git });
  const user = (body: Record<string, unknown>) => {
    fs.mkdirSync(path.join(agentDir, "pi-foreman"), { recursive: true });
    fs.writeFileSync(path.join(agentDir, "pi-foreman", "permissions.json"), JSON.stringify(body));
  };
  return { root, store, user, file: path.join(root, ".workflow", "permissions.json") };
}

function ui(select: (string | undefined)[]) {
  const selects: { title: string; options: string[] }[] = [];
  const notes: { text: string; level?: string }[] = [];
  const answers = [...select];
  return {
    selects,
    notes,
    ui: {
      select: async (title: string, options: string[]) => (selects.push({ title, options }), answers.shift()),
      input: async () => "",
      editor: async () => undefined,
      notify: (text: string, level?: "info" | "warning" | "error") => void notes.push({ text, level }),
    },
  };
}

const ASK: OwnerAsk = {
  tool: "bash",
  payload: "kubectl apply -f x.yaml",
  cwd: "/w",
  cause: "danger-deploy: kubectl changes a cluster",
  remember: { sentence: 'Run "kubectl" "apply"', rules: ["Bash(kubectl apply *)"], exact: ["Bash(kubectl apply -f x.yaml)"] },
};
const deps = (u: ReturnType<typeof ui>, store: RememberStore): OwnerDeps => ({ ui: u.ui, remember: { store, afterWrite: () => undefined } });

test("remember with a sentence and a rule: the notice names the project, the file, the sentence and the rule", async (t) => {
  const w = world(t);
  const u = ui(["allow and remember", "use this sentence", "yes"]);
  const r = await askOwner(ASK, deps(u, w.store));
  assert.equal(r.allow && r.how, "remember");
  const n = u.notes.at(-1)!;
  assert.equal(n.level, "info");
  const lines = n.text.split("\n");
  assert.ok(lines[0].includes(`project ${path.basename(w.root)}`), lines[0]);
  assert.ok(lines[0].includes(w.file), lines[0]);
  assert.ok(lines[0].indexOf(path.basename(w.root)) < lines[0].indexOf(w.file));
  assert.ok(n.text.includes('sentence: Run "kubectl" "apply"'));
  assert.ok(n.text.includes("rule: Bash(kubectl apply *)"));
});

test("remember, exact-command variant: the notice names the project, the file and the exact rule", async (t) => {
  const w = world(t);
  const u = ui([EXACT_OPTION]);
  const r = await askOwner(ASK, deps(u, w.store));
  assert.equal(r.allow && r.how, "remember");
  const n = u.notes.at(-1)!.text;
  assert.ok(n.includes(`project ${path.basename(w.root)}`));
  assert.ok(n.includes(w.file));
  assert.ok(n.includes("rule: Bash(kubectl apply -f x.yaml)"));
  assert.doesNotMatch(n, /sentence/);
});

test("base mode allow in the user file with a session override auto: the notice says the sentence is only used under auto; base mode auto: it does not", async (t) => {
  const w = world(t);
  w.user({ mode: "allow" });
  w.store.setSessionMode("auto");
  assert.equal(w.store.resolve().mode, "auto");
  const u = ui(["allow and remember", "use this sentence", "no"]);
  await askOwner(ASK, deps(u, w.store));
  assert.match(u.notes.at(-1)!.text, /only used under mode auto; sessions here otherwise run mode allow/);

  const w2 = world(t);
  const u2 = ui(["allow and remember", "use this sentence", "no"]);
  await askOwner(ASK, deps(u2, w2.store));
  assert.doesNotMatch(u2.notes.at(-1)!.text, /only used under mode/);

  // a rule alone (exact variant) stores no sentence: no such line even outside auto
  const w3 = world(t);
  w3.user({ mode: "ask" });
  const u3 = ui([EXACT_OPTION]);
  await askOwner(ASK, deps(u3, w3.store));
  assert.doesNotMatch(u3.notes.at(-1)!.text, /only used under mode/);
});

test("refused write, untrusted file: the owner is told the call ran once and nothing was stored", async (t) => {
  const w = world(t, false);
  const u = ui(["allow and remember"]);
  const r = await askOwner(ASK, deps(u, w.store));
  assert.equal(r.allow && r.how, "once");
  assert.equal(r.allow && r.refused, true);
  assert.equal(u.notes.at(-1)!.level, "warning");
  assert.match(u.notes.at(-1)!.text, /call runs once and nothing was stored/);
  assert.equal(fs.existsSync(w.file), false);
});

test("refused write, invalid JSON: the owner is told the call ran once and nothing was stored", async (t) => {
  const w = world(t);
  fs.mkdirSync(path.dirname(w.file), { recursive: true });
  fs.writeFileSync(w.file, "{ not json");
  const u = ui(["allow and remember", "use this sentence", "no"]);
  const r = await askOwner(ASK, deps(u, w.store));
  assert.equal(r.allow && r.how, "once");
  assert.equal(r.allow && r.refused, true);
  assert.match(u.notes.at(-1)!.text, /not valid JSON/);
  assert.match(u.notes.at(-1)!.text, /call runs once and nothing was stored/);
  assert.equal(fs.readFileSync(w.file, "utf8"), "{ not json");
});

test("refused write, write error: the owner is told the call ran once and nothing was stored", async (t) => {
  const w = world(t);
  const store: RememberStore = { projectDistrust: () => null, writeRemember: () => ({ ok: false, reason: "not written: disk full" }) };
  const u = ui(["allow and remember", "use this sentence", "no"]);
  const r = await askOwner(ASK, deps(u, store));
  assert.equal(r.allow && r.how, "once");
  assert.equal(r.allow && r.refused, true);
  assert.match(u.notes.at(-1)!.text, /disk full.*call runs once and nothing was stored/);
  assert.equal(fs.existsSync(w.file), false);
});

test("exact-command mode: a later refused rule names the rules stored and not stored", async (t) => {
  const exact = ["Bash(cd /w)", "Bash(kubectl apply -f x.yaml)"];
  let n = 0;
  const store: RememberStore = { projectDistrust: () => null, writeRemember: () => (++n === 1 ? { ok: true, file: path.join(os.tmpdir(), "p", ".workflow", "permissions.json") } : { ok: false, reason: "not written: disk full" }) };
  const u = ui([EXACT_OPTION]);
  const r = await askOwner({ ...ASK, remember: { ...ASK.remember!, exact } }, deps(u, store));
  assert.equal(r.allow && r.how, "once");
  assert.equal(r.allow && r.refused, true);
  const text = u.notes.at(-1)!.text;
  assert.match(text, /call runs once/);
  assert.ok(text.includes("Stored: Bash(cd /w)."), text);
  assert.ok(text.includes("Not stored: Bash(kubectl apply -f x.yaml)."), text);
});

test("noSentence (a child ask under a parent in mode allow): no sentence option, the exact option stays; without an exact rule no remember at all", async (t) => {
  const w = world(t);
  const normal = ui([undefined]);
  await askOwner(ASK, deps(normal, w.store));
  assert.deepEqual(normal.selects[0].options, ["allow once", "allow and remember", EXACT_OPTION, "deny with comment", "deny and stop"]);

  const u = ui([undefined]);
  await askOwner({ ...ASK, remember: { ...ASK.remember!, noSentence: true } }, deps(u, w.store));
  assert.deepEqual(u.selects[0].options, ["allow once", EXACT_OPTION, "deny with comment", "deny and stop"]);

  const none = ui([undefined]);
  await askOwner({ ...ASK, remember: { ...ASK.remember!, exact: null, noSentence: true } }, deps(none, w.store));
  assert.deepEqual(none.selects[0].options, ["allow once", "deny with comment", "deny and stop"]);
});
