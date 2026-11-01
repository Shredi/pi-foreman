// r79 ruling-10: a deterministic refusal runs before any dialog or classifier. A foreman shell write wrapped in an opaque form (stdin heredoc
// into python3) is danger-opaque for the gate, but the shell-write refusal answers first: the owner is never asked, the classifier never called.
import { test } from "node:test";
import assert from "node:assert/strict";
import { r11Rig } from "./_r11rig.ts";

test("a refused foreman shell write in a stdin heredoc gets the refusal text, with no dialog and no classifier call", async (t) => {
  let selects = 0;
  let completes = 0;
  const registry = {
    find: () => ({ id: "m" }),
    getProviderAuthStatus: () => ({ configured: false }),
    complete: async () => (completes++, { content: [{ type: "text", text: "{}" }], stopReason: "stop", usage: { input: 1, output: 1 } }),
  };
  const ui = { notify: () => undefined, confirm: async () => false, select: async () => (selects++, "allow once"), input: async () => undefined, setStatus: () => undefined, setWidget: () => undefined };
  const config = { providers: { fake: { review: { model: "m" }, roles: {} } } };
  const r = await r11Rig(t, { foremanEdits: "scratchpad" }, { ctx: { modelRegistry: registry, ui }, config });
  const res = await r.call("bash", { command: "cd \"$PWD\" && python3 - <<'EOF'\nopen('router.go','w').write('package api')\nEOF" });
  assert.ok(res && res.block);
  assert.match(String(res.reason), /shell write into project files refused/);
  assert.equal(selects, 0, "the owner dialog was never opened");
  assert.equal(completes, 0, "the classifier was never called");
});
