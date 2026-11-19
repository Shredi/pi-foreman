// Round 2, step 6a (third run): the old permission layer's allow rows that r2-ported-allows.test.ts does not hold. Each row is an input the old layer allowed; the gate
// must neither block nor ask for the listed role (m = foreman, b = builder, r = round reviewer). No rule name is pinned. The comment above a group names the old test file
// and test line. The rows were captured from the old tests' own calls; paths are rewritten to fixed fixture strings (nothing is created on disk).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import { baseFloorEnv, gateDecide, type GateResult } from "../gate.ts";
import { tmpRoots, type GateRoots } from "../pathrules.ts";

// the fixture worlds are literal strings (nothing is created on disk); the win32 rows run on a posix host and show what the gate code says for that string
import { posixOnly } from "./_platform.ts";
interface Ctx { platform: string; worktree: string; cwd: string; home?: string; agentDir?: string; sessionDir?: string; pkgRoot?: string; scratch?: string; scratchBase?: string; owned: string[]; handoff?: string; foremanRoot?: string; noTmp: boolean }
const real = (p: string): string => { try { return fs.realpathSync(p); } catch { return p; } };
const ROLE: Record<string, string> = { m: "foreman", b: "builder", r: "reviewer" };
const decide = (c: Ctx, letter: string, tool: string, input: Record<string, unknown>): GateResult => {
  const role = ROLE[letter]!;
  const child = letter !== "m";
  const tmp = c.noTmp ? [] : tmpRoots(os.tmpdir(), process.platform, real);
  const roots: GateRoots = {
    worktree: c.worktree, ...(letter === "r" ? { roundReadOnly: true } : {}), scratch: c.scratch ? [c.scratch] : [], tmp, ...(c.scratchBase ? { scratchBase: c.scratchBase } : {}),
    owned: c.owned, install: [], roundFlow: [], handoffs: c.handoff ? [c.handoff] : [], ...(child && c.handoff ? { childHandoff: c.handoff } : {}), child,
    ...(child && c.foremanRoot ? { checkout: c.foremanRoot } : {}), ...(c.agentDir ? { agentDir: c.agentDir } : {}), ...(c.sessionDir ? { sessionDir: c.sessionDir } : {}),
    role: child ? role : "foreman", tmpAccess: true, ...(c.pkgRoot ? { pkgRoot: c.pkgRoot } : {}),
  };
  return gateDecide(tool, input, c.cwd, {
    env: (x) => baseFloorEnv(x, { ...(c.home ? { home: c.home } : {}), platform: c.platform, ...(c.agentDir ? { agentDir: c.agentDir } : {}), ...(c.sessionDir ? { sessionDir: c.sessionDir } : {}), ...(c.pkgRoot ? { pkgRoot: c.pkgRoot } : {}), ...(child ? { child: true } : {}), writeRoots: [c.worktree, ...(c.scratch ? [c.scratch] : []), ...tmp], ...(c.scratch ? { scratch: [c.scratch] } : {}) }),
    roots: () => roots,
  });
};
const label = (r: GateResult): string => (r === undefined || r === null ? "none" : "block" in r && r.block ? `block:${r.rule}` : "ask" in r && r.ask ? `ask:${r.rule}` : `allow:${(r as { rule?: string }).rule}`);
type Row = [number, string, string | Record<string, unknown>, string, ...string[]];
const inputOf = (i: string | Record<string, unknown>): Record<string, unknown> => (typeof i === "string" ? { command: i } : i);
const CTX: Ctx[] = [
  {"platform":"win32","worktree":"C:\\r2fx\\ws.worktrees\\hf","cwd":"C:\\r2fx\\ws.worktrees\\hf","home":"C:\\r2fx\\home","agentDir":"C:\\r2fx\\home\\.pi\\agent","pkgRoot":"C:\\r2fx\\ws","scratch":"C:\\r2fx\\tmp\\pi-foreman-scratch\\s1\\L1","owned":[],"noTmp":false}, // 0
  {"platform":"darwin","worktree":"/Users/r2fx/ws","cwd":"/Users/r2fx/ws","home":"/Users/r2fx/home","agentDir":"/nonexistent/agent","pkgRoot":"/nonexistent/pkg","owned":[],"noTmp":true}, // 1
  {"platform":"win32","worktree":"C:\\r2fx\\ws","cwd":"C:\\r2fx\\ws","home":"C:\\Users\\RUNNER~1","agentDir":"/nonexistent/agent","pkgRoot":"/nonexistent/pkg","owned":[],"noTmp":false}, // 2
  {"platform":"darwin","worktree":"/Users/r2fx/ws","cwd":"/Users/r2fx/ws","home":"/Users/r2fx/home","agentDir":"/Users/r2fx/home/.pi/agent","pkgRoot":"/Users/r2fx/ws","owned":[],"noTmp":true}, // 3
  {"platform":"darwin","worktree":"/Users/r2fx/ws.worktrees/r1","cwd":"/Users/r2fx/ws.worktrees/r1","home":"/Users/r2fx/home","agentDir":"/Users/r2fx/home/.pi/agent","pkgRoot":"/Users/r2fx/ws","owned":[],"noTmp":true}, // 4
  {"platform":"win32","worktree":"C:\\r2fx\\ws.worktrees\\r1","cwd":"C:\\r2fx\\ws.worktrees\\r1","home":"C:\\r2fx\\home","agentDir":"C:\\r2fx\\home\\.pi\\agent","pkgRoot":"C:\\r2fx\\ws","owned":[],"noTmp":false}, // 5
  {"platform":"darwin","worktree":"/Users/r2fx/repo","cwd":"/Users/r2fx/repo","home":"/Users/r2fx","agentDir":"/Users/r2fx/agent","scratch":"/Users/r2fx/tmp/pi-foreman-scratch/sess-3/L-g","owned":[],"noTmp":true}, // 6
  {"platform":"darwin","worktree":"/Users/r2fx/repo","cwd":"/Users/r2fx/repo","home":"/Users/r2fx","agentDir":"/Users/r2fx/agent","owned":[],"noTmp":true}, // 7
  {"platform":"darwin","worktree":"/Users/r2fx/repo","cwd":"/Users/r2fx/repo","home":"/Users/r2fx","agentDir":"/Users/r2fx/agent","scratch":"/Users/r2fx/tmp/pi-foreman-scratch/sess-r25/L-mine","owned":[],"noTmp":true}, // 8
  {"platform":"darwin","worktree":"/Users/r2fx/pkg","cwd":"/Users/r2fx/pkg","home":"/Users/r2fx/tmproot","agentDir":"/Users/r2fx","scratch":"/Users/r2fx/tmp/pi-foreman-scratch/sess-8a/L-child","owned":[],"noTmp":false}, // 9
  {"platform":"darwin","worktree":"/Users/r2fx/repo.worktrees/round","cwd":"/Users/r2fx/repo.worktrees/round","home":"/Users/r2fx","agentDir":"/Users/r2fx/agent","pkgRoot":"/Users/r2fx/pkg","scratchBase":"/Users/r2fx/tmp/pi-foreman-scratch","owned":["/Users/r2fx/agent/pi-foreman/handoffs","/Users/r2fx/agent/sessions/*/subagent-artifacts","/Users/r2fx/repo.worktrees","/Users/r2fx/agent/pi-foreman","/Users/r2fx/agent/foreman.json","/Users/r2fx/agent/settings.json"],"noTmp":true}, // 10
  {"platform":"darwin","worktree":"/Users/r2fx/repo.worktrees/round","cwd":"/Users/r2fx/repo.worktrees/round","home":"/Users/r2fx","agentDir":"/Users/r2fx/agent","pkgRoot":"/Users/r2fx/pkg","scratch":"/Users/r2fx/tmp/pi-foreman-scratch/child1","scratchBase":"/Users/r2fx/tmp/pi-foreman-scratch","owned":["/Users/r2fx/agent/pi-foreman/handoffs","/Users/r2fx/agent/sessions/*/subagent-artifacts","/Users/r2fx/repo.worktrees","/Users/r2fx/agent/pi-foreman","/Users/r2fx/agent/foreman.json","/Users/r2fx/agent/settings.json"],"noTmp":true}, // 11
  {"platform":"darwin","worktree":"/Users/r2fx/repo.worktrees/round","cwd":"/Users/r2fx/repo.worktrees/round","home":"/Users/r2fx","agentDir":"/Users/r2fx/agent","pkgRoot":"/Users/r2fx/pkg","scratch":"/Users/r2fx/scratch","owned":[],"noTmp":true}, // 12
  {"platform":"darwin","worktree":"/Users/r2fx/repo.worktrees/worktrees/round/pi-worktree-r1-s0-0","cwd":"/Users/r2fx/repo.worktrees/worktrees/round/pi-worktree-r1-s0-0","home":"/Users/r2fx","agentDir":"/Users/r2fx/agent","pkgRoot":"/Users/r2fx/pkg","scratch":"/Users/r2fx/scratch","owned":[],"noTmp":true}, // 13
  {"platform":"darwin","worktree":"/Users/r2fx/repo.worktrees/round/.iso/pi-worktree-r2-s0-0","cwd":"/Users/r2fx/repo.worktrees/round/.iso/pi-worktree-r2-s0-0","home":"/Users/r2fx","agentDir":"/Users/r2fx/agent","pkgRoot":"/Users/r2fx/pkg","scratch":"/Users/r2fx/scratch","owned":[],"noTmp":true}, // 14
  {"platform":"darwin","worktree":"/Users/r2fx/ws.worktrees/hf","cwd":"/Users/r2fx/ws.worktrees/hf","home":"/Users/r2fx/home","agentDir":"/Users/r2fx/home/.pi/agent","pkgRoot":"/Users/r2fx/ws","owned":[],"noTmp":true}, // 15
  {"platform":"darwin","worktree":"/Users/pf41home/code/proj","cwd":"/Users/pf41home/code/proj","home":"/Users/pf41home","agentDir":"/Users/pf41home/.pi/agent","pkgRoot":"/pf41/pkg","owned":[],"noTmp":false}, // 16
  {"platform":"darwin","worktree":"/Users/r2fx/ws.worktrees/hf","cwd":"/Users/r2fx/ws.worktrees/hf","home":"/Users/r2fx/home","agentDir":"/Users/r2fx/home/.pi/agent","pkgRoot":"/Users/r2fx/ws","scratch":"/Users/r2fx/tmp/pi-foreman-scratch/s1/L1","owned":[],"noTmp":true}, // 17
  {"platform":"darwin","worktree":"/Users/r2fx/ws.worktrees/hf/sub","cwd":"/Users/r2fx/ws.worktrees/hf/sub","home":"/Users/r2fx/home","agentDir":"/Users/r2fx/home/.pi/agent","pkgRoot":"/Users/r2fx/ws","scratch":"/Users/r2fx/tmp/pi-foreman-scratch/s1/L1","owned":[],"noTmp":true}, // 18
  {"platform":"darwin","worktree":"/Users/r2fx/ws.worktrees/hf","cwd":"/Users/r2fx/ws.worktrees/hf","home":"/Users/r2fx/home","agentDir":"/Users/r2fx/home/.pi/agent","pkgRoot":"/Users/r2fx/ws","scratch":"/Users/r2fx/tmp/pi-foreman-scratch/s1/L1","scratchBase":"/Users/r2fx/tmp/pi-foreman-scratch","owned":[],"noTmp":true}, // 19
  {"platform":"darwin","worktree":"/Users/r2fx/repo.worktrees/round","cwd":"/Users/r2fx/scratch","home":"/Users/r2fx","agentDir":"/Users/r2fx/agent","pkgRoot":"/Users/r2fx/pkg","scratch":"/Users/r2fx/scratch","owned":[],"noTmp":true}, // 20
  {"platform":"darwin","worktree":"/Users/r2fx/selfhost","cwd":"/Users/r2fx/selfhost","home":"/Users/r2fx/home","agentDir":"/Users/r2fx/agent","pkgRoot":"/Users/r2fx/selfhost","owned":[],"noTmp":true}, // 21
  {"platform":"darwin","worktree":"/Users/r2fx/ws","cwd":"/Users/r2fx/ws","home":"/Users/r2fx/home","agentDir":"/Users/r2fx/home/.pi/agent","pkgRoot":"/Users/r2fx/ws","scratch":"/Users/r2fx/tmp/pi-foreman-scratch/s1/Lown","scratchBase":"/Users/r2fx/tmp/pi-foreman-scratch","owned":[],"noTmp":true}, // 22
  {"platform":"darwin","worktree":"/Users/r2fx/ws","cwd":"/Users/r2fx/ws","home":"/Users/r2fx/home","agentDir":"/Users/r2fx/home/.pi/agent","pkgRoot":"/Users/r2fx/ws","owned":["/Users/r2fx/home/.pi/agent/pi-foreman/state/usage","/Users/r2fx/home/.pi/agent/pi-foreman/state/usage/*","/Users/r2fx/home/.pi/agent/pi-foreman/state/live/01a1500b-own.json","/Users/r2fx/home/.pi/agent/pi-foreman/state/trace-01a1500b-own.jsonl"],"noTmp":true}, // 23
  {"platform":"darwin","worktree":"/Users/r2fx/pkg","cwd":"/Users/r2fx/pkg","home":"/Users/r2fx","agentDir":"/Users/r2fx/agent","pkgRoot":"/Users/r2fx/pkg","scratch":"/Users/r2fx/tmp/pi-foreman-scratch/child1","scratchBase":"/Users/r2fx/tmp/pi-foreman-scratch","owned":["/Users/r2fx/agent/pi-foreman/handoffs","/Users/r2fx/agent/sessions/*/subagent-artifacts","/Users/r2fx/pkg.worktrees","/Users/r2fx/agent/pi-foreman","/Users/r2fx/agent/foreman.json","/Users/r2fx/agent/settings.json"],"noTmp":true}, // 24
  {"platform":"darwin","worktree":"/Users/r2fx/repo","cwd":"/Users/r2fx/repo","home":"/Users/r2fx/home","agentDir":"/Users/r2fx/home/.pi/agent","pkgRoot":"/Users/r2fx/pkg","owned":[],"noTmp":true}, // 25
  {"platform":"darwin","worktree":"/Users/r2fx/repo.worktrees/round","cwd":"/Users/r2fx/repo.worktrees/round","home":"/Users/r2fx/home","agentDir":"/Users/r2fx/home/.pi/agent","pkgRoot":"/Users/r2fx/repo","scratch":"/Users/r2fx/tmp/pi-foreman-scratch/s1/L1","owned":[],"noTmp":true}, // 26
  {"platform":"win32","worktree":"C:\\w\\proj","cwd":"C:\\w\\proj","home":"C:\\Profiles\\u","agentDir":"C:\\Profiles\\u\\.pi\\agent","pkgRoot":"C:\\pkg","scratch":"C:\\t\\pfs\\s1","owned":[],"noTmp":false}, // 27
];
const run = (rows: Row[]): void => {
  for (const [ci, tool, input, roles] of rows) {
    for (const letter of roles) {
      const r = decide(CTX[ci]!, letter, tool, inputOf(input));
      assert.ok(!(r && "block" in r && r.block), `${letter} ${tool} ${JSON.stringify(input)}: not refused, got ${label(r)}`);
      assert.ok(!(r && "ask" in r && r.ask), `${letter} ${tool} ${JSON.stringify(input)}: not asked, got ${label(r)}`);
    }
  }
};

