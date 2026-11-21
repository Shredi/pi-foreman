// PR D1: a `*.schema.json` inside the write roots and outside the package root is no foreman config file (its descriptions say `gate`); everything else stays floored.
import { test } from "node:test";
import assert from "node:assert/strict";
import { lineFloors, pathFloors, type FloorEnv } from "../floors.ts";
import { parseShell } from "../shellast.ts";

const env: FloorEnv = { cwd: "/w/repo", home: "/h/me", agentDir: "/h/me/.pi/agent", writeRoots: ["/w/repo", "/tmp"], pkgRoot: "/p/pi-foreman", scratch: [] };
const pkgSession: FloorEnv = { ...env, cwd: "/p/pi-foreman", writeRoots: ["/p/pi-foreman", "/tmp"] };
const sibling: FloorEnv = { ...env, cwd: "/p/pi-foreman.worktrees/x", writeRoots: ["/p/pi-foreman.worktrees/x", "/tmp"] };
const GATE = 'The gate decides "permissions" for each call';
const line = (l: string, e: FloorEnv): string | null => lineFloors(l, parseShell(l, { cwd: e.cwd }), { ...e, child: true, builder: true })?.rule ?? null;
const edit = (p: string, e: FloorEnv, tool = "edit"): string | null => pathFloors(tool === "edit" ? { file_path: p, edits: [{ oldText: "a", newText: GATE }] } : { path: p, content: GATE }, e, tool)?.rule ?? null;

test("write and edit of the worktree's schema run; any other schema or config file stays floored", () => {
  for (const tool of ["edit", "write"]) {
    assert.equal(edit("/w/repo/config/foreman.schema.json", env, tool), null, tool);
    assert.equal(edit("/tmp/x/foreman.schema.json", env, tool), null, tool);
    assert.equal(edit("/p/pi-foreman/config/foreman.schema.json", env, tool), "floor-config-keys", `${tool}: package schema`);
    assert.equal(edit("/p/pi-foreman/config/foreman.schema.json", pkgSession, tool), "floor-config-keys", `${tool}: session in the package checkout`);
    assert.equal(edit("/elsewhere/foreman.schema.json", env, tool), "floor-config-keys", `${tool}: outside the roots`);
    assert.equal(edit("/p/pi-foreman.worktrees/x/config/foreman.schema.json", sibling, tool), null, `${tool}: sibling worktree is not under pi-foreman`);
    for (const f of ["/w/repo/foreman.json", "/w/repo/.pi/foreman.json", "/w/repo/foreman.local.json", "/w/repo/foreman.defaults.json"]) assert.equal(edit(f, env, tool), "floor-config-keys", `${tool}: ${f}`);
  }
});

test("bash: sed -i on the worktree's schema runs; the package schema, config files and unreadable targets stay floored", () => {
  assert.equal(line(`sed -i 's/"gate"/"g"/' config/foreman.schema.json`, env), null);
  assert.equal(line(`sed -i 's/"gate"/"g"/' /w/repo/config/foreman.schema.json`, env), null);
  assert.equal(line(`sed -i 's/"gate"/"g"/' /p/pi-foreman/config/foreman.schema.json`, env), "floor-config-keys");
  assert.equal(line(`sed -i 's/"gate"/"g"/' config/foreman.schema.json`, pkgSession), "floor-config-keys");
  assert.equal(line(`sed -i 's/"gate"/"g"/' /elsewhere/foreman.schema.json`, env), "floor-config-keys");
  assert.equal(line(`sed -i 's/"gate"/"g"/' foreman.json`, env), "floor-config-keys");
  // the opaque text path: an unreadable word (a variable, a glob) keeps the verdict it has for a config file
  for (const w of ["$D", "~/x", "*", "{a,b}"]) assert.equal(line(`$X 'gate' ${w}/foreman.schema.json`, env), line(`$X 'gate' ${w}/foreman.json`, env), w);
  assert.equal(line(`$X 'gate' foreman.schema.json`, env), null);
  assert.equal(line(`$X 'gate' /p/pi-foreman/foreman.schema.json`, env), "floor-config-keys");
  assert.equal(line(`$X 'gate' foreman.json`, env), "floor-config-keys");
});
