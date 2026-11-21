// PR D1: `danger-kill-pattern` (pkill, killall) is judge-first; a busybox/toybox shell reading a heredoc or pipe is `danger-inline-code`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { r11Rig } from "./_r11rig.ts";

const HITS = ["pkill node", "killall x", "env pkill x", "$V/bin/pkill x", "f(){ pkill x; }; f", "busybox sh <<'E'\nls\nE", "echo ls | busybox sh", "toybox sh <<E\nls\nE"];
const RUNS = ["kill 123", "kill $!", "kill %1", "taskkill /PID 1", "pgrep node", "busybox ls", "echo pkill x"];

function registry(reply: string, count: { n: number }) {
  return { find: () => ({ id: "m" }), getProviderAuthStatus: () => ({ configured: false }), complete: async () => { count.n++; return { content: [{ type: "text", text: reply }], stopReason: "stop", usage: { input: 1, output: 1 } }; } };
}
const CLEAR = JSON.stringify({ verdict: "clear", reason: "ok" });
const UNSURE = JSON.stringify({ verdict: "unsure", reason: "cannot tell" });

for (const child of [false, true]) {
  const who = child ? "child" : "foreman";
  for (const [name, reply] of [["clear", CLEAR], ["unsure", UNSURE]] as const) {
    test(`pkill/killall and busybox stdin shells are judge-first, judge ${name} (${who})`, async (t) => {
      const count = { n: 0 };
      const ui = { notify: () => undefined, confirm: async () => false, select: async () => undefined, input: async () => "", editor: async () => undefined, setStatus: () => undefined, setWidget: () => undefined };
      const config = { providers: { fake: { review: { model: "m" }, roles: { explorer: { model: "fake/e" }, builder: { model: "fake/b" }, reviewer: { model: "fake/r" } } } }, presence: { enabled: false } };
      const r = await r11Rig(t, {}, { child, ctx: { ui, hasUI: false, modelRegistry: registry(reply, count) }, config });
      for (const line of HITS) {
        const before = count.n;
        const res = await r.call("bash", { command: line });
        assert.equal(count.n, before + 1, `${line}: judge called once`);
        if (name === "clear") assert.equal(res, undefined, `${line}: runs`);
        else assert.ok(res?.block, `${line}: not run`);
      }
      if (name === "clear") for (const line of RUNS) {
        const before = count.n;
        assert.equal(await r.call("bash", { command: line }), undefined, line);
        assert.equal(count.n, before, `${line}: no judge`);
      }
    });
  }
}
