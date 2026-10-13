// R5 P2 S2 (ledger 11, R1 regression): the round's ledger and <main>/.workflow/* are an owned READ root for every child role
// whose cwd is the round worktree: bash and the read tool; writes there stay closed.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildOverlayRules, checkToolCall, readBaseline } from "../permoverlay.ts";
import { childReadable, childSurface, mainWorkflowReadable } from "../roundsurface.ts";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const baseline = readBaseline(pkgRoot)!;
const posix = process.platform !== "win32";
const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-s2-ml-")));
after(() => fs.rmSync(base, { recursive: true, force: true }));
const main = path.join(base, "repo");
const rt = path.join(base, "repo.worktrees", "round");
const scratch = path.join(base, "scratch");
for (const d of [path.join(main, ".workflow"), rt, scratch]) fs.mkdirSync(d, { recursive: true });
const ledger = path.join(main, ".workflow", "LEDGER-x.md");
fs.writeFileSync(ledger, "- [ ] 1. item\n");
fs.writeFileSync(path.join(main, ".workflow", "notes.md"), "n\n");
fs.writeFileSync(path.join(main, "other.txt"), "o\n");
const top = (d: string): string | null => (d.startsWith(rt) ? rt : null);
// the user's rule that keeps children out of the main checkout: `rule '<main>/*' matched …`
const r = buildOverlayRules(baseline, { paths: { deny: [`${main}/*`] } }, {}, path.join(base, "agent"), pkgRoot, undefined, false);

const run = (role: string, tool: string, input: Record<string, unknown>, withLedger = false): string => {
  const s = childSurface([rt], rt, role, process.platform, top);
  const readable = [...childReadable(withLedger ? ledger : null, [], [rt], process.platform), ...mainWorkflowReadable([rt], process.platform)];
  return checkToolCall(r, tool, input, { cwd: rt, home: base, platform: process.platform, role: "child", scratch, roundRoots: s.write, roundReadRoots: s.read, readable })?.kind ?? "pass";
};

test("every child role reads the main checkout's ledger and .workflow by bash", { skip: !posix }, () => {
  for (const role of ["builder", "reviewer", "scout", "planner"]) {
    assert.equal(run(role, "bash", { command: `cat ${ledger}; git log --oneline -3` }), "pass", role);
    assert.equal(run(role, "bash", { command: `cat ${path.join(main, ".workflow", "notes.md")}` }), "pass", role);
    assert.equal(run(role, "bash", { command: `grep -n item ${path.join(main, ".workflow")}/LEDGER-*.md` }), "pass", role);
  }
});

test("every child role reads the main checkout's ledger with the read tool", { skip: !posix }, () => {
  for (const role of ["builder", "reviewer", "scout"]) {
    assert.equal(run(role, "read", { path: ledger }), "pass", role);
    assert.equal(run(role, "read", { path: path.join(main, ".workflow", "notes.md") }), "pass", role);
  }
});

test("the rest of the main checkout and secrets under .workflow stay closed for reads", { skip: !posix }, () => {
  fs.writeFileSync(path.join(main, ".workflow", ".env"), "TOKEN=x\n");
  for (const role of ["builder", "reviewer"]) {
    assert.equal(run(role, "bash", { command: `cat ${path.join(main, "other.txt")}` }), "deny", role);
    assert.equal(run(role, "read", { path: path.join(main, "other.txt") }), "deny", role);
    assert.equal(run(role, "bash", { command: `cat ${path.join(main, ".workflow", ".env")}` }), "deny", role);
  }
});

test("writes into the main checkout stay denied; the rest of the main checkout stays closed", { skip: !posix }, () => {
  for (const role of ["builder", "reviewer"]) {
    for (const [tool, input] of [
      ["write", { path: ledger }],
      ["edit", { path: path.join(main, ".workflow", "notes.md") }],
      ["bash", { command: `echo x > ${ledger}` }],
      ["bash", { command: `echo x >> ${path.join(main, ".workflow", "notes.md")}` }],
      ["bash", { command: `cp a ${path.join(main, ".workflow", "new.md")}` }],
    ] as [string, Record<string, unknown>][]) assert.notEqual(run(role, tool, input), "pass", `${role} ${tool} ${JSON.stringify(input)}`);
  }
});

test("mainWorkflowReadable names only the sibling main checkout's .workflow of a round worktree", () => {
  assert.deepEqual(mainWorkflowReadable([rt], "linux"), [`${main}/.workflow`, `${main}/.workflow/*`]);
  assert.deepEqual(mainWorkflowReadable([path.join(base, "plain")], "linux"), []);
});
