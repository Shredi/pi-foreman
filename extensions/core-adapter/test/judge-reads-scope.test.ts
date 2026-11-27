// The judge's read scope (Item 1, D194/D197/D204/D209): every absolute path is in scope except the withheld places; D197 and D204 stay regression-tested.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { gateDecide } from "../gate.ts";
import type { GateResult } from "../gate.ts";
import type { GitFacts } from "../defaults.ts";
import type { GateRoots } from "../pathrules.ts";
import type { FloorEnv } from "../floors.ts";
import { MAX_READ_BUDGET, judgeReadScope, readLogPaths, readPaths } from "../judgereads.ts";
import type { JudgeReadScope } from "../judgereads.ts";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "judge-reads-scope-")));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const home = path.join(tmp, "home");
const agent = path.join(home, ".pi", "agent");
const wt = path.join(home, "proj");
for (const d of [agent, wt, path.join(home, ".local", "bin"), path.join(home, ".ssh"), path.join(home, ".secrets"), path.join(home, ".aws"), path.join(tmp, "etc")]) fs.mkdirSync(d, { recursive: true });
const put = (p: string, text = "x\n"): string => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  return p;
};
const S = judgeReadScope({ cwd: wt, worktree: wt, agentDir: agent, home, config: {} }) as JudgeReadScope;
const one = (p: string, s: JudgeReadScope = S) => {
  const r = readPaths([p], s, { left: MAX_READ_BUDGET });
  return { rec: r.records[0], block: r.blocks[0] };
};

test("in scope: a home file, a program in ~/.local/bin, a file under the temp folder and a file beside the worktree", () => {
  const hc = put(path.join(home, ".local", "bin", "hc"), "#!/bin/sh\necho hc\n");
  const zshrc = put(path.join(home, ".zshrc"), "export A=1\n");
  const x = put(path.join(tmp, "etc", "x.json"), '{"a":1}\n');
  for (const p of [hc, zshrc, x]) {
    const r = one(p);
    assert.equal(r.rec.outcome, "ok", p);
  }
  assert.match(one(hc).block.body, /echo hc/);
  assert.equal(one("~/.local/bin/hc").rec.outcome, "ok");
  assert.equal(one(os.tmpdir()).rec.outcome, "dir");
});

test("withheld: ~/.ssh/id_rsa, ~/.secrets/x, ~/.aws/credentials and the agent auth.json are never shown", () => {
  for (const p of [put(path.join(home, ".ssh", "id_rsa"), "KEY\n"), put(path.join(home, ".secrets", "x"), "S\n"), put(path.join(home, ".aws", "credentials"), "AWS\n"), put(path.join(agent, "auth.json"), '{"k":"v"}')]) {
    const r = one(p);
    assert.notEqual(r.rec.outcome, "ok", p);
    assert.ok(["withheld", "outside"].includes(r.rec.outcome), p);
    assert.ok(!/KEY|AWS|"k"/.test(r.block.body), p);
  }
});

test("withheld: an agent-dir entry that is not allow-listed stays outside", () => {
  const p = put(path.join(agent, "extensions", "x.ts"), "ext\n");
  const r = one(p);
  assert.equal(r.rec.outcome, "outside");
  assert.ok(!r.block.body.includes("ext\n"));
});

test("withheld: a worktree symlink to ~/.ssh/id_rsa is checked on its real path", () => {
  const key = path.join(home, ".ssh", "id_rsa");
  put(key, "PRIVATE\n");
  const link = path.join(wt, "innocent.txt");
  fs.symlinkSync(key, link);
  const r = one(link);
  assert.equal(r.rec.outcome, "withheld");
  assert.ok(!r.block.body.includes("PRIVATE"));
  const dirLink = path.join(wt, "sshlink");
  fs.symlinkSync(path.join(home, ".ssh"), dirLink);
  assert.equal(one(path.join(dirLink, "id_rsa")).rec.outcome, "withheld");
});

test("scope: the home folder and the disk root are in scope; roots keep their labels by length", () => {
  const s = judgeReadScope({ cwd: home, worktree: tmp, scratch: path.parse(tmp).root, agentDir: agent, home, config: {} }) as JudgeReadScope;
  assert.ok(s.roots.length >= 1);
  assert.equal(one(home, s).rec.outcome, "dir");
  assert.equal(readLogPaths([one(path.join(wt, "a"), S).rec], S)[0].startsWith("<worktree>/"), true);
  put(path.join(wt, "a"));
  assert.equal(readLogPaths([one(path.join(wt, "a"), S).rec], S)[0], "<worktree>/a");
  assert.equal(readLogPaths([one(path.join(tmp, "etc", "x.json"), S).rec], S)[0].startsWith("<"), true);
});

test("windows: a path on a drive or share lies in that drive's root (path.win32)", () => {
  const w = { ...S, platform: "win32" } as JudgeReadScope;
  const place = (real: string) => readLogPaths([{ asked: real, outcome: "ok", real }], w)[0];
  assert.equal(place("D:\\data\\tools\\hc.exe"), "<D:\\>/data/tools/hc.exe");
  assert.equal(place("C:\\Users\\me\\.local\\bin\\hc"), "<C:\\>/Users/me/.local/bin/hc");
  assert.equal(place("\\\\srv\\share\\dir\\f.txt"), "<\\\\srv\\share\\>/dir/f.txt");
});

// D197 and D204: these already passed before the change; they stay as regression tests.
const wtRoots: GateRoots = { worktree: wt, scratch: [], tmp: ["/tmp"], scratchBase: path.join(tmp, "sb"), owned: [], install: [], roundFlow: [], handoffs: [], child: false, role: "foreman", tmpAccess: true };
const facts: GitFacts = { currentBranch: () => "round/1-x", protectedBranches: () => ["main"], pushConfigured: () => false };
const env: FloorEnv = { cwd: wt, home, agentDir: agent, platform: process.platform, protectedBranches: ["main"], currentBranch: () => "round/1-x", remoteHead: () => "main", writeRoots: [wt] };
const gate = (command: string, r: Partial<GateRoots> = {}): GateResult => gateDecide("bash", { command }, wt, { env: () => env, roots: () => ({ ...wtRoots, ...r }), facts });
const rule = (r: GateResult): string | null => (r && "allow" in r ? r.rule : null);

test("D197: `head /tmp/x.json` is default-read for the owner and for a builder", () => {
  assert.equal(rule(gate("head /tmp/x.json")), "default-read");
  assert.equal(rule(gate("head /tmp/x.json", { child: true, role: "builder" })), "default-read");
});

test("D204: read forms of `git config` raise no danger in the builder's own worktree", () => {
  for (const l of ["git config user.name", "git config -l", "git config --get x", "git config --get-all remote.origin.url", "for k in a b; do git config --get $k; done"]) {
    const r = gate(l, { child: true, role: "builder" });
    assert.ok(!(r && "block" in r), l);
    assert.ok(!/danger-/.test(JSON.stringify(r)), `${l}: ${JSON.stringify(r)}`);
  }
});