test("bashpath-win32", { skip: posixOnly }, () => {
  run([
    // bashpath-win32.test.ts:56
    [0,"bash","D=C:/r2fx/home/.pi/agent/pi-foreman; D=C:/r2fx/tmp/pi-foreman-scratch/s1/L1; cat $D/handoffs/s1/ruling.md","b"],
    // bashpath-win32.test.ts:70
    [0,"bash","cd C:/r2fx/ws.worktrees/hf; S=$FOREMAN_SCRATCH; mkdir -p $S; npm test > $S/tc.txt","m"],
  ]);
});

test("child-cd", { skip: posixOnly }, () => {
  run([
    // child-cd.test.ts:42
    [2,"bash","cd 'C:\\r2fx\\ws\\sub' && ls","b"],
    [2,"bash","cd C:/r2fx/ws/sub && ls","b"],
    [2,"bash","cd sub && ls","b"],
    // child-cd.test.ts:45
    [1,"bash","cd a~1 && ls","b"],
    // child-cd.test.ts:65
    [1,"bash","if true; then cd sub; fi; ls","b"],
    // child-cd.test.ts:77
    [1,"bash","mkdir -p build && cd build && cargo test","b"],
    [1,"bash","cd nonexist/deeper; cd sub && ls","b"],
    [1,"bash","mkdir -p build && cd build && cd .. && ls","b"],
  ]);
});

