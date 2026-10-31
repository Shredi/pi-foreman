// R75: a no-match review verdict (`no-matching-entry`) is an ask. A session with a UI shows the owner dialog and honours the answer;
// a headless / no-UI session still denies at once; a verdict filed as deny for that entry is read as an ask.
import { test } from "node:test";
import assert from "node:assert/strict";
import { r11Rig } from "./_r11rig.ts";
import { parseGateVerdict } from "../gatereview.ts";
import { loadPolicy } from "../policy.ts";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const NOMATCH_DENY = JSON.stringify({ verdict: "deny", entry: "no-matching-entry", reason: "nothing matched" });
const NOMATCH_ASK = JSON.stringify({ verdict: "ask", entry: "no-matching-entry", reason: "nothing matched" });
const CMD = { command: "terraform plan" };

const never = () => new Promise<never>(() => undefined);
function rig(t: Parameters<typeof r11Rig>[0], reply: string, o: { headless?: boolean; answers?: (string | undefined)[] } = {}) {
  const titles: string[] = [];
  const answers = [...(o.answers ?? [])];
  const ui = { notify: () => undefined, confirm: never, select: async (title: string) => (titles.push(title), answers.shift()), input: async () => "", setStatus: () => undefined, setWidget: () => undefined };
  const registry = { find: () => ({ id: "m" }), getProviderAuthStatus: () => ({ configured: false }), complete: async () => ({ content: [{ type: "text", text: reply }], stopReason: "stop", usage: { input: 1, output: 1 } }) };
  return r11Rig(t, {}, { ctx: { modelRegistry: registry, ui, ...(o.headless ? { hasUI: false, mode: "print" } : {}) }, config: { providers: { fake: { review: { model: "m" }, roles: {} } } } }).then((r) => ({ ...r, titles }));
}

test("UI session + no match: the owner dialog is shown and allow once is honoured", async (t) => {
  for (const reply of [NOMATCH_DENY, NOMATCH_ASK]) {
    const r = await rig(t, reply, { answers: ["allow once"] });
    assert.equal(await r.call("bash", CMD), undefined);
    assert.equal(r.titles.length, 1);
    assert.match(r.titles[0], /no-matching-entry/);
    const d = r.events("dialog").at(-1)!;
    assert.deepEqual([d.guard, d.cause, d.decision, d.rule], ["gate", "ask", "allow once", "no-matching-entry"]);
  }
});

test("UI session + no match: a deny answer blocks the call", async (t) => {
  const r = await rig(t, NOMATCH_DENY, { answers: ["deny and stop"] });
  const res = await r.call("bash", CMD);
  assert.equal(res?.block, true);
  assert.equal(r.titles.length, 1);
});

test("no UI + no match: an immediate deny, no dialog", async (t) => {
  const r = await rig(t, NOMATCH_DENY, { headless: true, answers: ["allow once"] });
  const t0 = Date.now();
  const res = await r.call("bash", CMD);
  assert.ok(Date.now() - t0 < 5000, "elapsed");
  assert.equal(res?.block, true);
  assert.equal(r.titles.length, 0);
  const d = r.events("dialog").at(-1)!;
  assert.deepEqual([d.cause, d.decision, d.rule], ["ask", "no-ui", "no-matching-entry"]);
});

test("parseGateVerdict maps a deny or ask on no-matching-entry to ask; other entries keep their section", () => {
  const policy = loadPolicy({ pkgRoot, agentDir: path.join(pkgRoot, "nonexistent-agent"), cwd: pkgRoot });
  const p = (v: string, entry: string) => parseGateVerdict(JSON.stringify({ verdict: v, entry, reason: "r" }), policy.trusted, ["allow", "deny", "ask"]);
  assert.deepEqual(p("deny", "no-matching-entry"), { verdict: "ask", entry: "no-matching-entry", reason: "r" });
  assert.deepEqual(p("ask", "no-matching-entry"), { verdict: "ask", entry: "no-matching-entry", reason: "r" });
  assert.equal(typeof p("allow", "no-matching-entry"), "string");
  assert.equal(typeof p("deny", "package-install"), "string");
  assert.deepEqual(p("deny", "unknown-network-host"), { verdict: "deny", entry: "unknown-network-host", reason: "r" });
});
