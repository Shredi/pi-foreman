import { test } from "node:test";
import assert from "node:assert/strict";
import { pathFloors, type FloorEnv } from "../floors.ts";
import type { Resolver } from "../pathnorm.ts";

// A stubbed win32 file system: the long names exist, `RUNNER~1` is the 8.3 alias of `runneradmin`, `agentlink` is a symlink to the agent dir.
const TABLE = new Map<string, string>([
  ["c:\\users", "C:\\Users"],
  ["c:\\users\\runneradmin", "C:\\Users\\runneradmin"],
  ["c:\\users\\runner~1", "C:\\Users\\runneradmin"],
  ["c:\\users\\runneradmin\\.pi", "C:\\Users\\runneradmin\\.pi"],
  ["c:\\users\\runner~1\\.pi", "C:\\Users\\runneradmin\\.pi"],
  ["c:\\users\\runneradmin\\.pi\\agent", "C:\\Users\\runneradmin\\.pi\\agent"],
  ["c:\\users\\runner~1\\.pi\\agent", "C:\\Users\\runneradmin\\.pi\\agent"],
  ["c:\\links", "C:\\links"],
  ["c:\\links\\agentlink", "C:\\Users\\runneradmin\\.pi\\agent"],
]);
const resolver: Resolver = (p) => TABLE.get(p.replace(/\//g, "\\").toLowerCase()) ?? null;

const env: FloorEnv = {
  platform: "win32",
  cwd: "C:\\work\\repo",
  home: "C:\\Users\\runneradmin",
  agentDir: "C:\\Users\\runneradmin\\.pi\\agent",
  resolver,
};

test("win32 sim: the agent auth file is a secret path in every spelling", () => {
  for (const p of [
    "~/.pi/agent/auth.json",
    "~\\.pi\\agent\\auth.json",
    "C:/Users/runneradmin/.pi/agent/auth.json",
    "C:\\Users\\runneradmin\\.pi\\agent\\auth.json",
    "C:\\Users/runneradmin\\.pi/agent/auth.json",
    "C:/Users/RUNNER~1/.pi/agent/auth.json",
    "c:/users/RUNNERADMIN/.PI/AGENT/AUTH.JSON",
    "C:/Users/runneradmin//.pi/./agent/auth.json",
    "C:/links/agentlink/auth.json",
    "C:\\links\\AgentLink\\auth.json",
  ]) assert.equal(pathFloors({ path: p }, env)?.rule, "floor-secret-path", p);
});

test("win32 sim: other files next to the auth file and under the link are not floored", () => {
  for (const p of ["C:/links/agentlink/other.json", "C:/Users/RUNNER~1/.pi/agent/settings.json", "~/.pi/agent/other.json"]) {
    assert.equal(pathFloors({ path: p }, env), null, p);
  }
});

test("win32 sim: the same spellings under the session's own short-name agent dir", () => {
  const short: FloorEnv = { ...env, agentDir: "C:\\Users\\RUNNER~1\\.pi\\agent", home: "C:\\Users\\RUNNER~1" };
  for (const p of ["~/.pi/agent/auth.json", "C:/Users/runneradmin/.pi/agent/auth.json", "C:/links/agentlink/auth.json"]) {
    assert.equal(pathFloors({ path: p }, short)?.rule, "floor-secret-path", p);
  }
});
