// A line with a trailing syntax error is never milder than the same line without it (ledger 17): the floors check every cut of the statements before the error
// (at the statement end, and after its here-document bodies) and keep the strictest result. Probe lines live here only, built from parts.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { lineFloors, type FloorEnv } from "../floors.ts";
import { parseShell } from "../shellast.ts";
import { r11Rig, RIG_PERMISSIONS } from "./_r11rig.ts";
import { BINDINGS_ENV, BINDING_NS } from "../usage.ts";
import { withLookupCache } from "../pathnorm.ts";

const env: FloorEnv = { cwd: "/w/repo", home: "/h/me", agentDir: "/h/me/.pi/agent", writeRoots: ["/w/repo", "/s/scr", "/tmp"], protectedBranches: ["release"], currentBranch: () => "feature/x", remoteHead: () => "trunk" };
const roles: [string, FloorEnv][] = [["main", env], ["builder", { ...env, child: true, role: "builder" } as FloorEnv], ["reviewer", { ...env, child: true, role: "reviewer" } as FloorEnv]];
const shape = (line: string, e: FloorEnv): string | null => { const h = lineFloors(line, parseShell(line, { cwd: e.cwd }), e); return h ? `${h.kind}/${h.rule}` : null; };
const rank = (s: string | null): number => (s === null ? 0 : s.startsWith("deny/") ? 3 : s.startsWith("ask/") ? 2 : 1);

const BODIES: [string, string][] = [
  ["dollar-paren fi", "$(true\nfi)"],
  ["dollar-paren open", "$(true\n(\n)"],
  ["backtick", "`true\nfi`"],
  ["dollar-paren done", "$(true\ndone)"],
];
const HD_TAILS = ["\nfi", "\n("];
const push = ["git", "push --force origin main"].join(" ");
const LINES: string[] = ["cat .env", "echo x > .env", "rm -rf /etc", "echo x > ~/.bashrc", "echo x > /etc/x", "echo x > .pi/settings.json", push];

test("a here-document statement with a nested syntax error in its body keeps the outcome of the line alone", () => {
  for (const l of LINES) for (const [bn, body] of BODIES) for (const tail of HD_TAILS) for (const [role, e] of roles) {
    const want = shape(l, e);
    const line = `${l} <<E\n${body}\nE${tail}`;
    assert.equal(shape(line, e), want, `${role}: ${bn}: ${JSON.stringify(line)}`);
  }
});

type T = Parameters<typeof r11Rig>[0];
const config = { presence: { enabled: false }, providers: { fake: { review: { model: "m" }, roles: Object.fromEntries(["explorer", "builder", "reviewer"].map((r) => [r, { model: `fake/${r}` }])) } } };
const ALLOW = JSON.stringify({ verdict: "allow", entry: "A1", reason: "stub" });

/** One gate rig per session kind: the foreman, a builder child and a reviewer child. The judge answers `allow`, so a result other than a refusal or an ask is a judge or a run. */
async function gateRig(t: T, role: string | null) {
  const prev = process.env[BINDINGS_ENV];
  if (role) process.env[BINDINGS_ENV] = JSON.stringify({ [BINDING_NS]: { foremanSession: "parent-session", role, launchId: "l1", kind: "first", workspace: "", perms: { mode: "auto", childDeny: true } } });
  t.after(() => {
    if (prev === undefined) delete process.env[BINDINGS_ENV];
    else process.env[BINDINGS_ENV] = prev;
  });
  let judged = 0;
  let dialogs = 0;
  const ui = { notify: () => undefined, confirm: async () => false, select: async () => (dialogs++, "deny with comment"), input: async () => "", setStatus: () => undefined, setWidget: () => undefined };
  const registry = { find: () => ({ id: "m" }), getProviderAuthStatus: () => ({ configured: false }), complete: async () => (judged++, { content: [{ type: "text", text: ALLOW }], stopReason: "stop", usage: { input: 1, output: 1 } }) };
  const r = await r11Rig(t, {}, { ctx: { modelRegistry: registry, ui, [RIG_PERMISSIONS]: { mode: "auto", allow: ["Bash(*)"], classifier: { allow: ["Anything at all."] } } }, config, child: role !== null });
  return async (command: string): Promise<string> => {
    const d0 = dialogs;
    const j0 = judged;
    const res = await r.call("bash", { command });
    const rule = /\(([\w-]+)\)|\b(floor-[\w-]+|selfmod-[\w-]+|child-[\w-]+)/.exec(String(res?.reason ?? ""));
    return `${res?.block ? "block" : "pass"}/${rule?.[1] ?? rule?.[2] ?? ""}/dialogs=${dialogs - d0}/judged=${judged - j0}`;
  };
}