test("child-install-owned-root", { skip: posixOnly }, () => {
  run([
    // child-install-owned-root.test.ts:29
    [4,"bash","npm ci --prefix=/Users/r2fx/ws.worktrees/r1","b"],
  ]);
});

test("child-install-owned-root-win32", { skip: posixOnly }, () => {
  run([
    // child-install-owned-root-win32.test.ts:33
    [5,"bash","npm install --prefix C:/r2fx/ws.worktrees/r1","b"],
  ]);
});

test("childscratch", { skip: posixOnly }, () => {
  run([
    // childscratch.test.ts:128
    [6,"bash","cd /Users/r2fx/tmp/pi-foreman-scratch/sess-3/L-g && ls","b"],
    // childscratch.test.ts:129
    [6,"bash","cd $FOREMAN_SCRATCH && ls","b"],
    // childscratch.test.ts:154
    [8,"bash","node $FOREMAN_SCRATCH/probe/probe.mjs","b"],
    // childscratch.test.ts:156
    [8,"bash","node /Users/r2fx/tmp/pi-foreman-scratch/sess-r25/L-mine/probe/probe.mjs > /Users/r2fx/tmp/pi-foreman-scratch/sess-r25/L-mine/out.log 2>&1","b"],
    // childscratch.test.ts:157
    [8,"bash","cd $FOREMAN_SCRATCH && ls","b"],
    // childscratch.test.ts:158
    [8,"read",{"path":"/Users/r2fx/tmp/pi-foreman-scratch/sess-r25/L-mine/probe/probe.mjs"},"b"],
    [8,"write",{"path":"/Users/r2fx/tmp/pi-foreman-scratch/sess-r25/L-mine/probe/probe.mjs"},"b"],
    [8,"edit",{"path":"/Users/r2fx/tmp/pi-foreman-scratch/sess-r25/L-mine/probe/probe.mjs"},"b"],
    [8,"ls",{"path":"/Users/r2fx/tmp/pi-foreman-scratch/sess-r25/L-mine/probe/probe.mjs"},"b"],
    [8,"grep",{"path":"/Users/r2fx/tmp/pi-foreman-scratch/sess-r25/L-mine/probe/probe.mjs"},"b"],
    [8,"find",{"path":"/Users/r2fx/tmp/pi-foreman-scratch/sess-r25/L-mine/probe/probe.mjs"},"b"],
    // childscratch.test.ts:162
    [7,"bash","cd $FOREMAN_SCRATCH && ls","b"],
  ]);
});

