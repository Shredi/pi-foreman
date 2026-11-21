// D105: the verdict-channel refusal names the restart of the session that launched the run: `foreman session restart <label>` (run by the parent)
// when that session is an opened child (its handoff dir is in the binding), else `/quit` and `pi --session <id>` by the owner. The write_failed
// refusal gives no text-verdict fallback.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { BINDINGS_ENV, BINDING_NS } from "../usage.ts";
import { VERDICT_FILE, type VerdictRecord } from "../verdict.ts";
import { r11Rig } from "./_r11rig.ts";

// pi-subagents resolves the global npm root with `npm root -g` on the first skill lookup (no seam); PI_OFFLINE keeps the child rig from starting npm.
process.env.PI_OFFLINE = "1";

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

const HAND = path.join(os.tmpdir(), "handoffs", "20261120-090000-job-a1b2c3");

test("the launching session is an opened child: the refusal names `foreman session restart job`, run by the parent", async (t) => {
  const c = await child(t, { items: [1], handoffDir: HAND }, { dir: false });
  const r = await c.call({ verdict: "pass" });
  assert.equal(r.isError, true);
  assert.match(r.text, /needs a restart \("foreman session restart job", run by your parent\)/);
  assert.doesNotMatch(r.text, /\/quit|pi --session/);
});

test("the launching session is no opened child: the refusal names /quit and `pi --session <id>`, not the restart command", async (t) => {
  const c = await child(t, { items: [1] }, { dir: false });
  const r = await c.call({ verdict: "pass" });
  assert.equal(r.isError, true);
  assert.match(r.text, /needs a restart \(the owner quits that session \(\/quit\) and resumes it with "pi --session parent-session"\)/);
  assert.doesNotMatch(r.text, /foreman session restart/);
});

test("a record that cannot be written is refused without a fallback to a verdict in the report", async (t) => {
  const c = await child(t, { items: [1] });
  fs.mkdirSync(path.join(c.dir, VERDICT_FILE)); // the rename onto a folder fails
  const r = await c.call({ verdict: "pass", items: [{ id: 1, result: "pass" }] });
  assert.equal(r.isError, true);
  assert.equal(c.trace("review_verdict_call").at(-1)?.reason, "write_failed");
  assert.match(r.text, /the record could not be written; call it again/);
  assert.doesNotMatch(r.text, /in your report/);
});
