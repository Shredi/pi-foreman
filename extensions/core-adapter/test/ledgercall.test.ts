import { test } from "node:test";
import assert from "node:assert/strict";
import { applyVariants, findItemByText, rewriteItemText, isLedgerOnlyCommand, isPermissionDeny, ledgerHelperMode, planLedgerCall, V_ATTESTED_NOTE } from "../ledgercall.ts";

const ACCEPT = [
  "ledger status",
  "ledger mark 3",
  "ledger mark V --verifier",
  'ledger add "a new item; with & symbols"',
  "ledger note 2 'see a.ts: line 4 $HOME stays literal'",
  'ledger defer 4 "out of scope"',
  "ledger mark 1 && ledger mark 2; ledger status",
  "ledger mark 1; ledger status;",
  "cd /app && ledger status",
  "cd '/work/my project' && ledger mark 1",
  "cd C:\\work\\repo && ledger status",
  "cd /app && for i in 1 2 3; do ledger mark $i; done; ledger status",
  "for n in 4 5 V; do ledger mark $n; done",
];

const REJECT = [
  "",
  "ledger",
  "ledger list",
  "ledger status | head",
  "ledger status > out.txt",
  "ledger add x < in.txt",
  "ledger add `id`",
  "ledger add $(id)",
  "ledger note 1 $HOME",
  'ledger note 1 "$HOME"',
  "ledger status\nrm -r x",
  "ledger status & sleep 1",
  "ledger status || true",
  "echo hi; ledger status",
  "ledger status && cat a.txt",
  "cd /app; ledger status",
  "cd $HOME && ledger status",
  "cd /app && cd /b && ledger status",
  "for i in 1 2; do ledger mark $j; done",
  "for i in 1 2; do ledger mark $i; ledger status; done",
  "for i in $(seq 3); do ledger mark $i; done",
  "for i in a b; do ledger mark $i; done",
  "ledger add pre'quoted'",
  "(ledger status)",
  "ledger add x # comment",
  'ledger add "a > b"',
  "ledger mark 1 \\; rm x",
];

test("ledgercall: accepted pure-ledger commands", () => {
  for (const c of ACCEPT) assert.equal(isLedgerOnlyCommand(c), true, c);
});

test("ledgercall: rejected commands", () => {
  for (const c of REJECT) assert.equal(isLedgerOnlyCommand(c), false, c);
  assert.equal(isLedgerOnlyCommand(undefined), false);
});

test("ledgercall: knob default and permission deny detection", () => {
  assert.equal(ledgerHelperMode(undefined), "tool");
  assert.equal(ledgerHelperMode("bash"), "bash");
  assert.equal(ledgerHelperMode("off"), "off");
  assert.equal(isPermissionDeny(true, "[pi-permission-system] This 'bash' call (rule '*') requires approval, but no interactive UI is available."), true);
  assert.equal(isPermissionDeny(true, "pi-foreman: denied by the permission policy (command rule 'sudo *')."), true);
  assert.equal(isPermissionDeny(true, "pi-foreman: [recheck_budget_exceeded] the reviewer passed"), false);
  assert.equal(isPermissionDeny(false, "[pi-permission-system]"), false);
});

const PASS = { last: "pass", revised: false };

test("ledgercall: foreman tool batches marks and closes V only after an unrevised PASS", () => {
  assert.deepEqual(planLedgerCall({ action: "mark", items: [1, "2", 1] }, { child: false, gate: PASS }), { calls: [["mark", "1"], ["mark", "2"]], items: "1,2", attested: false });
  assert.deepEqual(planLedgerCall({ action: "mark", items: ["v", 3] }, { child: false, gate: PASS }), { calls: [["mark", "3"], ["mark", "V", V_ATTESTED_NOTE, "--verifier"]], items: "3,V", attested: true });
  for (const gate of [{ last: null, revised: false }, { last: "fail", revised: false }, { last: "pass", revised: true }, { last: "none", revised: false }]) {
    const r = planLedgerCall({ action: "mark", items: ["V"] }, { child: false, gate });
    assert.ok("error" in r && r.error.includes("V closes after a reviewer PASS with no revision since"), JSON.stringify(gate));
  }
  assert.ok("error" in planLedgerCall({ action: "defer", items: ["V"], text: "later" }, { child: false, gate: PASS }));
  assert.deepEqual(planLedgerCall({ action: "add", text: "new item" }, { child: false, gate: PASS }), { calls: [["add", "new item"]], items: "", attested: false });
  assert.deepEqual(planLedgerCall({ action: "status" }, { child: false, gate: PASS }), { calls: [], items: "", attested: false });
  assert.ok("error" in planLedgerCall({ action: "note", items: [1, 2], text: "x" }, { child: false, gate: PASS }));
  assert.ok("error" in planLedgerCall({ action: "rm" }, { child: false, gate: PASS }));
});

test("ledgercall: a reviewer child may only mark V, always with --verifier", () => {
  const gate = { last: null, revised: false };
  assert.deepEqual(planLedgerCall({ action: "mark", items: ["V"] }, { child: true, gate }), { calls: [["mark", "V", "--verifier"]], items: "V", attested: false });
  for (const p of [{ action: "mark", items: [1] }, { action: "mark", items: ["V", 1] }, { action: "status" }, { action: "add", text: "x" }]) {
    assert.ok("error" in planLedgerCall(p, { child: true, gate }), JSON.stringify(p));
  }
});

test("prompt variants: tagged lines filtered by value, untagged text unchanged", () => {
  const text = "a\n<!--ledgerHelper=off|bash-->old\n<!--ledgerHelper=tool-->new\nb\n";
  assert.equal(applyVariants(text, { ledgerHelper: "off" }), "a\nold\nb\n");
  assert.equal(applyVariants(text, { ledgerHelper: "tool" }), "a\nnew\nb\n");
  assert.equal(applyVariants(text, {}), "a\nb\n");
  assert.equal(applyVariants("plain\r\ntext", { ledgerHelper: "tool" }), "plain\r\ntext");
});

test("ledgercall: upsert plan and line rewrite keep state, EOL and skip fences", () => {
  const gate = { last: null, revised: false };
  assert.deepEqual(planLedgerCall({ action: "upsert", item: "v", text: "t" }, { child: false, gate }), { calls: [], items: "V", attested: false, upsert: { item: "V", text: "t" } });
  assert.deepEqual(planLedgerCall({ action: "upsert", text: "t" }, { child: false, gate }), { calls: [], items: "", attested: false, upsert: { item: null, text: "t" } });
  assert.ok("error" in planLedgerCall({ action: "upsert", item: 1 }, { child: false, gate }));
  assert.ok("error" in planLedgerCall({ action: "upsert", text: "t" }, { child: true, gate }));
  const f = "# T\r\n- [x] 1. a — done\r\n- [~] deferred: r — 2. b\r\n```\r\n- [ ] 3. fenced\r\n```\r\n- [ ] V. check\r\n";
  assert.deepEqual(rewriteItemText(f, "1", "a2"), { file: f.replace("a — done", "a2"), changed: true });
  assert.deepEqual(rewriteItemText(f, "2", "b2"), { file: f.replace("— 2. b", "— 2. b2"), changed: true });
  assert.deepEqual(rewriteItemText(f, "V", "check"), { file: f, changed: false });
  assert.ok("error" in rewriteItemText(f, "3", "x"));
  assert.equal(findItemByText(f, "b"), "2");
  assert.equal(findItemByText(f, "fenced"), null);
});
