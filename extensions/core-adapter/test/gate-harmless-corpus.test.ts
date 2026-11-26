// Plan gate-verify D3 "harmless corpus pin" (ledger items 2 and 6): every row of the judge bench corpus marked `run` or `refuse-ok` never reaches the owner through the handler
// (no owner dialog, no parent ask, no headless no-ui deny row), in every role (main with UI, builder, explorer, reviewer, headless main), in both `gate.unclassified` modes,
// with a judge that answers clear and with one that answers unsure (unsure is a refusal, never a dialog). `owner:*` rows are the bench's measure, not pinned here.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { mkTestTmp } from "./_tmpbase.ts";
import { r11Rig } from "./_r11rig.ts";
import { posixOnly } from "./_platform.ts";
import { gateLogFile } from "../gatelog.ts";
import { BINDINGS_ENV, BINDING_NS } from "../usage.ts";

process.env.PI_OFFLINE = "1";
const base = fs.realpathSync(mkTestTmp("pf-harmless-corpus-"));
after(() => fs.rmSync(base, { recursive: true, force: true }));

type Row = { id: string; command: string; expected: string };
const rows: Row[] = fs
  .readFileSync(path.join(import.meta.dirname, "../../../bench/judge-corpus/corpus.jsonl"), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l) as Row)
  .filter((r) => r.expected === "run" || r.expected === "refuse-ok");
const lines = [...new Map(rows.map((r) => [r.command, r])).values()];

const ROLES = ["main-ui", "builder", "explorer", "reviewer", "headless"] as const;

test("the corpus holds harmless rows", () => assert.ok(rows.length >= 200 && lines.length >= 200, `${rows.length} rows, ${lines.length} distinct`));

for (const role of ROLES) {
  for (const mode of ["allow", "judge"] as const) {
    test(`harmless corpus (${role}, gate.unclassified ${mode}): no row reaches the owner; unsure refuses, clear runs`, { skip: posixOnly }, async (t) => {
      const savedEnv = { b: process.env[BINDINGS_ENV], c: process.env.FOREMAN_CHECKOUT, x: process.exitCode };
      t.after(() => {
        if (savedEnv.b === undefined) delete process.env[BINDINGS_ENV];
        else process.env[BINDINGS_ENV] = savedEnv.b;
        if (savedEnv.c === undefined) delete process.env.FOREMAN_CHECKOUT;
        else process.env.FOREMAN_CHECKOUT = savedEnv.c;
        process.exitCode = savedEnv.x;
      });
      const child = role === "builder" || role === "explorer" || role === "reviewer";
      if (child) process.env[BINDINGS_ENV] = JSON.stringify({ [BINDING_NS]: { foremanSession: "parent-session", role, launchId: "l1", kind: "first", workspace: "", perms: { mode: "auto", childDeny: true } } });
      delete process.env.FOREMAN_CHECKOUT;
      const state = { reply: "clear", asked: 0, judged: 0 };
      const modelRegistry = {
        find: () => ({ id: "m" }),
        getProviderAuthStatus: () => ({ configured: false }),
        complete: async () => {
          state.judged++;
          return { content: [{ type: "text", text: JSON.stringify({ verdict: state.reply, reason: "stub reason" }) }], stopReason: "stop", usage: { input: 1, output: 1 } };
        },
      };
      const ui = { notify: () => undefined, confirm: async () => (state.asked++, false), select: async () => (state.asked++, undefined), input: async () => (state.asked++, ""), setStatus: () => undefined, setWidget: () => undefined };
      const config = { presence: { enabled: false }, gate: { reviewTimeoutMs: 100, unclassified: mode }, providers: { fake: { review: { model: "m" }, roles: Object.fromEntries(["explorer", "builder", "reviewer"].map((r) => [r, { model: `fake/${r}` }])) } } };
      const rig = await r11Rig(t, {}, { ctx: { modelRegistry, ui, ...(role === "headless" ? { hasUI: false, mode: "print" } : {}) }, config, child });
      const ownerRows = (): number => rig.events("dialog").filter((e) => e.guard === "gate").length + gateRows();
      const gateRows = (): number => {
        const f = gateLogFile(rig.agentDir);
        return fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").filter((l) => l.includes('"layer":"dialog"')).length : 0;
      };
      let judged = 0;
      // a floor refusal (no judge call) is the same refusal on the second pass, and a child stops on a repeated one: those lines are not sent twice
      const floored = new Set<string>();
      for (const reply of ["unsure", "clear"]) {
        state.reply = reply;
        for (const r of lines) {
          if (floored.has(r.command)) continue;
          const o0 = ownerRows();
          const a0 = state.asked;
          const j0 = state.judged;
          const res = await rig.call("bash", { command: r.command });
          const what = `${reply} (${role}, ${mode}): ${r.id} ${r.command.replaceAll("\n", "\\n")}\n${JSON.stringify(res)}`;
          assert.equal(ownerRows(), o0, `an owner dialog or ask opened: ${what}`);
          assert.equal(state.asked, a0, `the owner was asked: ${what}`);
          if (state.judged > j0) {
            judged++;
            if (reply === "unsure") assert.ok(res?.block, `unsure did not refuse: ${what}`);
            // a reviewer's read budget (30 reads) ends later calls whatever the judge says
            else assert.ok(!res?.block || /child_read_budget_exceeded/.test(String(res.reason)), `clear did not run: ${what}`);
          } else if (res?.block && reply === "unsure") floored.add(r.command);
        }
      }
      assert.ok(judged >= 20, `${judged} judged calls`);
    });
  }
}
