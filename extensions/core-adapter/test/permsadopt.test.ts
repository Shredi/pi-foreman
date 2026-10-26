// /foreman perms adopt: confirm writes an allow entry in the user policy layer, cancel and refusals write nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { adoptPerms, logCandidates, withAllowEntry } from "../permsadopt.ts";
import { gateLogFile } from "../gatelog.ts";
import { parsePolicy, userPolicyFile } from "../policy.ts";
import { shapeId } from "../../../scripts/foreman_perms.mjs";

const SHAPE = "npm run lint";
const ID = shapeId("bash", SHAPE);

function setup(records = 5): string {
  const agent = fs.mkdtempSync(path.join(os.tmpdir(), "pf-adopt-"));
  const log = gateLogFile(agent);
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.writeFileSync(log, Array.from({ length: records }, (_, i) => JSON.stringify({ ts: `2026-10-0${i + 1}T00:00:00Z`, tool: "bash", layer: "review", verdict: "allow", kind: "owner", shape: SHAPE })).join("\n") + "\n");
  return agent;
}
const ui = (answer: boolean | "throw", calls: string[] = []) => ({
  hasUI: true,
  mode: "tui",
  confirm: async (title: string, msg: string) => {
    calls.push(`${title}\n${msg}`);
    if (answer === "throw") throw new Error("x");
    return answer;
  },
});

test("confirm appends an entry to the user policy that the policy parser reads", async () => {
  const agent = setup();
  try {
    const calls: string[] = [];
    const out = await adoptPerms(agent, ID, "owner", ui(true, calls));
    assert.match(out, /added bash-/);
    assert.match(calls[0], /npm run lint/);
    const file = userPolicyFile(agent);
    const warnings: string[] = [];
    const entries = parsePolicy(fs.readFileSync(file, "utf8"), file, warnings);
    assert.deepEqual(warnings, []);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].section, "allow");
    assert.equal(entries[0].id, `bash-${ID}`);
    assert.match(entries[0].text, /npm run lint/);
    assert.match(await adoptPerms(agent, ID, "owner", ui(true)), /already in/);
  } finally {
    fs.rmSync(agent, { recursive: true, force: true });
  }
});

test("cancel, a throwing dialog and a UI-less session write nothing", async () => {
  const agent = setup();
  try {
    assert.match(await adoptPerms(agent, ID, "owner", ui(false)), /not adopted/);
    assert.match(await adoptPerms(agent, ID, "owner", ui("throw")), /not adopted/);
    assert.match(await adoptPerms(agent, ID, "owner", { ...ui(true), hasUI: false }), /interactive/);
    assert.equal(fs.existsSync(userPolicyFile(agent)), false);
  } finally {
    fs.rmSync(agent, { recursive: true, force: true });
  }
});

test("child, round and headless sessions are refused without asking", async () => {
  const agent = setup();
  try {
    for (const kind of ["child", "round", "headless"]) {
      const calls: string[] = [];
      assert.match(await adoptPerms(agent, ID, kind, ui(true, calls)), /owner pane/);
      assert.equal(calls.length, 0);
    }
    assert.equal(fs.existsSync(userPolicyFile(agent)), false);
  } finally {
    fs.rmSync(agent, { recursive: true, force: true });
  }
});

test("an unknown id, a malformed id and a shape below the threshold are refused", async () => {
  const agent = setup(4);
  try {
    assert.match(await adoptPerms(agent, ID, "owner", ui(true)), /no candidate/);
    assert.match(await adoptPerms(agent, "deadbeef", "owner", ui(true)), /no candidate/);
    assert.match(await adoptPerms(agent, "x; rm", "owner", ui(true)), /usage/);
    assert.equal(logCandidates(agent).length, 0);
    assert.equal(fs.existsSync(userPolicyFile(agent)), false);
  } finally {
    fs.rmSync(agent, { recursive: true, force: true });
  }
});

test("an existing allow section gets the entry before the next section; other sections stay", () => {
  const before = "# mine\n\n## allow\n\n- id: keep-me\n  Old entry.\n\n## deny\n\n- id: no-way\n  Nope.\n";
  const after = withAllowEntry(before, { id: "bash-1", text: "New." });
  const warnings: string[] = [];
  const entries = parsePolicy(after, "f", warnings);
  assert.deepEqual(warnings, []);
  assert.deepEqual(entries.map((e) => `${e.section}:${e.id}`), ["allow:keep-me", "allow:bash-1", "deny:no-way"]);
  assert.equal(parsePolicy(withAllowEntry("## deny\n\n- id: a\n  b\n", { id: "c", text: "d" }), "f", []).map((e) => `${e.section}:${e.id}`).join(), "deny:a,allow:c");
});