test("childtmp", { skip: posixOnly }, () => {
  run([
    // childtmp.test.ts:47
    [9,"bash","npm test > /dev/null 2>&1","b"],
    // childtmp.test.ts:55
    [9,"bash","npm test > /tmp/_t1.txt","m"],
  ]);
});

test("lane2-apply", { skip: posixOnly }, () => {
  run([
    // lane2-apply.test.ts:51
    [11,"bash","sed -n 1,5p package.json","b"],
    // lane2-apply.test.ts:52
    [10,"bash","sed -n '1,5p' .agents/a.md","m"],
    // lane2-apply.test.ts:53
    [10,"bash","sed -n 1,5p .agents/a.md | head -2","m"],
    // lane2-apply.test.ts:54
    [10,"bash","cat .agents/a.md","m"],
  ]);
});

test("lane2-isolation", { skip: posixOnly }, () => {
  run([
    // lane2-isolation.test.ts:88
    [13,"bash","git -C /Users/r2fx/repo.worktrees/worktrees/round/pi-worktree-r1-s0-0 commit -m x","b"],
    // lane2-isolation.test.ts:108
    [14,"bash","git -C /Users/r2fx/repo.worktrees/round/.iso/pi-worktree-r2-s0-0 commit -m x","b"],
  ]);
});