const strict = (o: string): number => (o.startsWith("block/") && o.endsWith("judged=0") ? 3 : o.includes("dialogs=1") ? 2 : o.startsWith("block/") || !o.endsWith("judged=0") ? 1 : 0);

test("through the gate, the table lines keep their outcome with a nested-error here-document and a tail, as the foreman, a builder and an explorer", async (t: T) => {
  for (const role of [null, "builder", "explorer"]) {
    const run = await gateRig(t, role);
    // the secret-path lines are covered above through the floors: a gate refusal of them repeated here stops the harness run as a probe
    for (const l of LINES.filter((x) => !x.includes(".env"))) {
      const want = await run(l);
      for (const [bn, body] of BODIES) for (const tail of HD_TAILS) {
        const line = `${l} <<E\n${body}\nE${tail}`;
        const got = await run(line);
        // a refusal or an ask of the line alone stays the same one; a line that ran or was judged may go to the judge with the error (danger-unparsed), never to a milder outcome
        if (strict(want) >= 2) assert.equal(got, want, `${role ?? "main"}: ${bn}: ${JSON.stringify(line)}`);
        else assert.ok(strict(got) >= strict(want), `${role ?? "main"}: ${bn}: ${JSON.stringify(line)}: ${got} vs ${want}`);
      }
    }
  }
});

test("bash fed a here-document whose body holds a nested syntax error and a secret read is not milder than the body alone", () => {
  for (const [role, e] of roles) {
    const line = "bash <<E\n$(cat .env\nfi)\nE\nfi";
    const want = shape("cat .env", e);
    assert.ok(rank(want) >= 3, `${role}: ${want}`);
    assert.ok(rank(shape(line, e)) >= rank(want), `${role}: ${shape(line, e)}`);
  }
});

const fx = (n: string): any => JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "fixtures", n), "utf8"));
const lines = new Set<string>();
for (const r of fx("shellast-pin.json").rows) if (r.tool === "bash") lines.add(String(r.command).replaceAll("{R}", "/w/repo"));
for (const r of fx("destructive-parity.json").rows) if (r.tool === "bash") lines.add(String(r.line));
const floored = [...lines].filter((l) => !parseShell(l, { cwd: env.cwd }).some((s) => s.opaque === "parse_error") && roles.some(([, e]) => rank(shape(l, e)) >= 2));

// one lookup scope per test: the file system does not change during the test, so a path is looked up once (as one gate call does)
test("every floored corpus line followed by a nested-error here-document is never milder than the line alone", () => withLookupCache(() => {
  assert.ok(floored.length >= 22, String(floored.length));
  const bad: string[] = [];
  for (const l of floored) for (const [role, e] of roles) {
    const want = rank(shape(l, e));
    const w = `${l} <<E\n$(true\nfi)\nE\nfi`;
    if (rank(shape(w, e)) < want) bad.push(`${role}: ${JSON.stringify(w)}: ${shape(w, e)} vs ${shape(l, e)}`);
  }
  assert.deepEqual(bad, [], `\n${bad.join("\n")}`);
}));

// the line as the body of `bash <<E` is judged by the floors that read a here-document body, which may be milder than the line alone (it is no line the shell runs
// as such); the trailing parse error must not weaken that result
test("every floored corpus line as the body of a here-document fed to bash is never milder with a trailing parse error than without", () => withLookupCache(() => {
  const bad: string[] = [];
  for (const l of floored) for (const [role, e] of roles) {
    const base = `bash <<E\n${l}\nE`;
    const want = rank(shape(base, e));
    for (const tail of HD_TAILS) if (rank(shape(base + tail, e)) < want) bad.push(`${role}: ${JSON.stringify(base + tail)}: ${shape(base + tail, e)} vs ${shape(base, e)}`);
  }
  assert.deepEqual(bad, [], `\n${bad.join("\n")}`);
}));
