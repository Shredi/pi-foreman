// The `review_verdict` tool of a reviewer child (plan structured-verdicts §2.1, §7 "Tool", "Record", "Missing tool", T12): every refusal names the valid
// choices, the record is written atomically and a second call replaces it, and a child without the channel (no binding, no folder, another role) is refused.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { BINDINGS_ENV, BINDING_NS } from "../usage.ts";
import { checkVerdictCall, MAX_FINDINGS, MAX_ITEMS, NO_TOOL_REASON, VERDICT_FILE, VERDICT_REMINDER, type VerdictRecord } from "../verdict.ts";
import { r11Rig } from "./_r11rig.ts";

type T = { after(fn: () => void | Promise<void>): void };
type Res = { content: { text: string }[]; isError?: boolean; details?: { decision?: string } };
type Tool = { execute: (...a: unknown[]) => Promise<Res> };

const CACHE = Symbol.for("pi-foreman.launch-binding");
const BASE = { foremanSession: "parent-session", role: "reviewer", launchId: "L1", kind: "first", workspace: "" };
const OTHER_KEY = "other-package/1";

interface Child {
  dir: string;
  call: (params: Record<string, unknown>) => Promise<{ text: string; isError: boolean; decision?: string }>;
  record: () => VerdictRecord | null;
  files: () => string[];
  trace: (event: string) => Record<string, unknown>[];
  settle: () => Promise<{ continue?: boolean; entries?: { customType?: string; content?: string }[] } | undefined>;
}

/**
 * A reviewer child whose launch binding is `binding` (null = no binding), over a record folder in the temp dir (`dir: false` = the binding names none that exists).
 * `withTool`: `review_verdict` is among the active tools, so the child does not write the setup record at session start.
 */
async function child(t: T, binding: Record<string, unknown> | null, o: { dir?: boolean; withTool?: boolean } = {}): Promise<Child> {
  const saved = process.env[BINDINGS_ENV];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-sv-tool-"));
  t.after(() => {
    if (saved === undefined) delete process.env[BINDINGS_ENV];
    else process.env[BINDINGS_ENV] = saved;
    delete (globalThis as unknown as Record<symbol, unknown>)[CACHE];
    fs.rmSync(dir, { recursive: true, force: true });
  });
  delete (globalThis as unknown as Record<symbol, unknown>)[CACHE]; // a binding of an earlier rig of this process
  const verdictDir = o.dir === false ? path.join(dir, "missing") : dir;
  if (binding) process.env[BINDINGS_ENV] = JSON.stringify({ [BINDING_NS]: { ...BASE, verdictDir, ...binding }, [OTHER_KEY]: { x: 1 } });
  else delete process.env[BINDINGS_ENV];
  const tools = new Map<string, Tool>();
  const r = await r11Rig(t, { ledgerHelper: "tool" }, {
    child: true,
    config: { presence: { enabled: false }, providers: { fake: { review: { model: "m" }, roles: { reviewer: { model: "fake/reviewer" } } } } },
    piExtra: { registerTool: (d: { name: string } & Tool) => void tools.set(d.name, d), registerCommand: () => undefined, getActiveTools: () => (o.withTool === false ? [] : ["review_verdict"]) },
  });
  return {
    dir,
    call: async (params) => {
      const res = await tools.get("review_verdict")!.execute("id", params, undefined, undefined, r.ctx);
      return { text: res.content.map((c) => c.text).join("\n"), isError: res.isError === true, decision: res.details?.decision };
    },
    record: () => (fs.existsSync(path.join(dir, VERDICT_FILE)) ? (JSON.parse(fs.readFileSync(path.join(dir, VERDICT_FILE), "utf8")) as VerdictRecord) : null),
    files: () => fs.readdirSync(dir).sort(),
    trace: (event) => r.events(event),
    settle: async () => (await r.fire("agent_before_settle", { outcome: "completed", entries: [] })) as { continue?: boolean; entries?: { customType?: string; content?: string }[] } | undefined,
  };
}

const defect = { kind: "defect", text: "the guard is missing", file: "src/guard.ts", line: 3 };

// ------------------------------------------------------------------ the check (the schema both sides share)

