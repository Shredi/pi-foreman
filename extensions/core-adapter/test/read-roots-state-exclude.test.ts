// The state-dir read default (item 14 / D228) withholds `pages/roots` for every spelling of the path: forward or back slashes, any drive-letter case on win32,
// a `..` detour, and a backslash path typed unquoted in a bash line (the shell eats the backslashes). Runs on any host.
import { test } from "node:test";
import assert from "node:assert/strict";
import { contained, type EffectCtx } from "../effects.ts";
import { effectCtxOf } from "../defaults.ts";
import type { GateRoots } from "../pathrules.ts";

const ctxOf = (platform: string, wt: string, state: string): EffectCtx => {
  const r: GateRoots = {
    worktree: wt, scratch: [], tmp: [], owned: [], install: [], roundFlow: [], handoffs: [], child: false, role: "foreman", tmpAccess: true, state,
    realpath: (p) => p,
  };
  return { ...effectCtxOf({ roots: r, platform, cwd: wt }), readAny: true };
};

test("win32: pages/roots stays withheld for backslash, slash, mixed drive-letter case and `..` words; a clean state read stays open", () => {
  const c = ctxOf("win32", "C:\\wt", "C:\\Users\\me\\agent\\state");
  for (const w of [
    "C:\\Users\\me\\agent\\state\\pages\\roots\\x.json",
    "c:/users/me/agent/STATE/Pages/Roots/x.json",
    "C:\\Users\\me\\agent\\state\\gate\\..\\pages\\roots\\x.json",
    "C:\\Users\\me\\agent\\state\\gate/../pages/roots/x.json",
    "c:Usersmeagentstatepagesrootsx.json",
    "C:Usersmeagentstatepagesrootsx.json",
  ]) assert.equal(contained(c, "C:\\wt", w, false), false, w);
  assert.equal(contained(c, "C:\\wt", "C:\\Users\\me\\agent\\state\\gate\\log.jsonl", false), true);
  assert.equal(contained(c, "C:\\wt", "c:/users/me/agent/state/gate/log.jsonl", false), true);
});

test("posix: pages/roots stays withheld for a `..` detour", () => {
  const c = ctxOf("linux", "/wt", "/home/me/agent/state");
  assert.equal(contained(c, "/wt", "/home/me/agent/state/gate/../pages/roots/x.json", false), false);
  assert.equal(contained(c, "/wt", "/home/me/agent/state/pages/roots/x.json", false), false);
  assert.equal(contained(c, "/wt", "/home/me/agent/state/gate/log.jsonl", false), true);
});
