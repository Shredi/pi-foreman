// R46 item 1: `<handoff>/live.json` binds a handoff to a Pi session, so it is write-protected like `parent` and `child` (selfmod-identity, selfmod.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { gateDecide, type GateResult } from "../gate.ts";
import type { FloorEnv } from "../floors.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";
import { posixOnly } from "./_platform.ts";

const base = fs.realpathSync.native(mkTestTmp("pf-r46-ident-"));
test.after(() => rmTestTmp(base));
const home = path.join(base, "home");
const agent = path.join(home, ".pi", "agent");
const work = path.join(base, "work");
const scr = path.join(base, "scr");
const hand = path.join(agent, "pi-foreman", "handoffs", "20261115-100000-x");
for (const d of [hand, work, scr]) fs.mkdirSync(d, { recursive: true });
const PKG_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");

const ans = (role: string, tool: string, input: Record<string, unknown>): string => {
  const env: FloorEnv = { cwd: work, home, agentDir: agent, writeRoots: [work, scr], scratch: [scr], pkgRoot: PKG_ROOT, child: role !== "foreman" };
  const roots = { worktree: work, scratch: [scr], tmp: [fs.realpathSync.native(os.tmpdir()), "/tmp"], scratchBase: path.join(base, "scrbase"), owned: [], install: [], roundFlow: [], handoffs: [], child: role !== "foreman", role, tmpAccess: true, agentDir: agent, home } as never;
  const r: GateResult = gateDecide(tool, input, work, { env: () => env, roots: () => roots });
  return r === null || r === undefined ? "none" : "block" in r && r.block ? `block:${r.rule}` : "ask" in r && r.ask ? `ask:${r.rule}` : `allow:${(r as { rule?: string }).rule}`;
};

test("live.json is write-protected next to parent and child: main asks, a builder is denied", { skip: posixOnly }, () => {
  for (const f of ["parent", "child", "live.json"]) {
    assert.equal(ans("foreman", "write", { path: path.join(hand, f), content: "x" }), "ask:selfmod-identity", f);
    assert.equal(ans("builder", "write", { path: path.join(hand, f), content: "x" }), "block:selfmod-identity", f);
  }
});
