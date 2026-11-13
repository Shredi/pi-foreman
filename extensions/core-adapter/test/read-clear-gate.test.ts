// The read question through the whole gate (index.ts mode step, classifier.ts Classifier.readClear): a cleared line runs and is logged and traced;
// every other answer keeps today's route; floors, deny sentences and earlier steps win; the cache, the notice and the retro line. The switch and the
// child are in read-clear-child-calls.test.ts. One adapter session (one temp dir) for the gate cases, the scripted model in-process, a distinct line per case
// (the cache is per session); the causes of a non-clear are tested on the Classifier alone.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { inprocSpawner } from "./_read-clear-inproc.ts"; // first: the git answers are in place before the adapter loads
import { r11Rig, RIG_PERMISSIONS } from "./_r11rig.ts";
import { shPath } from "./_shpath.ts";
import { gateLogFile } from "../gatelog.ts";
import { Classifier } from "../classifier.ts";
import type { ClassifierCtx } from "../classifier.ts";
import { readClearHint } from "../permssuggest.ts";

const ROLES = ["explorer", "builder", "reviewer"];
const CHECK = { writes: "no", network: "no", runs: "no", secrets: "no", paths: "inside" };
const READ = JSON.stringify({ verdict: "read", check: CHECK, reason: "only greps files in src" });
const ESC = JSON.stringify({ verdict: "escalate", entry: null, reason: "nothing in the whitelist covers it" });
const ESC_READ = JSON.stringify({ verdict: "escalate", reason: "writes with -o" });
type Reply = string | Error | "hang";

let lines = 0;
/** A distinct reading line per case: the same line in one session is a cache hit. */
const line = (): { command: string } => ({ command: `grep -n foo${++lines} src/*.ts | head -20` });

/** A registry whose first (whitelist) and read questions are told apart by the system text; replies are set per case; `calls` holds every request. */
function scripted() {
  const calls: { kind: "first" | "read"; text: string }[] = [];
  let first: Reply = ESC;
  let read: Reply = READ;
  return {
    calls,
    use(f: Reply, r: Reply) {
      calls.length = 0;
      first = f;
      read = r;
    },
    registry: {
      find: () => ({ id: "m" }),
      getProviderAuthStatus: () => ({ configured: false }),
      complete: async (_m: never, c: { systemPrompt: string; messages: { content: string }[] }) => {
        const kind = /^You are the read judge/.test(c.systemPrompt) ? "read" : "first";
        calls.push({ kind, text: c.messages[0].content });
        const r = kind === "read" ? read : first;
        if (r instanceof Error) throw r;
        if (r === "hang") return new Promise<never>(() => undefined);
        return { content: [{ type: "text", text: r }], stopReason: "stop", usage: { input: 1, output: 1 } };
      },
    },
  };
}
const logOf = (agentDir: string): Record<string, unknown>[] => {
  const f = gateLogFile(agentDir);
  return fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : [];
};
const SHELL = { getShellConfig: () => ({ shell: "/bin/bash", args: ["-c"] }), spawner: inprocSpawner };