test("pass with a failed item or a defect is refused; fail with nothing failed is refused; a fail names what fails", () => {
  const allowed = [1, 2];
  const pass = checkVerdictCall({ verdict: "pass", items: [{ id: 1, result: "fail" }] }, allowed);
  assert.ok("error" in pass && /a pass cannot carry a failed item or a defect finding/.test(pass.error), JSON.stringify(pass));
  const passDefect = checkVerdictCall({ verdict: "pass", findings: [defect] }, allowed);
  assert.ok("error" in passDefect && /a pass cannot carry/.test(passDefect.error));
  const bare = checkVerdictCall({ verdict: "fail", items: [{ id: 1, result: "pass" }] }, allowed);
  assert.ok("error" in bare && /a fail needs at least one item with result fail or one finding of kind defect/.test(bare.error), JSON.stringify(bare));
  const advice = checkVerdictCall({ verdict: "fail", findings: [{ kind: "now", text: "rename it" }, { kind: "later", text: "split it" }] }, allowed);
  assert.ok("error" in advice && /a fail needs/.test(advice.error), "advice findings never fail a review");
  assert.ok("call" in checkVerdictCall({ verdict: "fail", items: [{ id: 2, result: "fail" }] }, allowed));
  assert.ok("call" in checkVerdictCall({ verdict: "fail", findings: [defect] }, allowed));
  assert.ok("call" in checkVerdictCall({ verdict: "pass", items: [{ id: 1, result: "pass" }, { id: 2, result: "open", note: "tests not run" }], findings: [{ kind: "later", text: "tidy" }] }, allowed));
});