test("permoverlay", { skip: posixOnly }, () => {
  run([
    // permoverlay.test.ts:241
    [3,"bash","cd /Users/r2fx/ws; grep -n \"usage\" tests/replay/fake_provider.ts | head -20; grep -n '\"compaction\"' -A25 config/foreman.schema.json | head -40; grep -n '\"compaction\"' -A6 config/foreman.defaults.json; grep -n \"PROVIDERS\\s*=\" tests/replay/fake_provider.ts; grep -n \"cacheWarming\" node_modules/@earendil-works/pi-coding-agent/docs/settings.md","b"],
    [3,"bash","cd /Users/r2fx/ws && grep -n -A12 '\"compaction\"' config/foreman.defaults.json; sed -n 330,365p config/foreman.schema.json; grep -n '\"minimum\": 0.3' config/foreman.schema.json","b"],
    [3,"bash","cat config/foreman.defaults.json | head -60; grep -n \"compact\" docs/sessions.md | head -20","b"],
    [3,"bash","cd /Users/r2fx/ws; sed -n 1,60p extensions/core-adapter/compaction.ts; grep -n '\"threshold\"' -A12 config/foreman.defaults.json | head -20; sed -n 800,812p extensions/core-adapter/index.ts","b"],
    // permoverlay.test.ts:260
    [15,"bash","cd /Users/r2fx/ws.worktrees/hf; grep -rln \"symbols.json\" --exclude-dir=node_modules --exclude-dir=.git . | head","b"],
    [15,"bash","cd /Users/r2fx/ws.worktrees/hf; grep -rln \"symbols.json\" --exclude-dir=node_modules --exclude-dir=.git . | head","m"],
    // permoverlay.test.ts:292
    [18,"bash","cd ..","b"],
    // permoverlay.test.ts:293
    [18,"bash","cd /Users/r2fx/ws.worktrees/hf && ls","b"],
    // permoverlay.test.ts:294
    [18,"bash","cd $FOREMAN_SCRATCH && ls","b"],
    // permoverlay.test.ts:301
    [15,"bash","cd $FOREMAN_SCRATCH && ls","b"],
    // permoverlay.test.ts:322
    [3,"bash","cat config/permissions.baseline.json","b"],
    // permoverlay.test.ts:324
    [3,"bash","sed -n 1,40p config/permissions.baseline.json","b"],
    // permoverlay.test.ts:358
    [17,"bash","node $FOREMAN_SCRATCH/probe/probe.mjs","b"],
    // permoverlay.test.ts:360
    [17,"bash","cat /Users/r2fx/tmp/pi-foreman-scratch/s1/L1/replay.log > /Users/r2fx/tmp/pi-foreman-scratch/s1/L1/copy.log","b"],
    // permoverlay.test.ts:580
    [19,"bash","node /Users/r2fx/tmp/pi-foreman-scratch/s1/L1/f.txt","b"],
    // permoverlay.test.ts:672
    [3,"bash","grep -rn p config/foreman.defaults.json","b"],
    // permoverlay.test.ts:699
    [3,"bash","sed -n 1,5p config/foreman.defaults.json","b"],
    [3,"bash","sed -E 's/a/b/' config/foreman.defaults.json","b"],
    [3,"bash","sed -s -n p config/foreman.defaults.json","b"],
    // permoverlay.test.ts:739
    [3,"bash","cd /Users/r2fx/ws; grep -n \"usage\" tests/replay/fake_provider.ts | head -20; grep -n '\"compaction\"' -A6 config/foreman.defaults.json; grep -n \"cacheWarming\" node_modules/@earendil-works/pi-coding-agent/docs/settings.md","b"],
    [3,"bash","ls node_modules | head -3; ls node_modules/.bin | head -3; cat extensions/core-adapter/cachepolicy.ts","b"],
    [3,"bash","grep -rln \"symbols.json\" --exclude-dir=node_modules --exclude-dir=.git . | head","b"],
    [3,"bash","cat config/foreman.defaults.json | head","b"],
    [3,"bash","wc -l config/foreman.defaults.json","b"],
    [3,"bash","diff config/foreman.defaults.json config/foreman.defaults.json","b"],
    [3,"bash","ls -l node_modules","b"],
    [3,"bash","sed -e p config/foreman.defaults.json","b"],
    // permoverlay.test.ts:764
    [3,"bash","head config/foreman.defaults.json","b"],
  ]);
});