/** One rig for a describe block: before() builds it (the session env is process-wide, so one block at a time), after() tears it down. */
function useRig(o: { gate?: Record<string, unknown>; deny?: string[]; mode?: string; perms?: Record<string, unknown>; noSentences?: boolean } = {}) {
  const cleanups: (() => void | Promise<void>)[] = [];
  const model = scripted();
  const titles: string[] = [];
  const answers: string[] = [];
  const notes: string[] = [];
  const h = {} as { r: Awaited<ReturnType<typeof r11Rig>> };
  before(async () => {
    const ui = { notify: (m: string) => void notes.push(m), confirm: async () => false, select: async (title: string) => (titles.push(title), answers.shift() ?? "deny"), input: async () => undefined, setStatus: () => undefined, setWidget: () => undefined };
    const config = {
      providers: { fake: { review: { model: "m" }, roles: Object.fromEntries(ROLES.map((r) => [r, { model: `fake/${r}` }])) } },
      gate: { reviewTimeoutMs: 300, ...o.gate },
      presence: { enabled: false },
    };
    const perms = { ...(o.mode ? { mode: o.mode } : {}), ...o.perms, classifier: { ...(o.noSentences ? {} : { allow: ["Run the project's test suite."] }), ...(o.deny ? { deny: o.deny } : {}) } };
    h.r = await r11Rig({ after: (fn) => void cleanups.push(fn) }, {}, { ctx: { ui, modelRegistry: model.registry, [RIG_PERMISSIONS]: perms }, config, deps: SHELL });
  });
  after(async () => {
    for (const f of cleanups.reverse()) await f();
  });
  /** One case: the scripted replies of the two questions and the owner's dialog answers; clears the previous case's calls and titles. */
  const use = (first: Reply, read: Reply, ...select: string[]) => {
    model.use(first, read);
    titles.length = 0;
    answers.splice(0, answers.length, ...select);
  };
  return { h, model, titles, notes, use, call: (cmd: { command: string }) => h.r.call("bash", cmd), agentDir: () => h.r.agentDir };
}