test("an unknown or duplicate item id is refused with the valid list; V needs the launch to list it", () => {
  const unknown = checkVerdictCall({ verdict: "pass", items: [{ id: 9, result: "pass" }] }, [1, 4, 6]);
  assert.ok("error" in unknown && /item 9 is not one of this launch's items: the items of this launch are 1, 4, 6/.test(unknown.error), JSON.stringify(unknown));
  const twice = checkVerdictCall({ verdict: "pass", items: [{ id: 4, result: "pass" }, { id: 4, result: "open" }] }, [1, 4, 6]);
  assert.ok("error" in twice && /item 4 is given twice/.test(twice.error), JSON.stringify(twice));
  const v = checkVerdictCall({ verdict: "pass", items: [{ id: "V", result: "pass" }] }, [1, 2]);
  assert.ok("error" in v && /item V is not one of this launch's items/.test(v.error), "a launch without V in its items cannot pass V");
  assert.ok("call" in checkVerdictCall({ verdict: "pass", items: [{ id: "V", result: "pass" }] }, ["V"]));
  const none = checkVerdictCall({ verdict: "pass", items: [{ id: 1, result: "pass" }] }, []);
  assert.ok("error" in none && /this launch takes no items/.test(none.error), JSON.stringify(none));
  const bad = checkVerdictCall({ verdict: "pass", items: [{ id: "x", result: "pass" }] }, [1]);
  assert.ok("error" in bad && /an item id is an item number or "V"/.test(bad.error));
});

test("incomplete needs a reason; the reason, texts, notes and files are one line within their caps", () => {
  const no = checkVerdictCall({ verdict: "incomplete" }, []);
  assert.ok("error" in no && /an incomplete verdict needs a reason/.test(no.error), JSON.stringify(no));
  assert.ok("error" in checkVerdictCall({ verdict: "incomplete", reason: "   " }, []));
  const ok = checkVerdictCall({ verdict: "incomplete", reason: "the tests do not start" }, []);
  assert.ok("call" in ok && ok.call.reason === "the tests do not start");
  assert.ok("error" in checkVerdictCall({ verdict: "incomplete", reason: "a\nb" }, []));
  assert.ok("error" in checkVerdictCall({ verdict: "incomplete", reason: "x".repeat(301) }, []));
  assert.ok("error" in checkVerdictCall({ verdict: "fail", findings: [{ kind: "defect", text: "x".repeat(301) }] }, []), "finding text cap");
  assert.ok("error" in checkVerdictCall({ verdict: "fail", findings: [{ kind: "defect", text: "two\nlines" }] }, []), "finding text is one line");
  assert.ok("error" in checkVerdictCall({ verdict: "pass", items: [{ id: 1, result: "pass", note: "x".repeat(201) }] }, [1]), "note cap");
  assert.ok("error" in checkVerdictCall({ verdict: "fail", findings: [{ kind: "defect", text: "t", file: "f".repeat(201) }] }, []), "file cap");
  assert.ok("error" in checkVerdictCall({ verdict: "fail", findings: [{ kind: "defect", text: "t", line: 0 }] }, []), "line is 1 or more");
});

test("caps: at most 64 items and 50 findings per call; an unknown kind, class or verdict is refused", () => {
  const ids = Array.from({ length: MAX_ITEMS + 1 }, (_, i) => i + 1);
  const many = checkVerdictCall({ verdict: "pass", items: ids.map((id) => ({ id, result: "pass" })) }, ids);
  assert.ok("error" in many && new RegExp(`at most ${MAX_ITEMS} items`).test(many.error), JSON.stringify(many));
  assert.ok("call" in checkVerdictCall({ verdict: "pass", items: ids.slice(0, MAX_ITEMS).map((id) => ({ id, result: "pass" })) }, ids));
  const findings = Array.from({ length: MAX_FINDINGS + 1 }, (_, i) => ({ kind: "later", text: `note ${i}` }));
  const tooMany = checkVerdictCall({ verdict: "pass", findings }, []);
  assert.ok("error" in tooMany && new RegExp(`at most ${MAX_FINDINGS} findings`).test(tooMany.error), JSON.stringify(tooMany));
  assert.ok("call" in checkVerdictCall({ verdict: "pass", findings: findings.slice(0, MAX_FINDINGS) }, []));
  assert.ok("error" in checkVerdictCall({ verdict: "fail", findings: [{ kind: "blocker", text: "t" }] }, []), "kind");
  assert.ok("error" in checkVerdictCall({ verdict: "fail", findings: [{ kind: "defect", text: "t", class: "typo" }] }, []), "class");
  assert.ok("error" in checkVerdictCall({ verdict: "approve" }, []), "verdict word");
  assert.ok("error" in checkVerdictCall(null, []));
});

// ------------------------------------------------------------------ the tool in a reviewer child

test("the tool records a valid call; a high-stakes launch refuses any item with the no-items text; the record is not written by a refusal", async (t) => {
  const c = await child(t, { items: [1, 2] });
  const bad = await c.call({ verdict: "pass", items: [{ id: 1, result: "fail" }] });
  assert.equal(bad.isError, true);
  assert.equal(bad.decision, "refused");
  assert.match(bad.text, /a pass cannot carry/);
  assert.equal(c.record(), null, "a refused call leaves no record");
  const ok = await c.call({ verdict: "pass", items: [{ id: 1, result: "pass" }, { id: 2, result: "open", note: "not run" }] });
  assert.equal(ok.isError, false, ok.text);
  assert.match(ok.text, /recorded: pass, 2 item results/);
  const rec = c.record();
  assert.equal(rec?.v, 1);
  assert.equal(rec?.launchId, "L1");
  assert.deepEqual(rec?.items, [{ id: 1, result: "pass" }, { id: 2, result: "open", note: "not run" }]);
  assert.deepEqual(c.files(), [VERDICT_FILE], "no temp file stays behind (atomic write)");
  assert.deepEqual(c.trace("review_verdict_call").map((e) => [e.accepted, e.reason ?? e.verdict]), [[false, "invalid"], [true, "pass"]]);

  const hs = await child(t, { items: [1, 2], highStakes: true });
  const refused = await hs.call({ verdict: "pass", items: [{ id: 1, result: "pass" }] });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /item 1 is not one of this launch's items: this launch takes no items/);
  assert.equal(hs.record(), null);
  const noItems = await hs.call({ verdict: "pass" });
  assert.equal(noItems.isError, false, noItems.text);
});

test("a second call replaces the first and the result says so and names the given items the call left out", async (t) => {
  const c = await child(t, { items: [1, 2, 3] });
  const first = await c.call({ verdict: "fail", items: [{ id: 1, result: "fail" }], findings: [defect] });
  assert.equal(first.isError, false, first.text);
  assert.doesNotMatch(first.text, /replaced/);
  assert.match(first.text, /Items this call left out \(they stay open\): 2, 3\./);
  assert.equal(c.record()?.verdict, "fail");
  const second = await c.call({ verdict: "pass", items: [{ id: 1, result: "pass" }, { id: 3, result: "pass" }] });
  assert.equal(second.isError, false, second.text);
  assert.match(second.text, /This call replaced your earlier record\./);
  assert.match(second.text, /Items this call left out \(they stay open\): 2\./);
  const rec = c.record();
  assert.equal(rec?.verdict, "pass");
  assert.deepEqual(rec?.items.map((i) => i.id), [1, 3]);
  assert.deepEqual(rec?.findings, []);
});

test("V is accepted only when the launch lists it (the item V of a launch without items is refused in the tool)", async (t) => {
  const without = await child(t, { items: [1] });
  const refused = await without.call({ verdict: "pass", items: [{ id: "V", result: "pass" }] });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /item V is not one of this launch's items/);
  const none = await child(t, {});
  assert.equal((await none.call({ verdict: "pass", items: [{ id: "V", result: "pass" }] })).isError, true, "a binding without items takes none");
  const withV = await child(t, { items: [1, "V"] });
  assert.equal((await withV.call({ verdict: "pass", items: [{ id: "V", result: "pass" }] })).isError, false);
  assert.deepEqual(withV.record()?.items, [{ id: "V", result: "pass" }]);
});

test("no binding, a binding without a folder that exists, or a role that does not review: refused with the channel text, nothing written", async (t) => {
  const channel = /this launch has no verdict channel \(no record folder from the foreman\); give the verdict in your report/;
  const none = await child(t, null);
  const a = await none.call({ verdict: "pass" });
  assert.equal(a.isError, true);
  assert.match(a.text, channel);
  assert.equal(none.record(), null);
  const gone = await child(t, { items: [1] }, { dir: false });
  const b = await gone.call({ verdict: "pass" });
  assert.equal(b.isError, true);
  assert.match(b.text, channel);
  const builder = await child(t, { role: "builder", items: [1] });
  const c = await builder.call({ verdict: "pass" });
  assert.equal(c.isError, true);
  assert.match(c.text, channel);
  assert.equal(builder.record(), null);
  assert.deepEqual(none.trace("review_verdict_call").map((e) => [e.accepted, e.reason]), [[false, "no_channel"]]);
});

// ------------------------------------------------------------------ the reminder before the child settles (§2.4)

test("a reviewer child that ends without a verdict is sent back once with the reminder; a recorded verdict or a second end lets it settle", async (t) => {
  const c = await child(t, { items: [1] });
  const first = await c.settle();
  assert.equal(first?.continue, true);
  assert.equal(first?.entries?.find((e) => e.customType === "pi-foreman-stop-gate")?.content, VERDICT_REMINDER);
  assert.deepEqual(c.trace("stop_hold").map((e) => e.guard), ["review_verdict"]);
  assert.notEqual((await c.settle())?.continue, true, "one continue per run");
  const done = await child(t, { items: [1] });
  assert.equal((await done.call({ verdict: "pass", items: [{ id: 1, result: "pass" }] })).isError, false);
  assert.notEqual((await done.settle())?.continue, true, "a record owes nothing");
  const setup = await child(t, { items: [1] }, { withTool: false });
  assert.notEqual((await setup.settle())?.continue, true, "the setup record counts as a record");
  const noFolder = await child(t, { items: [1] }, { dir: false });
  assert.notEqual((await noFolder.settle())?.continue, true, "no record folder, no reminder");
  const builder = await child(t, { role: "builder", items: [1] });
  assert.notEqual((await builder.settle())?.continue, true, "another role is not reminded");
});

// ------------------------------------------------------------------ the setup record (A6) and the env key (T12)

test("a reviewer child whose active tools lack review_verdict writes the incomplete record with the setup reason", async (t) => {
  const c = await child(t, { items: [1] }, { withTool: false });
  const rec = c.record();
  assert.equal(rec?.verdict, "incomplete");
  assert.equal(rec?.reason, NO_TOOL_REASON);
  assert.deepEqual(rec?.items, []);
  assert.deepEqual(c.trace("review_verdict_call").map((e) => [e.accepted, e.reason]), [[false, "no_tool"]]);
  const withTool = await child(t, { items: [1] });
  assert.equal(withTool.record(), null, "with the tool active nothing is written");
});

test("T12: after the binding is read, the child's env lacks the pi-foreman key and keeps another package's key", async (t) => {
  await child(t, { items: [1] });
  const left = JSON.parse(process.env[BINDINGS_ENV] ?? "{}") as Record<string, unknown>;
  assert.equal(BINDING_NS in left, false, "the binding key is gone from the env a subprocess inherits");
  assert.deepEqual(left[OTHER_KEY], { x: 1 });
  const only = fs.mkdtempSync(path.join(os.tmpdir(), "pf-sv-env-"));
  t.after(() => fs.rmSync(only, { recursive: true, force: true }));
  delete (globalThis as unknown as Record<symbol, unknown>)[CACHE];
  process.env[BINDINGS_ENV] = JSON.stringify({ [BINDING_NS]: { ...BASE, verdictDir: only } });
  await r11Rig(t, {}, { child: true, piExtra: { registerTool: () => undefined, registerCommand: () => undefined, getActiveTools: () => ["review_verdict"] } });
  assert.equal(process.env[BINDINGS_ENV], undefined, "nothing else in it: the variable goes");
});