test("permoverlay-r41", { skip: posixOnly }, () => {
  run([
    // permoverlay-r41.test.ts:475
    [16,"bash","ls /Users/pf41home","m"],
    [16,"bash","ls /Users/pf41home","b"],
  ]);
});

test("permoverlay-vars", { skip: posixOnly }, () => {
  run([
    // permoverlay-vars.test.ts:50
    [17,"bash","cat x > $FOREMAN_SCRATCH/probe/out.txt","b"],
    // permoverlay-vars.test.ts:63
    [17,"bash","D=/Users/r2fx/home/.pi/agent/pi-foreman; D=/Users/r2fx/tmp/pi-foreman-scratch/s1/L1; cat $D/handoffs/s1/ruling.md","b"],
  ]);
});

test("probescan", { skip: posixOnly }, () => {
  run([
    // probescan.test.ts:86
    [12,"bash","make test","r"],
    // probescan.test.ts:152
    [20,"bash","node $FOREMAN_SCRATCH/ordinary.mjs","b"],
    // probescan.test.ts:153
    [20,"bash","node /Users/r2fx/scratch/read.mjs /Users/r2fx/scratch/plain.mjs","b"],
    // probescan.test.ts:179
    [12,"bash","node --test --test-reporter=spec tests/t.test.mjs","r"],
    [12,"bash","node --test --test-reporter dot --test-reporter-destination stdout tests/t.test.mjs","r"],
    [12,"bash","node --test --test-reporter=junit --test-reporter-destination=stderr","r"],
    [12,"bash","node --test --import ./tests/t.test.mjs","r"],
    // probescan.test.ts:194
    [12,"bash","npm test tests/t.test.mjs","r"],
    [12,"bash","npm run test:node tests/t.test.mjs","r"],
    [12,"bash","npm run test:node --silent","r"],
    // probescan.test.ts:226
    [20,"bash","python3 -X dev plain.mjs","b"],
    [20,"bash","node --import ./plain.mjs plain.mjs","b"],
    [20,"bash","npx tsx plain.mjs","b"],
    // probescan.test.ts:248
    [12,"bash","pytest -p no:cacheprovider tests/test_x.py","r"],
    [12,"bash","pytest -p no:cacheprovider","r"],
    [12,"bash","pytest -sv tests/test_x.py","r"],
    [12,"bash","pytest -rA tests/test_x.py","r"],
    [12,"bash","make test PYTHON=python3","r"],
    [12,"bash","make test PYTHON=python3 V=1","r"],
    // probescan.test.ts:299
    [12,"bash","pytest -k name -p no:cacheprovider tests/test_x.py","r"],
    [12,"bash","pytest -kname -pno:cacheprovider tests/test_x.py","r"],
    [12,"bash","make test -j4 --keep-going","r"],
    [12,"bash","make test -j 4 --jobs=2 --silent --always-make --no-print-directory --dry-run","r"],
    [12,"bash","node --test --test-reporter=some-npm-reporter tests/t.test.mjs","r"],
    // probescan.test.ts:324
    [20,"bash","node --unhandled-rejections strict plain.mjs","b"],
    [20,"bash","bash -eo pipefail -c true","b"],
    // probescan.test.ts:364
    [12,"bash","node .","b"],
  ]);
});