describe("owner session, an allow sentence and a deny sentence", () => {
  const g = useRig({
    deny: ["Never read the private notes folder."],
    perms: { deny: ["Bash(cat private/*)"], ask: ["Bash(wc *)"], protected: [{ host: "prod-*.example.net" }] },
  });

  test("a line the first call escalates and the read question clears runs; both rows are logged, the second follows the first; the trace has a read-clear review; the requests are as the plan says", async () => {
    g.use(ESC, READ);
    const l = line();
    assert.equal(await g.call(l), undefined);
    assert.deepEqual(g.model.calls.map((c) => c.kind), ["first", "read"]);
    const all = logOf(g.agentDir());
    const clear = all.find((x) => x.rule === "read-clear")!;
    assert.ok(clear, JSON.stringify(all));
    const first = all.find((x) => x.layer === "classifier" && x.rule === "model")!;
    assert.equal(clear.verdict, "allow");
    assert.ok(first?.id && clear.follows === first.id, "follows is the id of the first call's row");
    const ev = g.h.r.events("review").filter((e) => e.entry === "read-clear");
    assert.equal(ev.length, 1);
    assert.equal(ev[0].decision, "allow");
    assert.equal(g.titles.length, 0, "no dialog");
    const read = g.model.calls[1].text;
    assert.ok(read.includes(l.command), read);
    assert.doesNotMatch(read, /Run the project's test suite/, "no allow sentence");
    assert.match(read, /BEGIN DATA DENY [0-9a-f]+\nNever read the private notes folder\.\nEND DATA DENY/, "the deny sentence is fenced data");
    assert.doesNotMatch(g.model.calls[0].text, /inside directories|read question/i, "the first call has no read text");
  });

  test("a vague read answer and a timeout keep today's ask (owner dialog), and log read-clear:<cause>", async () => {
    for (const [name, read, cause] of [["a vague answer", "yes it is fine", "invalid_verdict"], ["a timeout", "hang", "timeout"]] as const) {
      g.use(ESC, read, "deny");
      const res = await g.call(line());
      assert.ok(res?.block, name);
      assert.equal(g.titles.length, 1, `${name}: the owner is asked`);
      const row = logOf(g.agentDir()).filter((x) => String(x.rule).startsWith("read-clear")).at(-1)!;
      assert.equal(row.rule, `read-clear:${cause}`, name);
      assert.equal(row.verdict, "ask", name);
    }
  });

  test("a floor wins: a secret path is denied with no model call at all", async () => {
    g.use(ESC, READ);
    const res = await g.call({ command: "cat ~/.ssh/id_rsa | head" });
    assert.match(String(res?.reason), /permission floor/);
    assert.equal(g.model.calls.length, 0);
  });

  test("earlier steps still win with a model that would answer read: a deny rule, an ask rule, a protected target, a self-modification rule, the shell-write refusal and an opaque-text floor ask end as today", async () => {
    const settings = shPath(`${g.agentDir()}/settings.json`);
    // [line, dialogs the owner is asked]
    const cases: [string, number][] = [
      ["cat private/notes.md; grep x src/*.ts", 0],
      ["wc -l a.txt; grep x src/*.ts", 1],
      ["ssh prod-1.example.net uptime; grep x src/*.ts", 1],
      [`cp x.json ${settings}; grep x src/*.ts`, 1],
      ["echo '{}' > .pi/settings.json; grep x src/*.ts", 0],
      ["$(echo git) push origin main; grep x src/*.ts", 1],
    ];
    for (const [command, dialogs] of cases) {
      g.use(ESC, READ, "deny");
      const res = await g.call({ command });
      assert.ok(res?.block, command);
      assert.equal(g.titles.length, dialogs, `${command}: ${res.reason}`);
      assert.equal(g.model.calls.filter((c) => c.kind === "read").length, 0, `${command}: the read question is not asked`);
    }
  });

  test("another dangerous-class entry (a deploy next to an unreadable segment) is never put to the read question", async () => {
    g.use(ESC, READ, "deny");
    await g.call({ command: "kubectl apply -f x.yaml; grep x src/*.ts" });
    assert.equal(g.model.calls.filter((c) => c.kind === "read").length, 0);
  });

  test("the cache saves only the read call: the same line asks the first question again, not the read question; the notice comes once; the /retro line counts the clears", async () => {
    g.use(ESC, READ);
    const l = line();
    await g.call(l);
    await g.call(l);
    assert.deepEqual(g.model.calls.map((c) => c.kind), ["first", "read", "first"]);
    assert.equal(logOf(g.agentDir()).filter((x) => x.rule === "read-clear" && x.layer === "cache").length, 1);
    const n = g.notes.filter((m) => /gate\.readClear/.test(m));
    assert.equal(n.length, 1, "once per session");
    assert.match(n[0], /can be wrong/);
    assert.match(n[0], /decision log|read-clear/);
    const cleared = logOf(g.agentDir()).filter((x) => x.rule === "read-clear" && x.verdict === "allow").length;
    assert.ok(cleared >= 3, String(cleared));
    const text = String(readClearHint(g.agentDir()));
    assert.match(text, new RegExp(`^${cleared}\\b`));
    assert.match(text, /read/i);
  });

  test("the first call allowing, denying or failing decides: no read question follows an allow or a deny, or a failed first call", async () => {
    const A = JSON.stringify({ verdict: "allow", entry: "A1", reason: "r" });
    const D = JSON.stringify({ verdict: "deny", entry: "D1", reason: "r" });
    for (const [first, expect] of [[A, "run"], [D, "block"], [new Error("down"), "ask"], ["not json", "ask"]] as const) {
      g.use(first, READ, "deny");
      const res = await g.call(line());
      assert.equal(res ? "block" in res && res.block : false, expect !== "run", String(first));
      assert.equal(g.model.calls.filter((c) => c.kind === "read").length, 0, `${String(first)}: no read question`);
    }
  });
});

// the empty-whitelist route (the no_entries row, one read question, the clear that follows it) is in read-clear-child-calls.test.ts, on a headless session
describe("gate.readClear false and no sentences", () => {
  const g = useRig({ noSentences: true, gate: { readClear: false } });

  test("no model call at all and one dialog", async () => {
    g.use(ESC, READ, "deny");
    assert.ok((await g.call(line()))?.block);
    assert.equal(g.model.calls.length, 0);
    assert.equal(g.titles.length, 1);
  });
});

describe("a mode other than auto", () => {
  const g = useRig({ mode: "ask" });

  test("mode ask opens the dialog and asks no model at all", async () => {
    g.use(ESC, READ, "deny");
    assert.ok((await g.call(line()))?.block);
    assert.equal(g.model.calls.length, 0);
    assert.equal(g.titles.length, 1);
  });
});

// ---- Classifier.readClear alone: the cache key

const config2 = { providers: { fake: { roles: { review: { model: "fake/m" } } } } };
function cctx(read: string) {
  const calls: string[] = [];
  const registry = { find: () => ({ id: "m" }), complete: async (_m: never, c: { messages: { content: string }[] }) => (calls.push(c.messages[0].content), { content: [{ type: "text", text: read }], stopReason: "stop", usage: { input: 1, output: 1 } }) };
  const c: ClassifierCtx = { prose: { allow: [], deny: [] }, registry: registry as never, config: config2, provider: "fake", notify: () => undefined, recordUsage: () => undefined, timeoutMs: 200 };
  return { c, calls };
}
const RC = { tool: "bash", payload: "grep -n foo src/*.ts", kind: "owner" as const, role: "foreman", cwd: "/w", inside: ["/w"], notes: ["n"] };

test("the cache: the same line in another cwd, other inside directories, another session kind or role is no hit; non-clears are not cached", async () => {
  const k = new Classifier();
  const { c, calls } = cctx(READ);
  assert.equal((await k.readClear(RC, c)).cleared, true);
  const again = await k.readClear(RC, c);
  assert.equal(again.cleared && again.cached, true);
  assert.equal(calls.length, 1);
  await k.readClear({ ...RC, cwd: "/other" }, c);
  await k.readClear({ ...RC, inside: ["/w", "/extra"] }, c);
  await k.readClear({ ...RC, kind: "child" as never }, c);
  assert.equal(calls.length, 4, "each changed key part asks again");
  k.clearCache();
  await k.readClear(RC, c);
  assert.equal(calls.length, 5, "cleared with the existing cache clears");
  const bad = cctx("nope");
  const k2 = new Classifier();
  await k2.readClear(RC, bad.c);
  await k2.readClear(RC, bad.c);
  assert.equal(bad.calls.length, 2, "a non-clear is not cached");
});

test("same line, other cwd: no cache hit", async () => {
  const k = new Classifier();
  const { c, calls } = cctx(READ);
  await k.readClear(RC, c);
  const other = await k.readClear({ ...RC, cwd: "/elsewhere" }, c);
  assert.equal(other.cleared && other.cached, false);
  assert.equal(calls.length, 2);
});

test("every answer that is not the exact read shape, a provider error and a timeout are no clear with the cause in a read-clear:<cause> row that follows the first row", async () => {
  const cases: [string, Reply, string][] = [
    ["a vague answer", "yes it is fine", "invalid_verdict"],
    ["a wrong check value", JSON.stringify({ verdict: "read", check: { ...CHECK, writes: "unknown" }, reason: "r" }), "invalid_verdict"],
    ["an extra key", JSON.stringify({ verdict: "read", check: CHECK, reason: "r", note: 1 }), "invalid_verdict"],
    ["an allow verdict", JSON.stringify({ verdict: "allow", entry: "A1", reason: "r" }), "invalid_verdict"],
    ["an escalate", ESC_READ, "model"],
    ["a provider error", new Error("boom"), "provider_error"],
    ["a timeout", "hang", "timeout"],
  ];
  for (const [name, reply, cause] of cases) {
    const model = scripted();
    model.use(ESC, reply);
    const rows: Record<string, unknown>[] = [];
    const c: ClassifierCtx = { ...cctx(READ).c, registry: model.registry as never, log: { file: "", record: (r) => (rows.push(r as never), "row1") }, timeoutMs: 100 };
    const res = await new Classifier().readClear({ ...RC, follows: "first1" }, c);
    assert.equal(res.cleared, false, name);
    assert.equal(rows.length, 1, name);
    assert.equal(rows[0].rule, `read-clear:${cause}`, name);
    assert.equal(rows[0].verdict, "ask", name);
    assert.equal(rows[0].follows, "first1", name);
  }
});

test("no model configured: no clear, never an exception", async () => {
  const k = new Classifier();
  const { c } = cctx(READ);
  const r = await k.readClear(RC, { ...c, registry: { find: () => undefined, complete: async () => { throw new Error("x"); } } as never });
  assert.equal(r.cleared, false);
});
