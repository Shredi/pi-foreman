// PR C security round, owner decision (c): inline code and remote commands are judge-first (defaults.ts `danger-inline-code`, `danger-remote`):
// a clear runs, anything else asks the owner (the foreman) or the parent (a child); plain script runs stay unjudged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { r11Rig } from "./_r11rig.ts";

const FORMS = ["python -c 'print(1)'", "python3 -c 'print(1)'", "node -e 'console.log(1)'", "node --eval 'console.log(1)'", "node -p '1+1'", "perl -e 'print 1'", "ruby -e 'puts 1'",
  "bash -c \"$X\"", "python3 - <<'EOF'\nprint(1)\nEOF", "ssh host 'uptime'", "docker exec c ls", "podman exec c ls", "kubectl exec pod -- ls"];
const PLAIN = ["python script.py", "node file.js", "bash -c 'ls'"];

function registry(reply: string, count: { n: number }) {
  return { find: () => ({ id: "m" }), getProviderAuthStatus: () => ({ configured: false }), complete: async () => { count.n++; return { content: [{ type: "text", text: reply }], stopReason: "stop", usage: { input: 1, output: 1 } }; } };
}
const CLEAR = JSON.stringify({ verdict: "clear", reason: "ok" });
const UNSURE = JSON.stringify({ verdict: "unsure", reason: "cannot tell" });

for (const child of [false, true]) {
  const who = child ? "child" : "foreman";
  for (const [name, reply] of [["clear", CLEAR], ["unsure", UNSURE]] as const) {
    test(`inline code and remote commands are judge-first, judge ${name} (${who})`, async (t) => {
      const count = { n: 0 };
      const titles: string[] = [];
      const ui = { notify: () => undefined, confirm: async () => false, select: async (title: string) => { titles.push(title); return undefined; }, input: async () => "", editor: async () => undefined, setStatus: () => undefined, setWidget: () => undefined };
      const config = { providers: { fake: { review: { model: "m" }, roles: { explorer: { model: "fake/e" }, builder: { model: "fake/b" }, reviewer: { model: "fake/r" } } } }, presence: { enabled: false } };
      const r = await r11Rig(t, {}, { child, ctx: { ui, hasUI: false, modelRegistry: registry(reply, count) }, config });
      for (const line of FORMS) {
        const before = count.n;
        const res = await r.call("bash", { command: line });
        assert.equal(count.n, before + 1, `${line}: judge called once`);
        if (name === "clear") assert.equal(res, undefined, `${line}: runs`);
        else assert.ok(res?.block, `${line}: not run`);
      }
      if (name === "clear") for (const line of PLAIN) {
        const before = count.n;
        assert.equal(await r.call("bash", { command: line }), undefined, line);
        assert.equal(count.n, before, `${line}: no judge`);
      }
    });
  }
}