test("r12-interp-shadow", { skip: posixOnly }, () => {
  run([
    // r12-interp-shadow.test.ts:67
    [21,"bash","python -c \"print(open('package.json').read())\"","b"],
    [21,"bash","python3.12 -c \"print(open('package.json').read())\"","b"],
  ]);
});

test("r14-child-msgfile", { skip: posixOnly }, () => {
  run([
    // r14-child-msgfile.test.ts:126
    [22,"bash","git commit -F docs/pkg-notes.txt","b"],
  ]);
});

test("r14-own-state-read", { skip: posixOnly }, () => {
  run([
    // r14-own-state-read.test.ts:67
    [23,"bash","cd /Users/r2fx/ws && node --experimental-strip-types .workflow/scratch/dialogs.mjs ~/.pi/agent/pi-foreman/state/trace-01a1500b-own.jsonl 2>&1 | head -80","m"],
    // r14-own-state-read.test.ts:68
    [23,"bash","cd /Users/r2fx/ws && node .workflow/scratch/dialogs.mjs ~/.pi/agent/pi-foreman/state/trace-01a1500b-own.jsonl","m"],
    // r14-own-state-read.test.ts:69
    [23,"bash","cd /Users/r2fx/ws && python3 .workflow/scratch/dialogs.py ~/.pi/agent/pi-foreman/state/trace-01a1500b-own.jsonl | head -5","m"],
  ]);
});

