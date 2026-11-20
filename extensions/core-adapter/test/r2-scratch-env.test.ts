// The floors never read the process's FOREMAN_SCRATCH to decide inside or outside: the session's own scratch dir comes from the floor env (`scratch`), as
// index.ts fills it from the gate roots. Each verdict is the same for the variable unset, a foreign path and `/`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { baseFloorEnv, gateEvaluate } from "../gate.ts";
import type { GateRoots } from "../pathrules.ts";
import { posix } from "./_platform.ts";

const WT = "/w/repo";
const VALUES: (string | undefined)[] = [undefined, "/b/other", "/"];
const withVar = <T>(v: string | undefined, f: () => T): T => {
  const old = process.env.FOREMAN_SCRATCH;
  try {
    if (v === undefined) delete process.env.FOREMAN_SCRATCH;
    else process.env.FOREMAN_SCRATCH = v;
    return f();
  } finally {
    if (old === undefined) delete process.env.FOREMAN_SCRATCH;
    else process.env.FOREMAN_SCRATCH = old;
  }
};
const decide = (command: string, o: { child?: boolean; scratch?: string } = {}): string => {
  const child = !!o.child;
  const scratch = o.scratch ? [o.scratch] : [];
  const roots: GateRoots = {
    worktree: WT, scratch, tmp: [], owned: [], install: [], roundFlow: [], handoffs: [], child, role: child ? "builder" : "foreman", tmpAccess: true,
  };
  const out = gateEvaluate("bash", { command }, WT, {
    // no `scratch` key at all when the context has none: what production did before the env carried it
    env: (x) => baseFloorEnv(x, { platform: "linux", home: "/h/me", writeRoots: [WT, ...scratch], ...(o.scratch ? { scratch } : {}), ...(child ? { child: true } : {}) }),
    roots: () => roots,
  });
  const r = out.result as { block?: boolean; ask?: boolean; rule?: string } | undefined;
  // C: a judge-first kind decides nothing in the gate; the label it carries is the verdict (`none:danger-<kind>`)
  return r === undefined || r === null ? (out.danger ? `none:${out.danger.name}` : "none") : "block" in r && r.block ? `block:${r.rule}` : "ask" in r && r.ask ? `ask:${r.rule}` : `allow:${(r as { rule?: string }).rule}`;
};
const rm = "r" + "m";
const cpr = "c" + "p -r";
const rows: [string, string, string][] = [
  ["delete outside", `${rm} /b/other/x`, "block:floor-delete-outside"],
  ["recursive copy", `${cpr} a /b/other/x`, "block:floor-overwrite-outside"],
  ["rsync --delete", "rsync -a --delete a/ /b/other/x/", "block:floor-overwrite-outside"],
  ["tar -C", "tar -xf a.tar -C /b/other/x", "block:floor-overwrite-outside"],
  ["fs scan above the workspace", "find /w -name x", "none:danger-fs-scan"],
];
for (const v of VALUES) {
  for (const [name, line, want] of rows) {
    // win32: the workspace root is resolved with the host's path rules (`/w/repo` -> `D:\w\repo`) while the root of the scan is read as a linux path, so no parent is seen
    test(`${name}: ${JSON.stringify(line)} with FOREMAN_SCRATCH=${v === undefined ? "unset" : v}`, { skip: !posix && want === "none:danger-fs-scan" }, () => {
      assert.equal(withVar(v, () => decide(line)), want);
    });
  }
  test(`own scratch /a/s1 stays inside with FOREMAN_SCRATCH=${v === undefined ? "unset" : v}`, () => {
    const got = withVar(v, () => [decide(`${rm} /a/s1/x`, { scratch: "/a/s1" }), decide("find /a/s1 -name x", { scratch: "/a/s1" })]);
    assert.deepEqual(got, ["allow:default-write-in", "allow:default-read"]);
  });
  test(`builder write outside stays child-write-outside with FOREMAN_SCRATCH=${v === undefined ? "unset" : v}`, () => {
    assert.equal(withVar(v, () => decide("echo y > /b/other/x", { child: true })), "block:child-write-outside");
  });
  test(`inOwnTemp decides the same for a path under the variable's folder with FOREMAN_SCRATCH=${v === undefined ? "unset" : v}`, () => {
    assert.equal(withVar(v, () => decide("git config --file /b/other/c.cfg core.hooksPath /x")), "none:danger-git-config");
  });
}
