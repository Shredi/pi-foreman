// Item 2: the child of a [high-stakes] launch cannot close item V through the shell ledger either (marksVerifierCommand, and the bash guard in index.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { marksVerifierCommand } from "../ledgercall.ts";
import { BINDINGS_ENV, BINDING_NS } from "../usage.ts";
import { r11Rig } from "./_r11rig.ts";

// pi-subagents resolves the global npm root with `npm root -g` on the first skill lookup (no seam); PI_OFFLINE keeps the child rig from starting npm.
process.env.PI_OFFLINE = "1";

const REFUSED = [
  "ledger mark V",
  "ledger mark v",
  "ledger mark V --verifier",
  "ledger mark 1 V 2",
  "ledger mark 1,V",
  "ledger mark 3 --verifier",
  "ledger -f .workflow/LEDGER-x.md mark V",
  "ledger -f .workflow/LEDGER-x.md mark V --verifier",
  "/opt/pi-foreman/core/scripts/ledger -f /w/.workflow/LEDGER-x.md mark V",
  "python3 /opt/pi-foreman/core/scripts/ledger.py -f .workflow/LEDGER-x.md mark V",
  "python /opt/pi-foreman/core/scripts/ledger.py mark 'V'",
  "cd .workflow && ledger -f LEDGER-x.md mark V",
  "ledger status && ledger mark V",
  "echo hi; ledger mark 1 V | cat",
  "for n in 4 V; do ledger mark $n; done",
];
const UNCHANGED = [
  "ledger status",
  "ledger mark 3",
  "ledger mark 1 2 && ledger status",
  "ledger -f .workflow/LEDGER-x.md mark 4",
  "python3 /opt/pi-foreman/core/scripts/ledger.py mark 2",
  "cd .workflow && ledger -f LEDGER-x.md note 2 'see V'",
  "ledger add 'V is open'",
  "echo V",
  "git status",
];

test("marksVerifierCommand refuses every shell form that marks V or passes --verifier", () => {
  for (const c of REFUSED) assert.equal(marksVerifierCommand(c), true, c);
});

test("marksVerifierCommand leaves other ledger and shell commands alone, non-strings included", () => {
  for (const c of UNCHANGED) assert.equal(marksVerifierCommand(c), false, c);
  assert.equal(marksVerifierCommand(undefined), false);
  assert.equal(marksVerifierCommand(42), false);
});

for (const mode of ["bash", "tool"] as const) {
  test(`a child with a [high-stakes] binding has the shell ledger V mark refused, ledgerHelper ${mode}; a normal reviewer child is not`, async (t) => {
    const saved = process.env[BINDINGS_ENV];
    t.after(() => {
      if (saved === undefined) delete process.env[BINDINGS_ENV];
      else process.env[BINDINGS_ENV] = saved;
    });
    const rig = async (extra: Record<string, unknown>) => {
      process.env[BINDINGS_ENV] = JSON.stringify({ [BINDING_NS]: { foremanSession: "parent-session", role: "reviewer", launchId: "l1", kind: "first", workspace: "", ...extra } });
      return r11Rig(t, { ledgerHelper: mode }, { child: true, config: { presence: { enabled: false }, providers: { fake: { review: { model: "m" }, roles: { reviewer: { model: "fake/reviewer" } } } } } });
    };
    const hs = await rig({ highStakes: true });
    for (const command of REFUSED) {
      const b = await hs.call("bash", { command });
      assert.equal(b?.block, true, command);
      assert.match(String(b?.reason), /a \[high-stakes\] review marks no ledger item, item V included; report your verdict only/, command);
    }
    const normal = await rig({});
    for (const command of REFUSED) {
      const b = await normal.call("bash", { command });
      assert.doesNotMatch(String(b?.reason ?? ""), /high-stakes/, command);
    }
  });
}