test("r29-protected-read-only", { skip: posixOnly }, () => {
  run([
    // r29-protected-read-only.test.ts:150
    [24,"bash","cd sub && git diff -- ../package.json","b"],
  ]);
});

test("role-skills-live-line", { skip: posixOnly }, () => {
  run([
    // role-skills-live-line.test.ts:66
    [25,"bash","cat ~/.agents/skills/x/SKILL.md | head -3","b"],
    // role-skills-live-line.test.ts:67
    [25,"bash","cat ~/.agents/skills/x/SKILL.md","b"],
    // role-skills-live-line.test.ts:68
    [25,"bash","cat /Users/r2fx/home/.agents/skills/x/SKILL.md | head -3","b"],
    // role-skills-live-line.test.ts:69
    [25,"bash","cat $HOME/.agents/skills/x/SKILL.md | head -3","b"],
    // role-skills-live-line.test.ts:92
    [25,"bash","cat /Users/r2fx/home/.agents/skills/x/SKILL.md","b"],
  ]);
});

test("role-skills-overlay", { skip: posixOnly }, () => {
  run([
    // role-skills-overlay.test.ts:101
    [25,"bash","grep -n name /Users/r2fx/home/.agents/skills/named/SKILL.md","b"],
    // role-skills-overlay.test.ts:107
    [25,"bash","cat /Users/r2fx/home/.agents/skills/other/SKILL.md","m"],
  ]);
});

test("roundowner-redirect", { skip: posixOnly }, () => {
  run([
    // roundowner-redirect.test.ts:45
    [12,"bash","cat f > /Users/r2fx/scratch/out","r"],
    // roundowner-redirect.test.ts:56
    [20,"bash","perl -pi -e s/x/y/ /Users/r2fx/scratch/f","r"],
  ]);
});

test("s2-child-redirects", { skip: posixOnly }, () => {
  run([
    // s2-child-redirects.test.ts:53
    [12,"bash","npm test </dev/null","r"],
    [12,"bash","npm test </dev/null 2>&1","r"],
    [12,"bash","npm test 2>&1 </dev/null","r"],
  ]);
});

test("shellvars-cases", { skip: posixOnly }, () => {
  run([
    // shellvars-cases.test.ts:49
    [26,"bash","cd /Users/r2fx/repo.worktrees/round; S=$FOREMAN_SCRATCH; mkdir -p $S; npm test > $S/tc.txt","m"],
  ]);
});

test("shellvars-win32", { skip: posixOnly }, () => {
  run([
    // shellvars-win32.test.ts:126
    [27,"bash","cd C:/w/proj && ls","b"],
    // shellvars-win32.test.ts:127
    [27,"bash","cd \"C:\\w\\proj\" && ls","b"],
  ]);
});
