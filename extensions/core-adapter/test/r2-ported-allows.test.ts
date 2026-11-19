// Round 2, step 6a: allow pins of the old permission layer's false-block fixes, ported to the gate. Each row is an input the old layer allowed (a test of an old false
// block or a near-miss beside a refusal); the gate must not block it for the listed roles (m = foreman, b = builder, r = round reviewer). The allow rule is not pinned,
// only that the gate neither blocks nor asks. The comment above a group names the old test file and test line. Rows the gate blocks today are not here (see the step 6a gap table).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import { baseFloorEnv, gateDecide, type GateResult } from "../gate.ts";
import { tmpRoots, type GateRoots } from "../pathrules.ts";

// the fixture worlds are literal strings (nothing is created on disk); the win32 rows run on a posix host and show what the gate code says for that string
const posixOnly = { skip: process.platform === "win32" };
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
  {"platform":"win32","worktree":"C:\\w\\proj","cwd":"C:\\w\\proj","home":"C:\\Profiles\\u","agentDir":"C:\\Profiles\\u\\.pi\\agent","pkgRoot":"C:\\pkg","scratch":"C:\\t\\pfs\\s1","owned":[],"noTmp":false}, // 0
  {"platform":"darwin","worktree":"/Users/r2fx/proj","cwd":"/Users/r2fx/proj","home":"/Users/r2fx/home","agentDir":"/Users/r2fx/agent","pkgRoot":"/Users/r2fx/pkg","scratchBase":"/Users/r2fx/tmp/pi-foreman-scratch","owned":["/Users/r2fx/agent/pi-foreman/handoffs","/Users/r2fx/agent/sessions/*/subagent-artifacts","/Users/r2fx/proj.worktrees","/Users/r2fx/agent/pi-foreman","/Users/r2fx/agent/foreman.json","/Users/r2fx/agent/settings.json","/Users/r2fx/x/pf-npm-root","/Users/r2fx/proj/.pi/tasks/bg-session-1-*","/Users/r2fx/proj/.pi/scratch","/Users/r2fx/proj/.pi/scratch/*","/Users/r2fx/agent/pi-foreman/state/usage","/Users/r2fx/agent/pi-foreman/state/usage/*","/Users/r2fx/agent/pi-foreman/state/live/bg-session-1.json","/Users/r2fx/agent/pi-foreman/state/trace-bg-session-1.jsonl","/Users/r2fx/agent/pi-foreman/state/usage/bg-session-1.jsonl","/Users/r2fx/proj/.pi/tasks/bg-session-1-*"],"noTmp":true}, // 1
  {"platform":"darwin","worktree":"/Users/r2fx/proj","cwd":"/Users/r2fx/proj","home":"/Users/r2fx/home","agentDir":"/Users/r2fx/agent","pkgRoot":"/Users/r2fx/pkg","owned":[],"noTmp":true}, // 2
  {"platform":"darwin","worktree":"/Users/r2fx/proj","cwd":"/Users/r2fx/proj","home":"/Users/r2fx/home","agentDir":"/Users/r2fx/home/.pi/agent","pkgRoot":"/Users/r2fx/proj","owned":[],"noTmp":true}, // 3
  {"platform":"darwin","worktree":"/Users/r2fx/proj","cwd":"/Users/r2fx/proj","home":"/Users/r2fx/home","agentDir":"/Users/r2fx/home/.pi/agent","pkgRoot":"/Users/r2fx/pkg","owned":[],"noTmp":true}, // 4
  {"platform":"win32","worktree":"C:\\w\\proj","cwd":"C:\\w\\proj","home":"C:\\Profiles\\u","agentDir":"C:\\Profiles\\u\\.pi\\agent","pkgRoot":"C:\\pkg","owned":[],"noTmp":false}, // 5
  {"platform":"darwin","worktree":"/Users/r2fx/proj","cwd":"/Users/r2fx/proj","home":"/Users/r2fx/home","agentDir":"/Users/r2fx/agent","scratch":"/Users/r2fx/scratch","owned":[],"noTmp":false}, // 6
  {"platform":"darwin","worktree":"/Users/r2fx/proj","cwd":"/Users/r2fx/proj","home":"/Users/r2fx/home","agentDir":"/Users/r2fx/home/.pi/agent","owned":[],"noTmp":true}, // 7
  {"platform":"linux","worktree":"/Users/r2fx/proj","cwd":"/Users/r2fx/proj","home":"/Users/r2fx/home","agentDir":"/Users/r2fx/agent","pkgRoot":"/Users/r2fx/pkg","owned":[],"handoff":"/Users/r2fx/agent/pi-foreman/handoffs/s1","noTmp":false}, // 8
  {"platform":"darwin","worktree":"/Users/r2fx/home/code/proj","cwd":"/Users/r2fx/home/code/proj","home":"/Users/r2fx/home","agentDir":"/Users/r2fx/agent","pkgRoot":"/Users/r2fx/pkg","scratch":"/Users/r2fx/tmp/pi-foreman-scratch/child1","scratchBase":"/Users/r2fx/tmp/pi-foreman-scratch","owned":["/Users/r2fx/agent/pi-foreman/handoffs","/Users/r2fx/agent/sessions/*/subagent-artifacts","/Users/r2fx/home/repo.worktrees","/Users/r2fx/agent/pi-foreman","/Users/r2fx/agent/foreman.json","/Users/r2fx/agent/settings.json"],"noTmp":true}, // 9
  {"platform":"darwin","worktree":"/Users/r2fx/home/code/proj","cwd":"/Users/r2fx/home/code/proj","home":"/Users/r2fx/home","agentDir":"/Users/r2fx/agent","pkgRoot":"/Users/r2fx/pkg","scratch":"/Users/r2fx/scratch","owned":[],"noTmp":true}, // 10
  {"platform":"darwin","worktree":"/Users/r2fx/home/code/proj","cwd":"/Users/r2fx/home/code/proj","home":"/Users/r2fx/home","agentDir":"/Users/r2fx/agent","pkgRoot":"/Users/r2fx/pkg","scratchBase":"/Users/r2fx/tmp/pi-foreman-scratch","owned":["/Users/r2fx/agent/pi-foreman/handoffs","/Users/r2fx/agent/sessions/*/subagent-artifacts","/Users/r2fx/home/repo.worktrees","/Users/r2fx/agent/pi-foreman","/Users/r2fx/agent/foreman.json","/Users/r2fx/agent/settings.json"],"noTmp":true}, // 11
  {"platform":"darwin","worktree":"/Users/r2fx/home/code/proj","cwd":"/Users/r2fx/home/code/proj/extensions/core-adapter","home":"/Users/r2fx/home","agentDir":"/Users/r2fx/agent","pkgRoot":"/Users/r2fx/pkg","scratch":"/Users/r2fx/tmp/pi-foreman-scratch/child1","scratchBase":"/Users/r2fx/tmp/pi-foreman-scratch","owned":["/Users/r2fx/agent/pi-foreman/handoffs","/Users/r2fx/agent/sessions/*/subagent-artifacts","/Users/r2fx/home/repo.worktrees","/Users/r2fx/agent/pi-foreman","/Users/r2fx/agent/foreman.json","/Users/r2fx/agent/settings.json","/Users/r2fx/home/repo/.workflow/LEDGER-round.md","/Users/r2fx/home/repo/.workflow/LEDGER-*.md","/Users/r2fx/agent/pi-foreman/handoffs/s1","/Users/r2fx/agent/pi-foreman/handoffs/s1/*","/Users/r2fx/home/code/proj","/Users/r2fx/home/code/proj/*"],"noTmp":true}, // 12
  {"platform":"darwin","worktree":"/Users/r2fx/home/code/proj","cwd":"/Users/r2fx/home/code/proj","home":"/Users/r2fx/home","agentDir":"/Users/r2fx/agent","pkgRoot":"/Users/r2fx/pkg","scratch":"/Users/r2fx/tmp/pi-foreman-scratch/child1","scratchBase":"/Users/r2fx/tmp/pi-foreman-scratch","owned":["/Users/r2fx/agent/pi-foreman/handoffs","/Users/r2fx/agent/sessions/*/subagent-artifacts","/Users/r2fx/home/repo.worktrees","/Users/r2fx/agent/pi-foreman","/Users/r2fx/agent/foreman.json","/Users/r2fx/agent/settings.json","/Users/r2fx/home/repo/.workflow/LEDGER-round.md","/Users/r2fx/home/repo/.workflow/LEDGER-*.md","/Users/r2fx/agent/pi-foreman/handoffs/s1","/Users/r2fx/agent/pi-foreman/handoffs/s1/*","/Users/r2fx/home/code/proj","/Users/r2fx/home/code/proj/*"],"noTmp":true}, // 13
  {"platform":"darwin","worktree":"/Users/r2fx/home/code/proj","cwd":"/Users/r2fx/home/code/proj","home":"/Users/r2fx/home","agentDir":"/Users/r2fx/agent","pkgRoot":"/Users/r2fx/pkg","scratch":"/Users/r2fx/tmp/pi-foreman-scratch/child1","scratchBase":"/Users/r2fx/tmp/pi-foreman-scratch","owned":["/Users/r2fx/agent/pi-foreman/handoffs","/Users/r2fx/agent/sessions/*/subagent-artifacts","/Users/r2fx/home/code/proj.worktrees","/Users/r2fx/agent/pi-foreman","/Users/r2fx/agent/foreman.json","/Users/r2fx/agent/settings.json","/Users/r2fx/home/code/proj/.workflow/LEDGER-round.md","/Users/r2fx/home/code/proj/.workflow/LEDGER-*.md","/Users/r2fx/agent/pi-foreman/handoffs/s1","/Users/r2fx/agent/pi-foreman/handoffs/s1/*","/Users/r2fx/home/code/proj.worktrees/round","/Users/r2fx/home/code/proj.worktrees/round/*"],"noTmp":true}, // 14
  {"platform":"darwin","worktree":"/Users/r2fx/home/code/proj","cwd":"/Users/r2fx/home/code/proj","home":"/Users/r2fx/home","agentDir":"/Users/r2fx/agent","pkgRoot":"/Users/r2fx/pkg","scratchBase":"/Users/r2fx/tmp/pi-foreman-scratch","owned":["/Users/r2fx/agent/pi-foreman/handoffs","/Users/r2fx/agent/sessions/*/subagent-artifacts","/Users/r2fx/home/code/proj.worktrees","/Users/r2fx/agent/pi-foreman","/Users/r2fx/agent/foreman.json","/Users/r2fx/agent/settings.json"],"noTmp":true}, // 15
  {"platform":"win32","worktree":"C:\\w\\proj","cwd":"C:\\w\\proj","home":"C:\\Profiles\\u","agentDir":"C:\\Profiles\\u\\.pi\\agent","owned":[],"noTmp":false}, // 16
  {"platform":"darwin","worktree":"/Users/r2fx/proj","cwd":"/Users/r2fx/proj","home":"/Users/r2fx/home","agentDir":"/Users/r2fx/home/.pi/agent","pkgRoot":"/Users/r2fx/proj","owned":["/Users/r2fx/proj/.pi/tasks/sess-own-*"],"noTmp":true}, // 17
  {"platform":"darwin","worktree":"/Users/r2fx/proj","cwd":"/Users/r2fx/proj","home":"/Users/r2fx/home","agentDir":"/Users/r2fx/home/.pi/agent","pkgRoot":"/Users/r2fx/pkg","scratchBase":"/Users/r2fx/tmp/pi-foreman-scratch","owned":["/Users/r2fx/home/.pi/agent/pi-foreman/handoffs","/Users/r2fx/home/.pi/agent/sessions/*/subagent-artifacts","/Users/r2fx/proj.worktrees","/Users/r2fx/home/.pi/agent/pi-foreman","/Users/r2fx/home/.pi/agent/foreman.json","/Users/r2fx/home/.pi/agent/settings.json"],"noTmp":true}, // 18
  {"platform":"darwin","worktree":"/Users/r2fx/proj","cwd":"/Users/r2fx/proj","home":"/Users/r2fx/home","agentDir":"/Users/r2fx/home/.pi/agent","pkgRoot":"/Users/r2fx/pkg","scratch":"/Users/r2fx/tmp/pi-foreman-scratch/child1","scratchBase":"/Users/r2fx/tmp/pi-foreman-scratch","owned":["/Users/r2fx/home/.pi/agent/pi-foreman/handoffs","/Users/r2fx/home/.pi/agent/sessions/*/subagent-artifacts","/Users/r2fx/proj.worktrees","/Users/r2fx/home/.pi/agent/pi-foreman","/Users/r2fx/home/.pi/agent/foreman.json","/Users/r2fx/home/.pi/agent/settings.json"],"noTmp":true}, // 19
  {"platform":"darwin","worktree":"/Users/r2fx/home/code/proj","cwd":"/Users/r2fx/home/code/proj","home":"/Users/r2fx/home","agentDir":"/Users/r2fx/agent","pkgRoot":"/Users/r2fx/pkg","owned":[],"noTmp":false}, // 20
  {"platform":"darwin","worktree":"/Users/r2fx/proj","cwd":"/Users/r2fx/proj","home":"/Users/r2fx/home","agentDir":"/Users/r2fx/agent","pkgRoot":"/Users/r2fx/pkg","owned":[],"noTmp":false}, // 21
  {"platform":"darwin","worktree":"/Users/r2fx/proj","cwd":"/Users/r2fx/agent","home":"/Users/r2fx/home","agentDir":"/Users/r2fx/agent","pkgRoot":"/Users/r2fx/pkg","owned":[],"noTmp":false}, // 22
  {"platform":"darwin","worktree":"/Users/r2fx/home/code/proj","cwd":"/Users/r2fx/home/code/proj","home":"/Users/r2fx/home","agentDir":"/Users/r2fx/home/.pi/agent","pkgRoot":"/Users/r2fx/pkg","owned":[],"noTmp":false}, // 23
  {"platform":"darwin","worktree":"/Users/r2fx/proj","cwd":"/Users/r2fx/proj","home":"/Users/r2fx/home","agentDir":"/Users/r2fx/home/.pi/agent","pkgRoot":"/Users/r2fx/pkg","scratch":"/Users/r2fx/scratch","owned":[],"noTmp":true}, // 24
  {"platform":"darwin","worktree":"/Users/r2fx/proj","cwd":"/Users/r2fx/proj","home":"/Users/r2fx/home","agentDir":"/Users/r2fx/home/.pi/agent","pkgRoot":"/Users/r2fx/pkg","scratch":"/Users/r2fx/tmp/pi-foreman-scratch/child1","scratchBase":"/Users/r2fx/tmp/pi-foreman-scratch","owned":[],"noTmp":true}, // 25
  {"platform":"darwin","worktree":"/Users/r2fx/proj","cwd":"/Users/r2fx/proj","home":"/Users/r2fx/home","agentDir":"/Users/r2fx/home/.pi/agent","pkgRoot":"/Users/r2fx/proj","scratchBase":"/Users/r2fx/tmp/pi-foreman-scratch","owned":[],"noTmp":true}, // 26
  {"platform":"darwin","worktree":"/Users/r2fx/home/code/proj","cwd":"/Users/r2fx/scratch","home":"/Users/r2fx/home","agentDir":"/Users/r2fx/agent","pkgRoot":"/Users/r2fx/pkg","scratch":"/Users/r2fx/scratch","owned":[],"noTmp":true}, // 27
  {"platform":"darwin","worktree":"/Users/r2fx/proj","cwd":"/Users/r2fx/proj/bench/pi-lock","home":"/Users/r2fx/home","agentDir":"/Users/r2fx/home/.pi/agent","pkgRoot":"/Users/r2fx/pkg","owned":[],"noTmp":true}, // 28
  {"platform":"win32","worktree":"C:\\w\\proj","cwd":"C:\\w\\proj\\bench\\pi-lock","home":"C:\\Profiles\\u","agentDir":"C:\\Profiles\\u\\.pi\\agent","pkgRoot":"C:\\pkg","owned":[],"noTmp":false}, // 29
  {"platform":"darwin","worktree":"/Users/r2fx/proj","cwd":"/Users/r2fx/proj","home":"/Users/r2fx/home","agentDir":"/Users/r2fx/home/.pi/agent","pkgRoot":"/Users/r2fx/proj","owned":["/Users/r2fx/proj/.pi/tasks/sess-own-*","/Users/r2fx/proj/.pi/scratch","/Users/r2fx/proj/.pi/scratch/*"],"noTmp":true}, // 30
  {"platform":"darwin","worktree":"/Users/r2fx/proj","cwd":"/Users/r2fx/proj","home":"/Users/r2fx/home","agentDir":"/Users/r2fx/home/.pi/agent","pkgRoot":"/Users/r2fx/proj","owned":["/Users/r2fx/x/pf-r10-plainwf/hub/.workflow","/Users/r2fx/x/pf-r10-plainwf/hub/.workflow/*"],"noTmp":true}, // 31
  {"platform":"darwin","worktree":"/Users/r2fx/proj","cwd":"/Users/r2fx/proj","home":"/Users/r2fx/home","agentDir":"/Users/r2fx/home/.pi/agent","pkgRoot":"/Users/r2fx/proj","owned":["/Users/r2fx/home/.pi/agent/pi-foreman/state/usage","/Users/r2fx/home/.pi/agent/pi-foreman/state/usage/*"],"noTmp":true}, // 32
  {"platform":"darwin","worktree":"/Users/r2fx/proj","cwd":"/Users/r2fx/proj","home":"/Users/r2fx/home","agentDir":"/Users/r2fx/home/.pi/agent","pkgRoot":"/Users/r2fx/proj","owned":["/Users/r2fx/home/.pi/agent/pi-foreman/state/usage","/Users/r2fx/home/.pi/agent/pi-foreman/state/usage/*","/Users/r2fx/home/.pi/agent/pi-foreman/state/live/01a14b65-own.json"],"noTmp":true}, // 33
  {"platform":"darwin","worktree":"/Users/r2fx/proj","cwd":"/Users/r2fx/proj","home":"/Users/r2fx/home","agentDir":"/Users/r2fx/home/.pi/agent","pkgRoot":"/Users/r2fx/proj","owned":["/Users/r2fx/x/pf-r13-bashlog/pi-bash-0123456789abcdef.log"],"noTmp":true}, // 34
  {"platform":"darwin","worktree":"/Users/r2fx/proj","cwd":"/Users/r2fx/proj","home":"/Users/r2fx/home","agentDir":"/Users/r2fx/home/.pi/agent","pkgRoot":"/Users/r2fx/proj","scratch":"/Users/r2fx/tmp/pi-foreman-scratch/child1","scratchBase":"/Users/r2fx/tmp/pi-foreman-scratch","owned":[],"noTmp":true}, // 35
  {"platform":"darwin","worktree":"/Users/r2fx/proj","cwd":"/Users/r2fx/proj","home":"/Users/r2fx/home","agentDir":"/Users/r2fx/home/.pi/agent","pkgRoot":"/Users/r2fx/proj","owned":["/Users/r2fx/proj/.pi/tasks/01a1500b-own-*","/Users/r2fx/proj/.pi/tasks/01a1500b-own-*"],"noTmp":true}, // 36
  {"platform":"darwin","worktree":"/Users/r2fx/proj","cwd":"/Users/r2fx/proj","home":"/Users/r2fx/home","agentDir":"/Users/r2fx/home/.pi/agent","pkgRoot":"/Users/r2fx/proj","owned":["/Users/r2fx/home/.pi/agent/pi-foreman/state/usage","/Users/r2fx/home/.pi/agent/pi-foreman/state/usage/*","/Users/r2fx/home/.pi/agent/pi-foreman/state/live/01a1500b-own.json","/Users/r2fx/home/.pi/agent/pi-foreman/state/trace-01a1500b-own.jsonl"],"noTmp":true}, // 37
  {"platform":"darwin","worktree":"/Users/r2fx/proj","cwd":"/Users/r2fx/proj","home":"/Users/r2fx/home","agentDir":"/Users/r2fx/agent","pkgRoot":"/Users/r2fx/proj","owned":[],"noTmp":false}, // 38
  {"platform":"darwin","worktree":"/Users/r2fx/proj","cwd":"/Users/r2fx/scratch","home":"/Users/r2fx/home","agentDir":"/Users/r2fx/agent","pkgRoot":"/Users/r2fx/pkg","scratch":"/Users/r2fx/scratch","owned":[],"noTmp":true}, // 39
  {"platform":"darwin","worktree":"/Users/r2fx/home/code/proj","cwd":"/Users/r2fx/home/code/proj","home":"/Users/r2fx/home","agentDir":"/Users/r2fx/agent","pkgRoot":"/Users/r2fx/home/code/proj","scratch":"/Users/r2fx/tmp/pi-foreman-scratch/child1","scratchBase":"/Users/r2fx/tmp/pi-foreman-scratch","owned":["/Users/r2fx/agent/pi-foreman/handoffs","/Users/r2fx/agent/sessions/*/subagent-artifacts","/Users/r2fx/home/code/proj.worktrees","/Users/r2fx/agent/pi-foreman","/Users/r2fx/agent/foreman.json","/Users/r2fx/agent/settings.json"],"noTmp":true}, // 40
  {"platform":"darwin","worktree":"/Users/r2fx/proj","cwd":"/Users/r2fx/proj","home":"/Users/r2fx/home","agentDir":"/Users/r2fx/home/.pi/agent","pkgRoot":"/Users/r2fx/proj","owned":["/Users/r2fx/home/.pi/agent/pi-foreman/state/usage","/Users/r2fx/home/.pi/agent/pi-foreman/state/usage/*","/Users/r2fx/home/.pi/agent/pi-foreman/state/live/01a1500b-own.json","/Users/r2fx/home/.pi/agent/pi-foreman/state/trace-01a1500b-own.jsonl","/Users/r2fx/home/.pi/agent/pi-foreman/state/usage/01a1500b-fsess.jsonl"],"noTmp":true}, // 41
  {"platform":"darwin","worktree":"/Users/r2fx/proj","cwd":"/Users/r2fx/proj","home":"/Users/r2fx/home","agentDir":"/Users/r2fx/home/.pi/agent","pkgRoot":"/Users/r2fx/proj","scratch":"/Users/r2fx/scratch","owned":[],"noTmp":true}, // 42
  {"platform":"darwin","worktree":"/Users/r2fx/proj","cwd":"/Users/r2fx/proj","home":"/Users/r2fx/home","agentDir":"/Users/r2fx/home/.pi/agent","sessionDir":"/Users/r2fx/home/.pi/agent/sessions/--proj--/sub","pkgRoot":"/Users/r2fx/pkg","owned":[],"noTmp":true}, // 43
  {"platform":"darwin","worktree":"/Users/r2fx/proj","cwd":"/Users/r2fx/proj","home":"/Users/r2fx/home","agentDir":"/Users/r2fx/home/.pi/agent","pkgRoot":"/Users/r2fx/proj","owned":["/Users/r2fx/x/pf-hubwf/hub/.workflow","/Users/r2fx/x/pf-hubwf/hub/.workflow/*"],"noTmp":true}, // 44
  {"platform":"darwin","worktree":"/Users/r2fx/proj","cwd":"/Users/r2fx/proj","home":"/Users/r2fx/home","agentDir":"/Users/r2fx/home/.pi/agent","pkgRoot":"/Users/r2fx/proj","owned":["/Users/r2fx/x/pf-hubwf/nontmp/hub2/.workflow","/Users/r2fx/x/pf-hubwf/nontmp/hub2/.workflow/*"],"noTmp":true}, // 45
  {"platform":"darwin","worktree":"/Users/r2fx/home/code/proj","cwd":"/Users/r2fx/home/code/proj","home":"/Users/r2fx/home","agentDir":"/Users/r2fx/agent","pkgRoot":"/Users/r2fx/pkg","owned":[],"noTmp":true}, // 46
  {"platform":"darwin","worktree":"/Users/r2fx/home/code/proj","cwd":"/Users/r2fx/home/code/proj","home":"/Users/r2fx/home","agentDir":"/Users/r2fx/agent","pkgRoot":"/Users/r2fx/pkg","scratch":"/Users/r2fx/scratch","owned":["/Users/r2fx/home/code/proj","/Users/r2fx/home/code/proj/*","/Users/r2fx/home/repo/.workflow","/Users/r2fx/home/repo/.workflow/*"],"noTmp":true}, // 47
  {"platform":"darwin","worktree":"/Users/r2fx/home/code/proj","cwd":"/Users/r2fx/home/code/proj","home":"/Users/r2fx/home","agentDir":"/Users/r2fx/agent","pkgRoot":"/Users/r2fx/home/code/proj","owned":[],"noTmp":true}, // 48
  {"platform":"darwin","worktree":"/Users/r2fx/proj","cwd":"/Users/r2fx/proj","home":"/Users/r2fx/home","agentDir":"/Users/r2fx/home/.pi/agent","pkgRoot":"/Users/r2fx/pkg","scratch":"/Users/r2fx/tmp/pi-foreman-scratch/child1","scratchBase":"/Users/r2fx/tmp/pi-foreman-scratch","owned":["/Users/r2fx/home/.pi/agent/pi-foreman/handoffs","/Users/r2fx/home/.pi/agent/sessions/*/subagent-artifacts","/Users/r2fx/x/pf-secbound/repo.worktrees","/Users/r2fx/home/.pi/agent/pi-foreman","/Users/r2fx/home/.pi/agent/foreman.json","/Users/r2fx/home/.pi/agent/settings.json"],"noTmp":true}, // 49
  {"platform":"darwin","worktree":"/Users/r2fx/proj","cwd":"/Users/r2fx/proj","home":"/Users/r2fx/home","agentDir":"/Users/r2fx/home/.pi/agent","pkgRoot":"/Users/r2fx/pkg","scratch":"/Users/r2fx/tmp/pi-foreman-scratch/child1","scratchBase":"/Users/r2fx/tmp/pi-foreman-scratch","owned":["/Users/r2fx/home/.pi/agent/pi-foreman/handoffs","/Users/r2fx/home/.pi/agent/sessions/*/subagent-artifacts","/Users/r2fx/x/pf-sectilde/repo.worktrees","/Users/r2fx/home/.pi/agent/pi-foreman","/Users/r2fx/home/.pi/agent/foreman.json","/Users/r2fx/home/.pi/agent/settings.json"],"noTmp":true}, // 50
  {"platform":"linux","worktree":"/Users/r2fx/proj","cwd":"/Users/r2fx/proj","home":"/Users/r2fx/home","agentDir":"/Users/r2fx/home/.pi/agent","pkgRoot":"/Users/r2fx/pkg","scratch":"/Users/r2fx/scratch","owned":[],"noTmp":false}, // 51
  {"platform":"darwin","worktree":"/Users/r2fx/home/code/proj","cwd":"/Users/r2fx/home/code/proj","home":"/Users/r2fx/home","agentDir":"/Users/r2fx/agent","pkgRoot":"/Users/r2fx/pkg","scratchBase":"/Users/r2fx/tmp/pi-foreman-scratch","owned":["/Users/r2fx/agent/pi-foreman/handoffs","/Users/r2fx/agent/sessions/*/subagent-artifacts","/Users/r2fx/home/elsewhere/trees/repo","/Users/r2fx/agent/pi-foreman","/Users/r2fx/agent/foreman.json","/Users/r2fx/agent/settings.json"],"noTmp":true}, // 52
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

test("bashpath-win32", posixOnly, () => {
  run([
    // bashpath-win32.test.ts:37 win32: D=C:/Users/RUNNER~1/.../L1/x; mkdir -p $D (721)
    [0,"bash","D=C:/t/pfs/s1/x; mkdir -p $D","b"],
    [0,"bash","D=C:/t/pfs/s1/x && mkdir -p \"$D\"","b"],
    [0,"bash","mkdir -p C:/t/pfs/s1/x","b"],
    // bashpath-win32.test.ts:48 win32: D=C:/Users/RUNNER~1/.../pi-foreman; cat $D/handoffs/s1/ruling.md is not the unknown
    [0,"bash","cat $D/handoffs/s1/ruling.md","b"],
    [0,"bash","D=C:/Profiles/u/.pi/agent/pi-foreman cat $D/handoffs/s1/ruling.md","b"],
    // bashpath-win32.test.ts:55 win32: D=<scratch>; D=C:/Users/RUNNER~1/.../pi-foreman; cat $D/handoffs/s1/ruling.md (724)
    [0,"bash","D=C:/Profiles/u/.pi/agent/pi-foreman; D=C:/t/pfs/s1; cat $D/handoffs/s1/ruling.md","b"],
    // bashpath-win32.test.ts:67 win32: cd C:/Users/RUNNER~1/.../hf; S=$FOREMAN_SCRATCH; mkdir -p $S; npm test > $S/tc.txt 
    [0,"bash","cd C:/w/proj; S=$FOREMAN_SCRATCH; mkdir -p $S; npm test > $S/tc.txt","m"],
    [0,"bash","S=$FOREMAN_SCRATCH; mkdir -p $S; npm test > \"$S/tc.txt\"","m"],
    // bashpath-win32.test.ts:75 win32: S=$FOREMAN_SCRATCH; python3 - "$S/probe.test.ts" <<EOF is decided like its literal-
    [0,"bash","S=$FOREMAN_SCRATCH; python3 - \"$S/probe.test.ts\" <<EOF\nprint(1)\nEOF","bm"],
    [0,"bash","python3 - \"C:\\t\\pfs\\s1/probe.test.ts\" <<EOF\nprint(1)\nEOF","bm"],
  ]);
});

test("bg", posixOnly, () => {
  run([
    // bg.test.ts:280 guard parity of a background shell tool with the bash call (the foreman_bg rows went with the tool)
    [1,"bash","echo x > src/a.txt","m"],
    [1,"bash"," ","m"],
    [1,"bash","echo hi","m"],
    // bg.test.ts:373 guard parity: the add-on's bg_run gets exactly the verdict a bash call gets; a non-string 
    [1,"bg_run",{"command":"echo x > src/a.txt"},"m"],
    [1,"bg_run",{"command":" "},"m"],
    [1,"bg_run",{"command":"echo hi"},"m"],
    [1,"bg_run",{},"m"],
    [1,"bg_run",{"command":42},"m"],
    [1,"bg_run",{"command":["echo","hi"]},"m"],
  ]);
});

test("child-cd", posixOnly, () => {
  run([
    // child-cd.test.ts:21 child cd: inside the workspace passes, also cumulatively and with pushd/popd
    [2,"bash","cd sub && cargo test","b"],
    [2,"bash","cd \"/Users/r2fx/proj/sub\" && ls","b"],
    [2,"bash","cd sub/deep && cd .. && ls","b"],
    [2,"bash","cd . && ls","b"],
    [2,"bash","pushd sub && popd && ls","b"],
    [2,"bash","ls","b"],
    // child-cd.test.ts:48 child cd: the foreman is not confined by the overlay
    [2,"bash","cd /Users/r2fx/x/pf-cd/elsewhere && ls","m"],
  ]);
});

test("child-install-ask", posixOnly, () => {
  run([
    // child-install-ask.test.ts:23 a child asks for npm ci, npm install and git fetch; the foreman keeps the rows
    [3,"bash","npm ci","m"],
    [3,"bash","npm install","m"],
    [3,"bash","npm i","m"],
    [3,"bash","git fetch origin","m"],
    [3,"bash","git -C . fetch","m"],
    [3,"bash","cd x && npm ci","m"],
    // child-install-ask.test.ts:30 other npm and git commands are untouched for a child
    [3,"bash","npm test","b"],
    [3,"bash","npm run typecheck","b"],
    [3,"bash","git status","b"],
    [3,"bash","git log --oneline","b"],
  ]);
});

test("child-install-env-prefix", posixOnly, () => {
  run([
    // child-install-env-prefix.test.ts:29 a child runs npm ci in its owned worktree root without an ask (decision: pass, no env pref
    [4,"bash","npm ci","b"],
    // child-install-env-prefix.test.ts:70 expected-open (R10): env -i npm ci
    [4,"bash","env -i npm ci","b"],
    // child-install-env-prefix.test.ts:75 expected-open (R10): export npm_config_prefix=<OWNED>/x; npm ci
    [4,"bash","export npm_config_prefix=/Users/r2fx/proj/x; npm ci","b"],
  ]);
});

test("child-install-owned-root-win32", posixOnly, () => {
  run([
    // child-install-owned-root-win32.test.ts:31 win32 child in C:\Users\RUNNER~1\...\ws.worktrees\r1: npm ci --prefix=C:/Users/RUNNER~1/..
    [5,"bash","npm install --prefix C:/w/proj","b"],
    // child-install-owned-root-win32.test.ts:67 win32 child: plain npm ci and npm ci --prefix . in the owned root pass
    [5,"bash","npm ci","b"],
    [5,"bash","npm ci --prefix .","b"],
    // child-install-owned-root-win32.test.ts:72 win32 child: npm ci --prefix=C:/Users/RUNNER~1/.../other asks (foreign prefix, either spel
    [5,"bash","npm ci --prefix=C:/w/proj/sub","b"],
    // child-install-owned-root-win32.test.ts:90 expected-open (R9): win32 child: env -i npm ci in the owned root passes (wrapper options a
    [5,"bash","env -i npm ci","b"],
  ]);
});

test("child-install-owned-root", posixOnly, () => {
  run([
    // child-install-owned-root.test.ts:28 a child runs npm install / npm ci in its owned worktree root without an ask
    [4,"bash","npm install","b"],
    [4,"bash","npm i","b"],
    [4,"bash","npm ci --no-audit --no-fund","b"],
    [4,"bash","npm install --prefix .","b"],
    [4,"bash","npm ci --prefix=/Users/r2fx/proj","b"],
    // child-install-owned-root.test.ts:36 a child still asks in a non-owned cwd or next to git fetch; a subdir of the owned root and
    [4,"bash","cd sub && npm ci","b"],
  ]);
});

test("childtmp", posixOnly, () => {
  run([
    // childtmp.test.ts:44 the child's scratch dir, its workspace, reads from /tmp and /dev/null stay open
    [6,"bash","echo x > /Users/r2fx/scratch/out.txt","b"],
    [6,"bash","echo x > $FOREMAN_SCRATCH/out.txt","b"],
    [6,"bash","cp /tmp/in.txt ./out.txt","b"],
    [6,"bash","cat /tmp/in.txt","b"],
    [6,"bash","echo x > .workflow/scratch/out.txt","b"],
  ]);
});

test("cycle3-safety", posixOnly, () => {
  run([
    // cycle3-safety.test.ts:49 U1: project .claude/, .mcp.json, the bridge config folder and ~/.claude are asked in the f
    [4,"write",{"path":"CLAUDE.md","content":"x"},"bm"],
    // cycle3-safety.test.ts:73 U3: credential files and token-printing commands are denied everywhere
    [4,"bash","gh pr list","bm"],
    // cycle3-safety.test.ts:107 handoff parent/child id files: children denied, foreman asked; result.md and plan.md stay 
    [4,"write",{"path":"/Users/r2fx/home/.pi/agent/pi-foreman/handoffs/20261009-120000-x/result.md","content":"x"},"m"],
    [4,"write",{"path":"/Users/r2fx/home/.pi/agent/pi-foreman/handoffs/20261009-120000-x/plan.md","content":"x"},"m"],
    [4,"bash","echo done > /Users/r2fx/home/.pi/agent/pi-foreman/handoffs/20261009-120000-x/result.md","m"],
    // cycle3-safety.test.ts:120 T14: <rev>:<path> words are checked by their path part
    [4,"bash","git show HEAD:src/a.ts","bm"],
  ]);
});

test("glob-linear", posixOnly, () => {
  run([
    // glob-linear.test.ts:87 overlay expandGlob (write protection, bash words) never compiles the word and stays fast
    [7,"bash","touch *a*a*a*a*a*a*a*a*a*a*b","m"],
    [7,"bash","touch a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*b","m"],
    [7,"bash","touch [A-Za-z_","m"],
  ]);
});

test("handoff-child-overlay", posixOnly, () => {
  run([
    // handoff-child-overlay.test.ts:24 child with handoffDir: allow-list names pass the childBlock, parent-owned names stay block
    [8,"write",{"path":"/Users/r2fx/agent/pi-foreman/handoffs/s1/plan.md","content":"x"},"b"],
    [8,"write",{"path":"/Users/r2fx/agent/pi-foreman/handoffs/s1/result.md","content":"x"},"b"],
    [8,"write",{"path":"/Users/r2fx/agent/pi-foreman/handoffs/s1/ask.md","content":"x"},"b"],
    [8,"write",{"path":"/Users/r2fx/agent/pi-foreman/handoffs/s1/ask-2.md","content":"x"},"b"],
    [8,"write",{"path":"/Users/r2fx/agent/pi-foreman/handoffs/s1/.steer-last-read.json","content":"x"},"b"],
    [8,"write",{"path":"/Users/r2fx/agent/pi-foreman/handoffs/s1/work/a/b.txt","content":"x"},"b"],
  ]);
  // #226 removed .ask and .seen from HANDOFF_CHILD_NAMES: a child's write to them is a block now
  for (const n of [".ask", ".seen"]) {
    const r = decide(CTX[8]!, "b", "write", { path: `/Users/r2fx/agent/pi-foreman/handoffs/s1/${n}`, content: "x" });
    assert.equal(label(r), "block:child-write-outside", n);
  }
});

test("handoff-parent-read", posixOnly, () => {
  run([
    // handoff-parent-read.test.ts:28 own handoff dir: the foreman reads parent and child; writes still ask
    [3,"bash","cat /Users/r2fx/home/.pi/agent/pi-foreman/handoffs/s1/parent","m"],
    [3,"read",{"path":"/Users/r2fx/home/.pi/agent/pi-foreman/handoffs/s1/parent"},"m"],
    [3,"bash","cat /Users/r2fx/home/.pi/agent/pi-foreman/handoffs/s1/child","m"],
    [3,"read",{"path":"/Users/r2fx/home/.pi/agent/pi-foreman/handoffs/s1/child"},"m"],
    // handoff-parent-read.test.ts:37 handoff dirs stay closed to a child (the overlay knows no 'own' dir for a child; plan.md/r
    [3,"bash","cat /Users/r2fx/home/.pi/agent/pi-foreman/handoffs/s1/plan.md","b"],
  ]);
});

test("lane2-apply", posixOnly, () => {
  run([
    // lane2-apply.test.ts:88 2e: git apply of a patch under the main scratch or the own scratch inside an owned worktre
    [9,"bash","git apply /Users/r2fx/home/repo/.workflow/scratch/x.patch","b"],
    [9,"bash","git apply /Users/r2fx/tmp/pi-foreman-scratch/child1/x.patch","b"],
    [9,"bash","git apply -p1 /Users/r2fx/tmp/pi-foreman-scratch/child1/x.patch","b"],
    [9,"bash","patch -p1 < /Users/r2fx/home/repo/.workflow/scratch/x.patch","b"],
    [9,"bash","patch -p1 < /Users/r2fx/tmp/pi-foreman-scratch/child1/x.patch","b"],
    [9,"bash","patch -p1 -i /Users/r2fx/tmp/pi-foreman-scratch/child1/x.patch","b"],
    [9,"bash","git apply --check /Users/r2fx/tmp/pi-foreman-scratch/child1/x.patch","b"],
    // lane2-apply.test.ts:98 2e: the same apply inside a non-owned worktree, or with a non-owned target, still asks or 
    [9,"bash","touch f.txt","b"],
  ]);
});

test("lane2-isolation", posixOnly, () => {
  run([
    // lane2-isolation.test.ts:86 2-I: a builder's git add / commit inside its own nested isolation worktree is allowed
    [10,"bash","git add f.txt","b"],
    [10,"bash","git commit -m x","b"],
    [10,"bash","git add f.txt && git commit -m x","b"],
    [10,"bash","git -C /Users/r2fx/home/code/proj commit -m x","b"],
    [10,"bash","touch /Users/r2fx/home/code/proj/new.txt","b"],
    [10,"bash","echo x > new.txt","b"],
    // lane2-isolation.test.ts:102 2-I: a nested isolation worktree below the round worktree is its child's own root, whateve
    [10,"bash","touch new.txt","b"],
  ]);
});

test("lane2-paths", posixOnly, () => {
  run([
    // lane2-paths.test.ts:56 2b: a catch-all path rule never fires on a word of command prose
    [11,"bash","git commit --reason \"read index.ts, then fix it\"","m"],
    [12,"bash","git log --reason \"read index.ts, then fix it\"","r"],
    // lane2-paths.test.ts:79 2b: reads under owned roots are never denied by a `*` path rule
    [13,"bash","cat /Users/r2fx/tmp/pi-foreman-scratch/child1/x.txt","r"],
    [13,"bash","cat /Users/r2fx/home/code/proj/package.json","r"],
    [13,"bash","cat /Users/r2fx/home/repo/.workflow/LEDGER-round.md","br"],
    [13,"bash","cat /Users/r2fx/agent/pi-foreman/handoffs/s1/brief.md","br"],
    // lane2-paths.test.ts:90 2b: a sed expression is no path; a real write to .git/config is still denied
    [11,"bash","env | grep ^GIT_CONFIG | sed 's/=.*//'","m"],
    [13,"bash","env | grep ^GIT_CONFIG | sed 's/=.*//'","r"],
    // lane2-paths.test.ts:99 2b: `sed -n 1,5p package.json` is a read, not a write
    [13,"bash","sed -n 1,5p package.json","r"],
    [11,"bash","sed -n 1,5p package.json","m"],
    // lane2-paths.test.ts:105 2b: a reviewer in the main checkout reads its own round worktree through ../<repo>.worktre
    [14,"bash","cat ../repo.worktrees/round/extensions/git-guard/index.ts","b"],
    [14,"bash","cat /Users/r2fx/home/code/proj.worktrees/round/package.json","b"],
    // lane2-paths.test.ts:115 2c: `../x` after cd resolves from the cd'd directory
    [13,"bash","cd extensions/core-adapter && cat ../git-guard/index.ts","r"],
    [13,"bash","cd extensions/core-adapter; cat ../git-guard/index.ts","r"],
    [11,"bash","cd extensions/core-adapter && cat ../git-guard/index.ts","m"],
    // lane2-paths.test.ts:126 2d: only reads of the state dir lose the protected-configuration ask
    [15,"bash","ls /Users/r2fx/agent/pi-foreman/state/usage","m"],
    [15,"bash","cat /Users/r2fx/agent/pi-foreman/state/usage/a.jsonl","m"],
    [15,"bash","cd /Users/r2fx/agent/pi-foreman/state/usage && ls","m"],
    [15,"bash","cd /Users/r2fx/agent/pi-foreman/state/usage && cat *.jsonl","m"],
    [15,"bash","cat /Users/r2fx/agent/pi-foreman/state/usage/*.jsonl | head -3","m"],
    [15,"bash","ls /Users/r2fx/agent/pi-foreman/state","m"],
    [15,"bash","head -5 /Users/r2fx/agent/pi-foreman/state/usage/a.jsonl | sed -n 1,2p","m"],
    // lane2-paths.test.ts:152 2f: the round ledger and the session's handoff dir are readable for a child; writes stay c
    [13,"bash","cat /Users/r2fx/home/repo/.workflow/LEDGER-other.md","br"],
    [13,"bash","ls /Users/r2fx/agent/pi-foreman/handoffs/s1","br"],
  ]);
});

test("lane2-prose-failclosed", posixOnly, () => {
  run([
    // lane2-prose-failclosed.test.ts:32 prose passes only as a known prose option value by position, a pure read's operand is deni
    [15,"bash","git commit -m \"read index.ts, then x\"","m"],
    [15,"bash","git log --reason \"read index.ts, then fix it\"","m"],
  ]);
});

test("lane2-prose-position", posixOnly, () => {
  run([
    // lane2-prose-position.test.ts:33 a pure bash read of a quoted space path is denied; a commit message is not an operand
    [15,"bash","git commit -m \"/Users/r2fx/home/x/a b/f\"","m"],
    [15,"bash","git commit --message=\"/Users/r2fx/home/x/a b/f\"","m"],
  ]);
});

test("overlay-hardening", posixOnly, () => {
  run([
    // overlay-hardening.test.ts:42 S1/S2: .git is write-protected in every session, git commands and .gitignore/.github pass
    [4,"bash","git status","m"],
    [4,"bash","git diff --stat","bm"],
    [4,"bash","git add .gitignore","bm"],
    [4,"bash","cat .gitignore","bm"],
    [4,"bash","ls .github","bm"],
    [4,"write",{"path":".gitignore","content":"y"},"bm"],
    // overlay-hardening.test.ts:61 protect matches path arguments only: patterns, scripts and echo text are not paths (item 4
    [4,"bash","cd /Users/r2fx/proj && grep -rn \"broadcastServerUpdate\\|func (h \\*\\|clientsMu\\|register\\b\" internal/api/*.go | grep -v _test | head -50","bm"],
    [4,"bash","grep -n \"LogCleanup\\b\\|Transport \\*\\|ExchangeStatus struct\" internal/db/exchange_status.go","bm"],
    [4,"bash","grep -rn '.git/config' internal","bm"],
    [4,"bash","rg -e .git/HEAD internal","bm"],
    [4,"bash","sed -n '/.git\\//p' internal/api/hub.go","bm"],
    [4,"bash","find . -name .git -prune -o -name '*.go' -print","bm"],
    [4,"bash","echo .git/hooks","bm"],
    [4,"bash","cat */hub.go","bm"],
    // overlay-hardening.test.ts:95 S3/S6/S17/S27: agent and harness configuration is asked in the foreman, denied in children
    [4,"write",{"path":"/Users/r2fx/x/pf-harden/other/.pi/agents/builder.md","content":"x"},"m"],
    [4,"bash","python3 /Users/r2fx/pkg/scripts/x.py","m"],
    [4,"read",{"path":".pi/foreman.json"},"bm"],
    [4,"write",{"path":"src/a.ts","content":"x"},"bm"],
    // overlay-hardening.test.ts:115 foreman_move/foreman_copy paths go through the deny paths and the write protection
    [4,"foreman_copy",{"src":"a","dst":"b"},"bm"],
    // overlay-hardening.test.ts:126 S10-S13, S15: glob segments, ANSI-C, braces, case, inline code, grep/find inputs
    [4,"bash","python3 -c 'print(1+1)'","bm"],
    [4,"find",{"pattern":"*.ts"},"bm"],
    // overlay-hardening.test.ts:193 win32: native and MSYS paths in bash commands, case and separators folded
    [16,"bash","git status","m"],
  ]);
});

test("own-bg-tasks-readable", posixOnly, () => {
  run([
    // own-bg-tasks-readable.test.ts:29 the session's own bg_run task dir is readable by bash and the read tool, for the session a
    [17,"bash","cat .pi/tasks/sess-own-4321/t1.output","bm"],
    [17,"bash","tail -n 20 .pi/tasks/sess-own-4321/t1.output","bm"],
    [17,"bash","grep -n error .pi/tasks/sess-own-4321/t1.output","bm"],
    [17,"read",{"path":"/Users/r2fx/proj/.pi/tasks/sess-own-4321/t1.output"},"bm"],
  ]);
});

test("permoverlay-grep", posixOnly, () => {
  run([
    // permoverlay-grep.test.ts:27 literal 97/31: the regex of grep -nE is no path operand, in the main and the child role
    [4,"bash","grep -nE \"/Users/r2fx/home/\\.ssh/id_[a-z]+\" notes.txt","bm"],
    [4,"bash","grep -nE \"/Users/[a-z]+/\\.ssh/id_\" notes.txt","bm"],
    [4,"bash","grep -n -e \"/Users/r2fx/home/.ssh/id_rsa\" -e \"x\" notes.txt","bm"],
    [4,"bash","egrep \"/Users/r2fx/home/.ssh/.*\" notes.txt | head","bm"],
    // permoverlay-grep.test.ts:38 git grep: the pattern (bare, -e, -nE, before --) is no path operand
    [4,"bash","git grep -nE \"/Users/[a-z]+/x\" -- src","bm"],
    // permoverlay-grep.test.ts:48 rg -nE: the regex is no path operand; a directory operand still is
    [4,"bash","rg -nE \"/Users/r2fx/home/\\.ssh/id_[a-z]+\" src","bm"],
  ]);
});

test("permoverlay-ps-function-drive", posixOnly, () => {
  run([
    // permoverlay-ps-function-drive.test.ts:40 ps function drive baseline: the unbound uses are trusted
    [18,"powershell",{"command":"Get-Content $env:HOME/.pi/agent/pi-foreman/x"},"m"],
    [19,"powershell",{"command":"Set-Content $env:FOREMAN_SCRATCH/f y"},"b"],
    // permoverlay-ps-function-drive.test.ts:85 line
    [18,"powershell",{"command":"Get-ChildItem; Get-Content $env:HOME/.pi/agent/pi-foreman/x"},"m"],
  ]);
});

test("permoverlay-r41-win32", posixOnly, () => {
  run([
    // permoverlay-r41-win32.test.ts:13 r41 win32: a drive-resolved candidate hits a drive-less floored folder and a drive-less an
    [5,"bash","rm -rf C:/w/proj/x","m"],
  ]);
});

test("permoverlay-r41", posixOnly, () => {
  run([
    // permoverlay-r41.test.ts:46 r41: a scan of /, the home directory or a parent of the workspace is denied, naming the al
    [20,"grep",{"pattern":"x"},"m"],
    // permoverlay-r41.test.ts:67 r41: a scan of an allowed root is not a scan deny
    [20,"bash","find /Users/r2fx/home/code/proj -name x","m"],
    [20,"bash","find /Users/r2fx/home/code/proj/src -name x","m"],
    [20,"bash","find /tmp -name x","m"],
    [20,"bash","find /tmp/x -name x","m"],
    [20,"bash","find /Users/r2fx/pkg -name x","m"],
    [20,"bash","find . -name x","m"],
    [20,"bash","grep -r foo /Users/r2fx/home/code/proj","m"],
    [20,"bash","grep -r foo /Users/r2fx/home/code/proj/src","m"],
    [20,"bash","grep -r foo /tmp","m"],
    [20,"bash","grep -r foo /tmp/x","m"],
    [20,"bash","grep -r foo /Users/r2fx/pkg","m"],
    [20,"bash","grep -r foo .","m"],
    [20,"bash","grep -Rn foo /Users/r2fx/home/code/proj","m"],
    [20,"bash","grep -Rn foo /Users/r2fx/home/code/proj/src","m"],
    [20,"bash","grep -Rn foo /tmp","m"],
    [20,"bash","grep -Rn foo /tmp/x","m"],
    [20,"bash","grep -Rn foo /Users/r2fx/pkg","m"],
    [20,"bash","grep -Rn foo .","m"],
    [20,"bash","egrep -r foo /Users/r2fx/home/code/proj","m"],
    [20,"bash","egrep -r foo /Users/r2fx/home/code/proj/src","m"],
    [20,"bash","egrep -r foo /tmp","m"],
    [20,"bash","egrep -r foo /tmp/x","m"],
    [20,"bash","egrep -r foo /Users/r2fx/pkg","m"],
    [20,"bash","egrep -r foo .","m"],
    [20,"bash","rg foo /Users/r2fx/home/code/proj","m"],
    [20,"bash","rg foo /Users/r2fx/home/code/proj/src","m"],
    [20,"bash","rg foo /tmp","m"],
    [20,"bash","rg foo /tmp/x","m"],
    [20,"bash","rg foo /Users/r2fx/pkg","m"],
    [20,"bash","rg foo .","m"],
    [20,"bash","fd . /Users/r2fx/home/code/proj","m"],
    [20,"bash","fd . /Users/r2fx/home/code/proj/src","m"],
    [20,"bash","fd . /tmp","m"],
    [20,"bash","fd . /tmp/x","m"],
    [20,"bash","fd . /Users/r2fx/pkg","m"],
    [20,"bash","fd . .","m"],
    [20,"bash","du -sh /Users/r2fx/home/code/proj","m"],
    [20,"bash","du -sh /Users/r2fx/home/code/proj/src","m"],
    [20,"bash","du -sh /tmp","m"],
    [20,"bash","du -sh /tmp/x","m"],
    [20,"bash","du -sh /Users/r2fx/pkg","m"],
    [20,"bash","du -sh .","m"],
    [20,"bash","ls -R /Users/r2fx/home/code/proj","m"],
    [20,"bash","ls -R /Users/r2fx/home/code/proj/src","m"],
    [20,"bash","ls -R /tmp","m"],
    [20,"bash","ls -R /tmp/x","m"],
    [20,"bash","ls -R /Users/r2fx/pkg","m"],
    [20,"bash","ls -R .","m"],
    [20,"bash","tree -L 2 /Users/r2fx/home/code/proj","m"],
    [20,"bash","tree -L 2 /Users/r2fx/home/code/proj/src","m"],
    [20,"bash","tree -L 2 /tmp","m"],
    [20,"bash","tree -L 2 /tmp/x","m"],
    [20,"bash","tree -L 2 /Users/r2fx/pkg","m"],
    [20,"bash","tree -L 2 .","m"],
    [20,"bash","grep foo /","m"],
    [20,"bash","ls /","m"],
    [20,"find",{"path":"/Users/r2fx/home/code/proj","pattern":"*.ts"},"m"],
    // permoverlay-r41.test.ts:178 r41 review: the same writers aimed at ordinary files are no floor deny
    [20,"bash","curl -o /Users/r2fx/home/code/proj/out.txt https://x","m"],
    [20,"bash","wget -O /Users/r2fx/home/code/proj/o.html https://x","m"],
    [20,"bash","cp /Users/r2fx/home/code/proj/a /Users/r2fx/home/code/proj/b","m"],
    [20,"bash","dd if=/Users/r2fx/home/code/proj/a of=/Users/r2fx/home/code/proj/b","m"],
    [20,"bash","tar -xf /Users/r2fx/home/code/proj/a.tar -C /Users/r2fx/home/code/proj/d","m"],
    [20,"bash","unzip /Users/r2fx/home/code/proj/a.zip -d /Users/r2fx/home/code/proj/d","m"],
    [20,"bash","git clone https://x/r.git /Users/r2fx/home/code/proj/r","m"],
    [20,"bash","python3 -c \"print(1)\"","m"],
    [20,"bash","cp /Users/r2fx/agent/pi-foreman/managed.json /Users/r2fx/home/code/proj/copy.json","m"],
    [20,"bash","curl https://x","m"],
    // permoverlay-r41.test.ts:184 r41: a read of a floored file is no floor deny
    [20,"bash","cat /Users/r2fx/agent/pi-foreman/permissions.json","m"],
    [20,"bash","cat /Users/r2fx/home/code/proj/.workflow/permissions.json","m"],
    [20,"bash","cat /Users/r2fx/home/code/proj/.pi/permissions.json","m"],
    [20,"bash","cat /Users/r2fx/agent/pi-foreman/managed.json","bm"],
    [20,"bash","cat /Users/r2fx/agent/pi-foreman/state/round-parents.json","m"],
    [20,"bash","cat /Users/r2fx/agent/pi-foreman/state/bridge-trust.json","m"],
    [20,"bash","cat /Users/r2fx/agent/pi-foreman/state/approvals/a1.json","m"],
    [20,"bash","cat /Users/r2fx/agent/pi-foreman/state/approvals/sub/deep.json","m"],
    [20,"bash","cat /Users/r2fx/agent/pi-foreman/state/gate/g1.json","m"],
    [20,"read",{"path":"/Users/r2fx/agent/pi-foreman/permissions.json"},"m"],
    // permoverlay-r41.test.ts:240 r41 rev2: the same writers into an ordinary folder, and reads of floored paths, are no flo
    [20,"bash","tar -xf a.tar -C /Users/r2fx/home/code/proj/d","bm"],
    [20,"bash","unzip a.zip -d /Users/r2fx/home/code/proj/d","bm"],
    [20,"bash","cp d/* /Users/r2fx/home/code/proj/d/","bm"],
    [20,"bash","cp -r d/. /Users/r2fx/home/code/proj/d","bm"],
    [20,"bash","rsync -a d/ /Users/r2fx/home/code/proj/d/","bm"],
    [20,"bash","mv d/* /Users/r2fx/home/code/proj/d/","bm"],
    [20,"bash","install -t /Users/r2fx/home/code/proj/d a b","bm"],
    [20,"bash","git checkout main","bm"],
    [20,"bash","ls /Users/r2fx/agent/pi-foreman","bm"],
    [20,"bash","cp /Users/r2fx/agent/pi-foreman/managed.json /tmp/x","m"],
    [20,"bash","rsync -a /Users/r2fx/agent/pi-foreman/ /tmp/x/","m"],
    // permoverlay-r41.test.ts:259 r41 rev2: a line parseShell cannot parse still floors when it names a floored path
    [20,"bash","curl -o /Users/r2fx/home/code/proj/out.txt https://x \"u","bm"],
    // permoverlay-r41.test.ts:267 r41: an allowed write inside the worktree is unchanged
    [20,"write",{"path":"/Users/r2fx/home/code/proj/src/a.ts","content":"x"},"m"],
    [20,"edit",{"path":"/Users/r2fx/home/code/proj/src/a.ts","newText":"gate permissions policy"},"m"],
    [20,"write",{"path":"/Users/r2fx/home/code/proj/foreman.json","content":"{\"trace\":1}"},"m"],
    [20,"bash","echo x > /Users/r2fx/home/code/proj/out.txt","m"],
    [20,"bash","sed -i s/a/b/ /Users/r2fx/home/code/proj/src/a.ts","m"],
    [20,"bash","mv /Users/r2fx/home/code/proj/a /Users/r2fx/home/code/proj/b","m"],
    [20,"bash","echo x | tee /Users/r2fx/home/code/proj/t.txt","m"],
    // permoverlay-r41.test.ts:332 r41 rev3: an unknown program is a floor deny only when it names a floored path
    [20,"bash","frobnicate /tmp/x","bm"],
    [20,"bash","frobnicate /Users/r2fx/home/code/proj/x","bm"],
    [20,"bash","rm -rf /Users/r2fx/home/code/proj/x","bm"],
    [20,"bash","mv /Users/r2fx/home/code/proj/a /tmp/x","m"],
    // permoverlay-r41.test.ts:342 r41 rev3: plain reads, copies out and git status of floored paths are no floor deny
    [20,"bash","ls -la /Users/r2fx/agent/pi-foreman/state","m"],
    [20,"bash","head -3 /Users/r2fx/agent/pi-foreman/permissions.json","bm"],
    [20,"bash","grep x /Users/r2fx/agent/pi-foreman/state/gate/log.jsonl","m"],
    [20,"bash","stat /Users/r2fx/agent/pi-foreman/managed.json","bm"],
    [20,"bash","wc -l /Users/r2fx/agent/pi-foreman/managed.json","bm"],
    [20,"bash","diff /Users/r2fx/agent/pi-foreman/managed.json /tmp/x","bm"],
    [20,"bash","du -sh /Users/r2fx/agent/pi-foreman","bm"],
    [20,"bash","test -e /Users/r2fx/agent/pi-foreman/managed.json","bm"],
    [20,"bash","find /Users/r2fx/agent/pi-foreman -name x","bm"],
    [20,"bash","find /Users/r2fx/agent/pi-foreman -name x -print","bm"],
    [20,"bash","cp -r /Users/r2fx/agent/pi-foreman /tmp/x","m"],
    [20,"bash","git -C /Users/r2fx/home/code/proj status","bm"],
    [20,"bash","git -C /Users/r2fx/agent/pi-foreman status","bm"],
    [20,"bash","git diff","bm"],
    [20,"bash","cd /Users/r2fx/agent/pi-foreman && ls","m"],
    [20,"bash","cd /Users/r2fx/agent/pi-foreman && cat managed.json","m"],
    [20,"bash","cat /Users/r2fx/agent/pi-foreman/managed.json < /Users/r2fx/agent/pi-foreman/permissions.json","bm"],
    [20,"bash","grep -rn x /Users/r2fx/home/code/proj/src","bm"],
    // permoverlay-r41.test.ts:377 r41 rev3: a path tool that moves or removes a floored folder is a floor deny
    [20,"foreman_copy",{"src":"/Users/r2fx/agent/pi-foreman/managed.json","dst":"/Users/r2fx/home/code/proj/x"},"m"],
    // permoverlay-r41.test.ts:388 r41 narrowing 1: the folder of a workspace policy file is no floor deny, the file still is
    [20,"bash","git add config/foreman.schema.json","bm"],
    [21,"bash","git add foreman.schema.json","bm"],
    [21,"bash","ls","m"],
    [20,"bash","rm -rf .workflow/scratch/x","bm"],
    [20,"bash","rm -rf .*","bm"],
    [20,"bash","frobnicate /Users/r2fx/home/code/proj/.workflow","bm"],
    [20,"bash","frobnicate .workflow","bm"],
    // permoverlay-r41.test.ts:441 r41 rev4 gap 1: lines of plain reads naming a floored word stay allowed
    [20,"bash","echo /Users/r2fx/agent/pi-foreman","bm"],
    [20,"bash","echo /Users/r2fx/agent/pi-foreman | cat","bm"],
    [20,"bash","cat /Users/r2fx/agent/pi-foreman/managed.json | grep x","bm"],
    [20,"bash","X=/Users/r2fx/agent/pi-foreman; ls $X","bm"],
    [20,"bash","printf %s /Users/r2fx/agent/pi-foreman/managed.json","bm"],
    // permoverlay-r41.test.ts:473 r41 rev4 gap 2: an ancestor as a read operand, a cwd or a plain destination is no floor de
    [23,"bash","cd ~","m"],
    [23,"bash","ls ~","bm"],
    [23,"bash","cp x ~/foo","bm"],
    [23,"bash","cp -r ~ /tmp/x","bm"],
    [23,"bash","rsync -a ~/ /tmp/x/","bm"],
    [23,"bash","ls /Users/r2fx/home","bm"],
    // permoverlay-r41.test.ts:478 r41 rev4 gap 3: inline interpreter text and ANSI-C quoting naming a floored path are a flo
    [20,"bash","node -e \"console.log(1)\"","bm"],
    [20,"bash","python3 -c \"print('/Users/r2fx/agent/settings.json')\"","b"],
  ]);
});

test("permoverlay-vars-bind-r8", posixOnly, () => {
  run([
    // permoverlay-vars-bind-r8.test.ts:38 r8 baseline: the unbound uses are trusted
    [18,"bash","cat $HOME/.pi/agent/pi-foreman/x","m"],
    [19,"bash","echo y > $S/f","b"],
    // permoverlay-vars-bind-r8.test.ts:104 line
    [18,"bash","declare -i n; n=5; cat $HOME/f","m"],
    [18,"bash","cat $HOME/f","m"],
    [18,"bash","declare -i n; n=5; cat $HOME/.pi/agent/pi-foreman/x","m"],
    [18,"bash","echo ${a:2}; cat $HOME/f","m"],
    [18,"bash","echo ${a:2}; cat $HOME/.pi/agent/pi-foreman/x","m"],
    [18,"bash","echo ${a:2:3}; cat $HOME/f","m"],
    [18,"bash","echo ${a:2:3}; cat $HOME/.pi/agent/pi-foreman/x","m"],
    [18,"bash","echo ${a: -1}; cat $HOME/f","m"],
    [18,"bash","echo ${a: -1}; cat $HOME/.pi/agent/pi-foreman/x","m"],
    [18,"bash","echo ${a:-x}; cat $HOME/f","m"],
    [18,"bash","echo ${a:-x}; cat $HOME/.pi/agent/pi-foreman/x","m"],
    [18,"bash","echo ${a:=x}; cat $HOME/f","m"],
    [18,"bash","echo ${a:=x}; cat $HOME/.pi/agent/pi-foreman/x","m"],
    [18,"bash","echo ${a:+x}; cat $HOME/f","m"],
    [18,"bash","echo ${a:+x}; cat $HOME/.pi/agent/pi-foreman/x","m"],
    [18,"bash","echo ${a:?x}; cat $HOME/f","m"],
    [18,"bash","echo ${a:?x}; cat $HOME/.pi/agent/pi-foreman/x","m"],
    [18,"bash","HOMEDIR=/x; cat $HOME/f","m"],
    [18,"bash","HOMEDIR=/x; cat $HOME/.pi/agent/pi-foreman/x","m"],
    [18,"bash","echo $HOME_OLD; cat $HOME/f","m"],
    [18,"bash","echo $HOME_OLD; cat $HOME/.pi/agent/pi-foreman/x","m"],
    // permoverlay-vars-bind-r8.test.ts:139 line
    [18,"bash","n=5; echo $(( $n + 1 )); cat $HOME/.pi/agent/pi-foreman/x","m"],
    [18,"bash","echo $(( $n + 1 )); cat $HOME/.pi/agent/pi-foreman/x","m"],
    [18,"bash","(( 1 + 2 )); cat $HOME/.pi/agent/pi-foreman/x","m"],
    // permoverlay-vars-bind-r8.test.ts:150 r8 baseline: the unbound PowerShell uses are trusted
    [18,"powershell",{"command":"Get-Content $env:USERPROFILE/.pi/agent/pi-foreman/x"},"m"],
    [18,"powershell",{"command":"Get-Content $HOME/.pi/agent/pi-foreman/x"},"m"],
    // permoverlay-vars-bind-r8.test.ts:224 `Set-Item -Path:env:FOO /x; ${PS_USE}`
    [18,"powershell",{"command":"Set-Item -Path:env:FOO /x; Get-Content $env:HOME/.pi/agent/pi-foreman/x"},"m"],
    // permoverlay-vars-bind-r8.test.ts:239 line
    [18,"powershell",{"command":"Set-Item -Path:'env:FOO' -Value:/x; Get-Content $env:HOME/.pi/agent/pi-foreman/x"},"m"],
    [18,"powershell",{"command":"Set-Variable -Name:FOO -Value /x; Get-Content $env:HOME/.pi/agent/pi-foreman/x"},"m"],
    [18,"powershell",{"command":"$HOMEDIR = 1; Get-Content $env:HOME/.pi/agent/pi-foreman/x"},"m"],
    [18,"powershell",{"command":"Get-Item -Path:$p; Get-Content $env:HOME/.pi/agent/pi-foreman/x"},"m"],
    [18,"powershell",{"command":"Get-Item -Path:env:FOO; Get-Content $env:HOME/.pi/agent/pi-foreman/x"},"m"],
    // permoverlay-vars-bind-r8.test.ts:277 line
    [18,"bash","echo ${#x}; cat $HOME/.pi/agent/pi-foreman/x","m"],
    [18,"bash","echo ${!x}; cat $HOME/.pi/agent/pi-foreman/x","m"],
    [18,"bash","echo ${x:-y}; cat $HOME/.pi/agent/pi-foreman/x","m"],
    [18,"bash","echo ${#:-0}; cat $HOME/.pi/agent/pi-foreman/x","m"],
    [18,"bash","echo ${?:-0}; cat $HOME/.pi/agent/pi-foreman/x","m"],
    [18,"bash","echo ${$:2}; cat $HOME/.pi/agent/pi-foreman/x","m"],
    [18,"bash","declare -i n; n=\"5\"; cat $HOME/.pi/agent/pi-foreman/x","m"],
    // permoverlay-vars-bind-r8.test.ts:386 line
    [18,"powershell",{"command":"Set-Item -Path:env:FOO, env:BAR -Value /x; Get-Content $env:HOME/.pi/agent/pi-foreman/x"},"m"],
    [18,"powershell",{"command":"Set-Item -Path env:FOO -Value $v; Get-Content $env:HOME/.pi/agent/pi-foreman/x"},"m"],
    [18,"powershell",{"command":"Set-Item env:FOO $v; Get-Content $env:HOME/.pi/agent/pi-foreman/x"},"m"],
    [18,"powershell",{"command":"Set-Item -Value $v -Path env:FOO; Get-Content $env:HOME/.pi/agent/pi-foreman/x"},"m"],
    [18,"powershell",{"command":"Get-Content f | Out-Null; Get-Content $env:HOME/.pi/agent/pi-foreman/x"},"m"],
    [18,"powershell",{"command":"gc f | Set-Item -Path env:FOO; Get-Content $env:HOME/.pi/agent/pi-foreman/x"},"m"],
    [18,"powershell",{"command":"Rename-Item env:X -NewName FOO; Get-Content $env:HOME/.pi/agent/pi-foreman/x"},"m"],
    [18,"powershell",{"command":"Copy-Item ./a ./b; Get-Content $env:HOME/.pi/agent/pi-foreman/x"},"m"],
    [18,"powershell",{"command":"Microsoft.PowerShell.Management\\Set-Item -Path env:FOO -Value /x; Get-Content $env:HOME/.pi/agent/pi-foreman/x"},"m"],
    // permoverlay-vars-bind-r8.test.ts:446 line
    [18,"bash","OPTIND=1; cat $HOME/.pi/agent/pi-foreman/x","m"],
    [18,"bash","[[ $n -eq 1 ]]; cat $HOME/.pi/agent/pi-foreman/x","m"],
    [18,"bash","[[ a[0] -eq 1 ]]; cat $HOME/.pi/agent/pi-foreman/x","m"],
    [18,"bash","declare -i n; : ${n:=5}; cat $HOME/.pi/agent/pi-foreman/x","m"],
    [18,"bash","a=([0]=1 [1]=2); cat $HOME/.pi/agent/pi-foreman/x","m"],
    [18,"bash","shift $((OPTIND-1)); cat $HOME/.pi/agent/pi-foreman/x","m"],
    [18,"bash","echo $RANDOM $SECONDS; cat $HOME/.pi/agent/pi-foreman/x","m"],
    // permoverlay-vars-bind-r8.test.ts:571 line
    [18,"powershell",{"command":"Remove-Item -LiteralPath env:FOO; Get-Content $env:HOME/.pi/agent/pi-foreman/x"},"m"],
    [18,"powershell",{"command":"Remove-Item -LiteralPath env:FOO*; Get-Content $env:HOME/.pi/agent/pi-foreman/x"},"m"],
    [18,"powershell",{"command":"$null = Remove-Item -LiteralPath env:FOO; Get-Content $env:HOME/.pi/agent/pi-foreman/x"},"m"],
    [18,"powershell",{"command":"Get-Content f -OutVariable foo; Get-Content $env:HOME/.pi/agent/pi-foreman/x"},"m"],
    [18,"powershell",{"command":"Get-Content f -ov +foo; Get-Content $env:HOME/.pi/agent/pi-foreman/x"},"m"],
    [18,"powershell",{"command":"gc f | Tee-Object -Variable foo; Get-Content $env:HOME/.pi/agent/pi-foreman/x"},"m"],
    [18,"powershell",{"command":"$null = Copy-Item ./a ./b; Get-Content $env:HOME/.pi/agent/pi-foreman/x"},"m"],
    [18,"powershell",{"command":"gc f | New-Item -Path ./d -Name x; Get-Content $env:HOME/.pi/agent/pi-foreman/x"},"m"],
    [18,"powershell",{"command":"Get-ChildItem -Include *.txt; Get-Content $env:HOME/.pi/agent/pi-foreman/x"},"m"],
    // permoverlay-vars-bind-r8.test.ts:579 line
    [18,"powershell",{"command":"Set-Item -- env:FOO /x; Get-Content $env:HOME/.pi/agent/pi-foreman/x"},"m"],
    [18,"powershell",{"command":"Set-Variable -- FOO /x; Get-Content $env:HOME/.pi/agent/pi-foreman/x"},"m"],
    // permoverlay-vars-bind-r8.test.ts:634 line
    [18,"powershell",{"command":"Write-Output 1 -p foo; Get-Content $HOME/.pi/agent/pi-foreman/x"},"m"],
    [18,"powershell",{"command":"iwr u -SessionVariable s1; Get-Content $HOME/.pi/agent/pi-foreman/x"},"m"],
    [18,"powershell",{"command":"Clear-Content ./a.txt; Get-Content $env:HOME/.pi/agent/pi-foreman/x"},"m"],
    [18,"powershell",{"command":"(Get-Variable foo).Value = 1; Get-Content $HOME/.pi/agent/pi-foreman/x"},"m"],
    // permoverlay-vars-bind-r8.test.ts:688 line
    [18,"powershell",{"command":"Get-Process -Name foo; Get-Content $HOME/.pi/agent/pi-foreman/x"},"m"],
    [18,"powershell",{"command":"Get-Variable foo; Get-Content $HOME/.pi/agent/pi-foreman/x"},"m"],
    [18,"powershell",{"command":"gv foo | % { $_.Value }; Get-Content $HOME/.pi/agent/pi-foreman/x"},"m"],
    [18,"powershell",{"command":"Get-Alias ls; Get-Content $env:HOME/.pi/agent/pi-foreman/x"},"m"],
    [18,"powershell",{"command":"Get-Process –Name foo; Get-Content $HOME/.pi/agent/pi-foreman/x"},"m"],
    [18,"powershell",{"command":"(Get-Variable -Name foo).Value = 1; Get-Content $HOME/.pi/agent/pi-foreman/x"},"m"],
  ]);
});

test("permoverlay-vars-bind", posixOnly, () => {
  run([
    // permoverlay-vars-bind.test.ts:39 baseline: the unbound uses are trusted
    [19,"bash","echo x > $S/f","b"],
    // permoverlay-vars-bind.test.ts:106 R5 B2: bound $S resolution reaches tmpTargets
    [19,"bash","S=$FOREMAN_SCRATCH; echo x > $S/f","b"],
    // permoverlay-vars-bind.test.ts:320 powershell: unbound $HOME / ~ are trusted
    [18,"powershell",{"command":"Get-Content ~/.pi/agent/pi-foreman/x"},"m"],
    [18,"bash","cat ~/.pi/agent/pi-foreman/x","m"],
  ]);
});

test("permoverlay-vars", posixOnly, () => {
  run([
    // permoverlay-vars.test.ts:36 a same-line assignment statement resolves a later $VAR like the literal path
    [24,"bash","D=/Users/r2fx/scratch/x; mkdir -p $D","b"],
    [24,"bash","D=/Users/r2fx/scratch/x && mkdir -p \"$D\"","b"],
    [24,"bash","mkdir -p /Users/r2fx/scratch/x","b"],
    [24,"bash","cat $H/handoffs/s1/ruling.md","b"],
    // permoverlay-vars.test.ts:48 $FOREMAN_SCRATCH resolves anywhere in a word, from the harness env only
    [24,"bash","mkdir -p $FOREMAN_SCRATCH/probe/x","b"],
    // permoverlay-vars.test.ts:55 a prefix assignment stays unresolved: the same decision as an unknown $D
    [24,"bash","cat $D/handoffs/s1/ruling.md","b"],
    [24,"bash","D=/Users/r2fx/home/.pi/agent/pi-foreman cat $D/handoffs/s1/ruling.md","b"],
    // permoverlay-vars.test.ts:61 the last assignment wins; unsafe or conditional forms stay unresolved
    [24,"bash","D=/Users/r2fx/home/.pi/agent/pi-foreman; D=/Users/r2fx/scratch; cat $D/handoffs/s1/ruling.md","b"],
    [24,"bash","true && D=/Users/r2fx/home/.pi/agent/pi-foreman; cat $D/handoffs/s1/ruling.md","b"],
    [24,"bash","(D=/Users/r2fx/home/.pi/agent/pi-foreman); cat $D/handoffs/s1/ruling.md","b"],
    [24,"bash","D=/Users/r2fx/home/.pi/agent/pi-foreman; for D in a; do cat $D/handoffs/s1/ruling.md; done","b"],
    [24,"bash","D=/Users/r2fx/home/.pi/agent/pi-foreman; export D=x; cat $D/handoffs/s1/ruling.md","b"],
    [24,"bash","D=/Users/r2fx/home/.pi/agent/pi-foreman; read D; cat $D/handoffs/s1/ruling.md","b"],
    [24,"bash","D=handoffs; cat /Users/r2fx/home/.pi/agent/pi-foreman/$D/s1/ruling.md","b"],
    [24,"bash","D=$(pwd); cat $D/handoffs/s1/ruling.md","b"],
    [24,"bash","D=\"$X/y\"; cat $D/handoffs/s1/ruling.md","b"],
  ]);
});

test("permoverlay", posixOnly, () => {
  run([
    // permoverlay.test.ts:79 harmless commands pass, including the .env.example exception and prose
    [7,"bash","ls -la","m"],
    [7,"bash","git diff --no-index a notes.txt","m"],
    [7,"bash","grep -r process.env src","m"],
    [7,"bash","grep credentials README.md","m"],
    [7,"bash","git commit -m \"document the env handling\"","m"],
    [7,"bash","npm test","m"],
    [7,"bash","node --test tests/","m"],
    [7,"bash","echo ok 2>&1","m"],
    // permoverlay.test.ts:99 read/write/edit/grep/find/ls paths are checked, relative, absolute and ~
    [7,"read",{"path":"notes.txt"},"m"],
    [7,"read",{"path":".env.example"},"m"],
    [7,"subagent",{"path":".env"},"m"],
    // permoverlay.test.ts:118 deny beats allow: a layer's own allow cannot lift a deny
    [7,"bash","curl https://x.invalid -o out","m"],
    // permoverlay.test.ts:138 project/session additions: only added asks are enforced here
    [7,"bash","make deploy x","m"],
    [7,"read",{"path":"l2/a.txt"},"m"],
    // permoverlay.test.ts:161 matcher differences from the permission system: documented behaviours
    [7,"bash","D=.e; cat ${D}nv","m"],
    // permoverlay.test.ts:207 git_log and git_diff_stat path arguments are checked like read
    [7,"git_log",{"path":"notes.txt"},"m"],
    // permoverlay.test.ts:244 literal rows 6-11: node_modules reads pass for a child when the package root is writeAsk (
    [3,"bash","ls node_modules | head -3; ls node_modules/.bin | head -3; cat extensions/core-adapter/cachepolicy.ts; cat extensions/core-adapter/compaction.ts; cat extensions/core-adapter/prwatch.ts | head -120; cat extensions/core-adapter/trace.ts | head -60","b"],
    [3,"bash","ls /Users/r2fx/proj/node_modules | wc -l; ls node_modules | wc -l","b"],
    [3,"bash","grep -rn \"cacheRead\" -r node_modules/@anthropic* 2>/dev/null | head -0; grep -rn \"claude-sonnet\\|cacheRead\" --include=*.json -l config 2>/dev/null | head","b"],
    [3,"bash","grep -n \"anthropic\" -il node_modules/@earendil-works/pi-ai/dist/*.js | head; ls node_modules/@earendil-works/pi-ai/dist | head -30","b"],
    [3,"bash","grep -rn \"claude-sonnet-4-5\\\"\" node_modules/@earendil-works/pi-ai/dist/models.generated.js | head -3","b"],
    [3,"bash","ls node_modules/@earendil-works/pi-ai/dist/ | head -20","b"],
    // permoverlay.test.ts:257 literal row 12 and 18: a grep flag value (--exclude-dir=.git, .claude) is no path
    [4,"bash","cd /Users/r2fx/proj; grep -rln \"symbols.json\" --exclude-dir=node_modules --exclude-dir=.git . | head","bm"],
    [4,"bash","grep -rn x --exclude-dir=.claude --exclude-dir .git --include=*.ts src","bm"],
    [4,"bash","rg -g '!.git' -g=.claude --glob .pi x","bm"],
    // permoverlay.test.ts:304 literal rows 15, 21, 22: the foreman reads foreman.json and settings.json without a dialog
    [3,"bash","cat /Users/r2fx/home/.pi/agent/foreman.json","m"],
    [3,"bash","cat ~/.pi/agent/foreman.json","m"],
    [3,"bash","grep -n x /Users/r2fx/home/.pi/agent/settings.json | head","m"],
    // permoverlay.test.ts:328 literal rows 19, 20: env | grep and a branch listing next to inline python
    [3,"bash","env | grep PATH","b"],
    [3,"bash","git branch -a && python3 -c 'print(\"git\")'","b"],
    [4,"bash","env | grep PATH","m"],
    [4,"bash","git branch -a && python3 -c 'print(\"git\")'","m"],
    // permoverlay.test.ts:338 literal row 23: the pattern of grep/rg is no path (process.env)
    [3,"bash","grep -rn \"process.env\" node_modules/@gotgenes/pi-permission-system/src | head","bm"],
    [3,"bash","rg -e .env -- notes.txt","b"],
    // permoverlay.test.ts:348 literal row 24 stays denied for a child: the permission system's own sources are protected
    [3,"bash","grep -n \"externalDirectory\" /Users/r2fx/home/.pi/agent/extensions/pi-permission-system/config.json","m"],
    // permoverlay.test.ts:355 literal row 25: a child's own scratch dir is open on every overlay surface
    [24,"bash","cat $FOREMAN_SCRATCH/replay.log","b"],
    [24,"bash","cd ${FOREMAN_SCRATCH}/probe && ls","b"],
    [24,"read",{"path":"/Users/r2fx/scratch/probe/x.mjs"},"b"],
    [24,"write",{"path":"/Users/r2fx/scratch/probe/x.mjs"},"b"],
    [24,"edit",{"path":"/Users/r2fx/scratch/probe/x.mjs"},"b"],
    [24,"ls",{"path":"/Users/r2fx/scratch/probe/x.mjs"},"b"],
    [24,"grep",{"path":"/Users/r2fx/scratch/probe/x.mjs"},"b"],
    [24,"find",{"path":"/Users/r2fx/scratch/probe/x.mjs"},"b"],
    [24,"read",{"path":"/Users/r2fx/scratch/f.txt"},"b"],
    // permoverlay.test.ts:371 negative controls: write-capable commands on protected paths stay protected
    [3,"bash","xargs rm < list","b"],
    [3,"write",{"path":"/Users/r2fx/home/.pi/agent/pi-foreman/handoffs/s1/plan.md"},"m"],
    // permoverlay.test.ts:424 child blocks: handoffs, subagent artifacts and foreman.json are the foreman's; settings.js
    [4,"read",{"path":"/Users/r2fx/home/.pi/agent/settings.json"},"b"],
    [4,"read",{"path":"/Users/r2fx/home/.pi/agent/pi-foreman/handoffs/s1/notes.md"},"m"],
    [4,"write",{"path":"/Users/r2fx/home/.pi/agent/sessions/x/subagent-artifacts/a.md"},"m"],
    [4,"ls",{"path":"/Users/r2fx/home/.pi/agent/pi-foreman/handoffs/s1/notes.md"},"m"],
    [4,"bash","cat /Users/r2fx/home/.pi/agent/pi-foreman/handoffs/s1/notes.md","m"],
    // permoverlay.test.ts:447 git worktree: a child may list, not add/prune/lock/unlock/move/repair; remove is the permi
    [4,"bash","git worktree list","b"],
    [4,"bash","git worktree remove ../x","b"],
    [3,"bash","git worktree add x","m"],
    [3,"bash","git worktree prune","m"],
    [3,"bash","git worktree lock x","m"],
    [3,"bash","git worktree unlock x","m"],
    [3,"bash","git worktree move a b","m"],
    [3,"bash","git worktree repair","m"],
    // permoverlay.test.ts:476 revision B1: a protected path reaching a write redirect through a variable keeps its prote
    [3,"bash","cat config/foreman.defaults.json","b"],
    [3,"bash","cat config/foreman.defaults.json 2>&1 | head","b"],
    // permoverlay.test.ts:546 revision B3: a child stays out of sibling worktrees, other scratch dirs, ruling.md and cla
    [25,"write",{"path":"/Users/r2fx/proj/sub/f.txt"},"b"],
    [25,"write",{"path":"/Users/r2fx/tmp/pi-foreman-scratch/child1/f.txt"},"b"],
    [26,"write",{"path":"/Users/r2fx/proj.worktrees/other/f.txt"},"m"],
    [26,"write",{"path":"/Users/r2fx/tmp/pi-foreman-scratch/s1/L2/f.txt"},"m"],
    [25,"edit",{"path":"/Users/r2fx/proj/sub/f.txt"},"b"],
    [25,"edit",{"path":"/Users/r2fx/tmp/pi-foreman-scratch/child1/f.txt"},"b"],
    [26,"edit",{"path":"/Users/r2fx/proj.worktrees/other/f.txt"},"m"],
    [26,"edit",{"path":"/Users/r2fx/tmp/pi-foreman-scratch/s1/L2/f.txt"},"m"],
    [26,"read",{"path":"/Users/r2fx/home/.pi/agent/pi-foreman/claude-config/.credentials.json"},"m"],
    [26,"ls",{"path":"/Users/r2fx/home/.pi/agent/pi-foreman/claude-config/.credentials.json"},"m"],
    [26,"grep",{"path":"/Users/r2fx/home/.pi/agent/pi-foreman/claude-config/.credentials.json"},"m"],
    [26,"find",{"path":"/Users/r2fx/home/.pi/agent/pi-foreman/claude-config/.credentials.json"},"m"],
    [25,"read",{"path":"/Users/r2fx/tmp/pi-foreman-scratch/child1/f.txt"},"b"],
    [25,"bash","echo x > /Users/r2fx/proj/sub/f.txt","b"],
    [25,"bash","echo x > /Users/r2fx/tmp/pi-foreman-scratch/child1/f.txt","b"],
    [25,"bash","echo x > $FOREMAN_SCRATCH/g.txt","b"],
    [25,"bash","cat /Users/r2fx/home/.pi/agent/pi-foreman/nothing/.credentials.json","b"],
    [26,"bash","echo x > /Users/r2fx/proj.worktrees/other/f.txt","m"],
    [26,"bash","echo x > /Users/r2fx/tmp/pi-foreman-scratch/s1/L2/f.txt","m"],
    [26,"bash","echo x > /Users/r2fx/home/.pi/agent/pi-foreman/handoffs/s1/deep/ruling.md","m"],
    [26,"bash","cat /Users/r2fx/home/.pi/agent/pi-foreman/claude-config/.credentials.json","m"],
  ]);
});

test("probescan", posixOnly, () => {
  run([
    // probescan.test.ts:72 a reviewer still runs tracked test operands and flags
    [10,"bash","node --test","r"],
    [10,"bash","node --test tests/t.test.mjs","r"],
    [10,"bash","node --test --test-name-pattern foo tests/t.test.mjs","r"],
    [10,"bash","npm run test:node -- --test-name-pattern foo","r"],
    [10,"bash","npm run test:node","r"],
    [10,"bash","pytest tests/test_x.py::A::b -k foo","r"],
    [10,"bash","pytest tests","r"],
    [10,"bash","make test -C .","r"],
    [10,"bash","python3 -m unittest discover -s tests","r"],
    [10,"bash","python3 -m unittest tests.test_x","r"],
    [10,"bash","python3 -m unittest tests.test_x.Case.test_a","r"],
    // probescan.test.ts:89 a builder runs its own new untracked test in its worktree
    [10,"bash","node --test tests/new.test.mjs","b"],
    // probescan.test.ts:93 git config is a read only in its read forms (read-only child)
    [10,"bash","git config user.name","r"],
    [10,"bash","git config --get core.hooksPath","r"],
    [10,"bash","git config --get user.name '^x'","r"],
    [10,"bash","git config --get-all remote.origin.url","r"],
    [10,"bash","git config --get-regexp '^remote\\.'","r"],
    [10,"bash","git config --list","r"],
    [10,"bash","git config -l --show-origin --show-scope","r"],
    [10,"bash","git config --local --includes --list -z","r"],
    [10,"bash","git config --worktree --includes --list -z","r"],
    [10,"bash","git config --global --no-includes --name-only --list","r"],
    [10,"bash","git config get user.name","r"],
    [10,"bash","git config list","r"],
    [10,"bash","git config --type=bool --default false core.bare","r"],
    [10,"bash","git config --bool core.bare","r"],
    [10,"bash","git config --get-urlmatch http.proxy https://example.invalid","r"],
    // probescan.test.ts:149 scratch scripts without a reassembled token keep running
    [27,"bash","node plain.mjs","br"],
    [27,"bash","node $FOREMAN_SCRATCH/ordinary.mjs","r"],
    [27,"bash","node /Users/r2fx/scratch/read.mjs /Users/r2fx/scratch/plain.mjs","r"],
    // probescan.test.ts:157 tracked, unmodified files of the round worktree are not scanned
    [10,"bash","node --test tests/committed-evil.test.mjs","br"],
    // probescan.test.ts:197 finding 3: attached make options are resolved
    [10,"bash","make test -C.","r"],
    [10,"bash","make test -f Makefile","r"],
    // probescan.test.ts:252 finding 7: a git config write is denied for a read-only child whatever repository it names
    [10,"bash","git -C . config --list","r"],
    // probescan.test.ts:327 fix 2C: git config in a write form is denied for a read-only child whatever the target and
    [27,"bash","git config --global --list","r"],
    [27,"bash","git config --global user.name","r"],
    // probescan.test.ts:333 fix 3A: test-runner words with $VAR, ~ or command substitution are expanded and checked, u
    [10,"bash","node --test \"extensions/core-adapter/test/*.test.ts\"","r"],
    [10,"bash","python3 scripts/foreman_docs.py features --check","r"],
    [10,"bash","pytest -k name tests/test_x.py","r"],
    [10,"bash","pytest -k name","r"],
  ]);
});

test("r10-child-npm-owned-subdir", posixOnly, () => {
  run([
    // r10-child-npm-owned-subdir.test.ts:63 `expected-open (R10f): child in ${path.relative(w, cwd)}: ${cmd} (overlay pass)`
    [4,"bash","npm ci --package-lock-only","b"],
    [4,"bash","npm install --package-lock-only","b"],
    [4,"bash","npm install --package-lock-only --ignore-scripts","b"],
    [4,"bash","cd bench/pi-lock && npm ci","b"],
    [4,"bash","cd bench/pi-lock && npm install --package-lock-only --ignore-scripts","b"],
    [4,"bash","npm ci --prefix bench/pi-lock","b"],
    [4,"bash","npm install --package-lock-only --prefix=bench/pi-lock","b"],
    [4,"bash","npm install --package-lock-only --ignore-scripts --prefix /Users/r2fx/proj/bench/pi-lock","b"],
    [4,"bash","cd bench/pi-lock && npm ci --prefix .","b"],
    [28,"bash","npm ci --prefix ../..","b"],
    // r10-child-npm-owned-subdir.test.ts:138 expected-open (R10f): win32 child: cd bench/pi-lock && npm ci, --prefix=<root>/bench/pi-lo
    [5,"bash","cd bench/pi-lock && npm ci","b"],
    [5,"bash","npm install --package-lock-only --ignore-scripts","b"],
    [29,"bash","npm install --package-lock-only","b"],
  ]);
});

test("r10-pi-scratch-read", posixOnly, () => {
  run([
    // r10-pi-scratch-read.test.ts:38 `expected-open (R10b): ${cmd.replace(w, "<tmp>")} (overlay, ${role === "main" ? "foreman" 
    [30,"bash","ls .pi/scratch","bm"],
    [30,"bash","ls -la .pi/scratch/","bm"],
    [30,"bash","cat .pi/scratch/ci.log","bm"],
    [30,"bash","tail -n 50 .pi/scratch/ci.log","bm"],
    [30,"bash","head .pi/scratch/ci.log","bm"],
    [30,"bash","wc -l .pi/scratch/ci.log","bm"],
    [30,"bash","grep -n error .pi/scratch/ci.log","bm"],
    [30,"bash","cat /Users/r2fx/proj/.pi/scratch/ci.log","bm"],
  ]);
});

test("r10-plain-session-workflow-read", posixOnly, () => {
  run([
    // r10-plain-session-workflow-read.test.ts:28 expected-open (R10e): plain session overlay passes a read of the hub ledger (readable = hu
    [31,"bash","cat /Users/r2fx/x/pf-r10-plainwf/hub/.workflow/LEDGER-r9.md","m"],
    [31,"read",{"path":"/Users/r2fx/x/pf-r10-plainwf/hub/.workflow/LEDGER-r9.md"},"m"],
  ]);
});

test("r10-quoted-pattern-args", posixOnly, () => {
  run([
    // r10-quoted-pattern-args.test.ts:56 `expected-open (R10d): ${cmd} (overlay pass for foreman and child; the link layer is cappe
    [3,"bash","git log -L '/start/,/end/:src/x.ts'","m"],
    [4,"bash","git log -L '/start/,/end/:src/x.ts'","b"],
    [3,"bash","git log -S '/api/v1/' --oneline","m"],
    [4,"bash","git log -S '/api/v1/' --oneline","b"],
    [3,"bash","git log -G '/usr/.*bin/' -p -- src","m"],
    [4,"bash","git log -G '/usr/.*bin/' -p -- src","b"],
    [3,"bash","git log --grep '/r9/' --oneline","m"],
    [4,"bash","git log --grep '/r9/' --oneline","b"],
    [3,"bash","git log --grep=/r9/ --oneline","m"],
    [4,"bash","git log --grep=/r9/ --oneline","b"],
    [3,"bash","git log --oneline -S /x/y -G /a/b","m"],
    [4,"bash","git log --oneline -S /x/y -G /a/b","b"],
    [3,"bash","grep -ne '/foo/' src/x.ts","m"],
    [4,"bash","grep -ne '/foo/' src/x.ts","b"],
    [3,"bash","grep -n -e '/foo/' -e '/bar/' src","m"],
    [4,"bash","grep -n -e '/foo/' -e '/bar/' src","b"],
    [3,"bash","rg -e '/foo/bar' src","m"],
    [4,"bash","rg -e '/foo/bar' src","b"],
    [3,"bash","sed -n '/a/,/b/p' src/x.ts","m"],
    [4,"bash","sed -n '/a/,/b/p' src/x.ts","b"],
    [3,"bash","git show HEAD:src/x.ts | sed -n '/start/,/end/p' | head -20","m"],
    [4,"bash","git show HEAD:src/x.ts | sed -n '/start/,/end/p' | head -20","b"],
    [3,"bash","cd src && git log -S '/api/' --oneline | head","m"],
    [4,"bash","cd src && git log -S '/api/' --oneline | head","b"],
    // r10-quoted-pattern-args.test.ts:62 expected-open (R10d): a git log -S/-G/--grep value naming a probe dir is a pattern, not a 
    [3,"bash","git log -S /usr/local/bin --oneline","m"],
    [4,"bash","git log -S /usr/local/bin --oneline","b"],
    [3,"bash","git log -G '/opt/homebrew/bin' -p","m"],
    [4,"bash","git log -G '/opt/homebrew/bin' -p","b"],
    [3,"bash","git log --grep /usr/bin","m"],
    [4,"bash","git log --grep /usr/bin","b"],
  ]);
});

test("r10-state-usage-read", posixOnly, () => {
  run([
    // r10-state-usage-read.test.ts:47 `expected-open (R10a): ${cmd.replace(w, "<tmp>")} (overlay, foreman)`
    [32,"bash","ls /Users/r2fx/home/.pi/agent/pi-foreman/state/usage","m"],
    [32,"bash","ls -la /Users/r2fx/home/.pi/agent/pi-foreman/state/usage","m"],
    [32,"bash","cat /Users/r2fx/home/.pi/agent/pi-foreman/state/usage/u.jsonl","m"],
    [32,"bash","head -n 5 /Users/r2fx/home/.pi/agent/pi-foreman/state/usage/u.jsonl","m"],
    [32,"bash","tail -n 5 /Users/r2fx/home/.pi/agent/pi-foreman/state/usage/u.jsonl","m"],
    [32,"bash","wc -l /Users/r2fx/home/.pi/agent/pi-foreman/state/usage/u.jsonl","m"],
    [32,"bash","stat /Users/r2fx/home/.pi/agent/pi-foreman/state/usage/u.jsonl","m"],
    [32,"bash","stat /Users/r2fx/home/.pi/agent/pi-foreman/state/usage","m"],
    [32,"bash","python3 -c \"print(open('/Users/r2fx/home/.pi/agent/pi-foreman/state/usage/u.jsonl').read())\"","m"],
    [32,"bash","python3 -c \"import json; print(json.load(open('/Users/r2fx/home/.pi/agent/pi-foreman/state/usage/u.jsonl')))\"","m"],
  ]);
});

test("r10-toolchain-probe", posixOnly, () => {
  run([
    // r10-toolchain-probe.test.ts:48 `expected-open (R10c): ${cmd} (overlay, ${role === "main" ? "foreman" : "child"})`
    [3,"bash","which node","bm"],
    [3,"bash","which -a npx","bm"],
    [3,"bash","ls /usr/local/bin","bm"],
    [3,"bash","ls -la /opt/homebrew/bin","bm"],
    [3,"bash","stat /usr/bin","bm"],
    [3,"bash","ls ~/.npm/_npx","bm"],
    [3,"bash","ls -la ~/.npm/_npx/abc","bm"],
    [3,"bash","stat ~/.local/bin","bm"],
    [3,"bash","ls $HOME/.npm-global/bin","bm"],
    [3,"bash","ls /usr/local/bin /opt/homebrew/bin && stat ~/.npm/_npx","bm"],
    [3,"bash","which node && ls -l /usr/local/bin","bm"],
    // r10-toolchain-probe.test.ts:54 expected-open (R10c): the ls tool on a probe dir (overlay, foreman and child)
    [3,"ls",{"path":"/usr/local/bin"},"bm"],
    [3,"ls",{"path":"/Users/r2fx/home/.npm/_npx"},"bm"],
    // r10-toolchain-probe.test.ts:128 a dir merely sharing a prefix with a probe dir is not narrowed
    [3,"bash","cat /usr/local/binx/y","m"],
  ]);
});

test("r11-guard-false-positives-2", posixOnly, () => {
  run([
    // r11-guard-false-positives-2.test.ts:43 cd_guard_commit_message_single_quoted_mention_allowed
    [2,"bash","git commit -m 'about ${CDPATH:=/tmp} as text' && cd sub","b"],
    [2,"bash","git commit -m 'about ${CDPATH=/} and `x`'","b"],
    [2,"bash","git commit -m 'subject' -m 'body: CDPATH=${CDPATH:=x}'","b"],
    [2,"bash","git commit -m \"plain CDPATH mention\" -m '${CDPATH:=/}'","b"],
    [2,"bash","git commit -m \"escaped \\${CDPATH:=/} is literal\"","b"],
    // r11-guard-false-positives-2.test.ts:77 home_binding_python_c_body_alone_still_ignored
    [2,"bash","python3 -c \"x=1; d={'HOME': 2}; print('~')\"","b"],
    [2,"bash","/usr/bin/python3 -c 'HOME=1; print(HOME)'","b"],
    [2,"bash","node -e \"const HOME=1; console.log('~')\"","b"],
  ]);
});

test("r11-guard-false-positives", posixOnly, () => {
  run([
    // r11-guard-false-positives.test.ts:32 cd_guard_commit_message_mentions_cdpath_allowed
    [2,"bash","git commit -m \"fix(guard): the cd guard no longer reads CDPATH inside a commit message\"","b"],
    [2,"bash","git commit -m 'mentions CDPATH and CDPATH=x only as text'","b"],
    [2,"bash","git commit -m \"subject\" -m \"body about CDPATH\"","b"],
    [2,"bash","git commit -am \"about CDPATH\"","b"],
    [2,"bash","git commit -m\"about CDPATH\"","b"],
    [2,"bash","git commit --message=\"about CDPATH\"","b"],
    [2,"bash","git commit --message \"about CDPATH\"","b"],
    // r11-guard-false-positives.test.ts:64 home_binding_python_c_body_equals_ignored
    [2,"bash","cat /Users/r2fx/x/pf-r11/usage.json | python3 -c \"import json,sys,os; d=json.load(sys.stdin); x=d['HOME']; print(x, os.path.expanduser('~'))\"","b"],
  ]);
});

test("r12-interp-shadow", posixOnly, () => {
  run([
    // r12-interp-shadow.test.ts:26 interp_python_c_plain_still_allowed
    [2,"bash","python3 -c 'x=1'","b"],
    [2,"bash","python3 -c 'HOME=1; print(HOME)'","b"],
    [2,"bash","python3 -c 'x = 1 ; print(x)' && node -e 'const HOME=1'","b"],
  ]);
});

test("r12-state-read", posixOnly, () => {
  run([
    // r12-state-read.test.ts:43 state_usage_ls_grep_chain_r11_literal
    [33,"bash","ls ~/.pi/agent/pi-foreman/state/usage/ | grep 01a14b65; node --version","m"],
    [33,"bash","ls $HOME/.pi/agent/pi-foreman/state/usage/ | grep 01a14b65","m"],
    [33,"bash","ls /Users/r2fx/home/.pi/agent/pi-foreman/state/usage/ | wc -l","m"],
    // r12-state-read.test.ts:50 state_live_var_bound_python_r11_literal
    [33,"bash","f=~/.pi/agent/pi-foreman/state/live/01a14b65-own.json; python3 -c \"import json,sys; print(json.load(open(sys.argv[1])))\" $f","m"],
    [33,"bash","f=~/.pi/agent/pi-foreman/state/live/01a14b65-own.json; python3 -c \"print(open('$f').read())\"","m"],
    // r12-state-read.test.ts:56 state_live_var_bound_python_open_argv_r12_live_literal
    [33,"bash","f=~/.pi/agent/pi-foreman/state/live/01a14b65-own.json; python3 -c \"import json,sys; print(json.load(open(sys.argv[1]))[\\\"state\\\"])\" $f","m"],
    [33,"bash","f=~/.pi/agent/pi-foreman/state/live/01a14b65-own.json; python3 -c \"import json,sys; print(json.load(open(sys.argv[1], 'r'))[\\\"state\\\"])\" $f","m"],
    [33,"bash","f=~/.pi/agent/pi-foreman/state/live/01a14b65-own.json; python3 -c \"import json,sys; print(json.load(open(sys.argv[1], 'rb'))[\\\"state\\\"])\" $f","m"],
    [33,"bash","f=~/.pi/agent/pi-foreman/state/live/01a14b65-own.json; python3 -c \"import json,sys; print(open(sys.argv[2]).read())\" $f $f","m"],
    // r12-state-read.test.ts:77 state_live_var_bound_ls
    [33,"bash","f=~/.pi/agent/pi-foreman/state/live/01a14b65-own.json; ls $f","m"],
    [33,"bash","f=~/.pi/agent/pi-foreman/state/live/01a14b65-own.json; ls -la \"${f}\"; cat $f | head -n 3","m"],
    // r12-state-read.test.ts:82 state_usage_node_e_read
    [33,"bash","node -e \"console.log(require('fs').readFileSync('/Users/r2fx/home/.pi/agent/pi-foreman/state/usage/01a14b65-own.jsonl','utf8'))\"","m"],
    [33,"bash","node -e \"process.stdout.write(require('fs').readFileSync('/Users/r2fx/home/.pi/agent/pi-foreman/state/usage/01a14b65-own.jsonl', 'utf8'))\"","m"],
  ]);
});

test("r13-bash-output-log", posixOnly, () => {
  run([
    // r13-bash-output-log.test.ts:37 r13 bash log: the R12 line passes for the session that recorded the path, for read-only ve
    [34,"bash","cut -c1-600 /Users/r2fx/x/pf-r13-bashlog/pi-bash-0123456789abcdef.log | head -40","bm"],
    [34,"bash","tail -c 2500 /Users/r2fx/x/pf-r13-bashlog/pi-bash-0123456789abcdef.log","bm"],
    [34,"bash","grep -n error /Users/r2fx/x/pf-r13-bashlog/pi-bash-0123456789abcdef.log","bm"],
  ]);
});

test("r14-child-msgfile", posixOnly, () => {
  run([
    // r14-child-msgfile.test.ts:30 child_git_commit_F_pi_scratch_left_to_the_gate
    [3,"bash","git commit -F .pi/scratch/m.txt","b"],
    [3,"bash","git commit --file .pi/scratch/m.txt","b"],
    [3,"bash","git commit --file=.pi/scratch/m.txt","b"],
    [3,"bash","git commit -s -F .pi/scratch/m.txt","b"],
    [3,"bash","git commit -F .workflow/scratch/m.txt","b"],
    // r14-child-msgfile.test.ts:79 child_git_commit_F_workflow_and_own_scratch_pass
    [35,"bash","git commit -F /Users/r2fx/tmp/pi-foreman-scratch/child1/m.txt","b"],
    [35,"bash","git commit -F $FOREMAN_SCRATCH/m.txt","b"],
    // r14-child-msgfile.test.ts:132 child_git_tag_F_own_scratch_passes
    [35,"bash","git tag -a v -F /Users/r2fx/tmp/pi-foreman-scratch/child1/m.txt","b"],
  ]);
});

test("r14-own-bg-output", posixOnly, () => {
  run([
    // r14-own-bg-output.test.ts:42 own_bg_output_cat_literal_passes
    [36,"bash","cat .pi/tasks/01a1500b-own-66406/bc00d3ee1.output","m"],
    [36,"bash","head -20 .pi/tasks/01a1500b-own-66406/bc00d3ee1.output","m"],
    [36,"bash","tail -n 5 .pi/tasks/01a1500b-own-66406/bc00d3ee1.output","m"],
    [36,"bash","wc -l .pi/tasks/01a1500b-own-66406/bc00d3ee1.output","m"],
    [36,"bash","ls -la .pi/tasks/01a1500b-own-66406/","m"],
    [36,"bash","stat .pi/tasks/01a1500b-own-66406/bc00d3ee1.output","m"],
  ]);
});

test("r14-own-state-read", posixOnly, () => {
  run([
    // r14-own-state-read.test.ts:62 own_state_read_live_binding_python_literal_passes
    [37,"bash","f=~/.pi/agent/pi-foreman/state/live/01a1500b-own.json; python3 -c \"import json,sys; print(json.load(open(sys.argv[1]))[\\\"state\\\"])\" $f","m"],
    // r14-own-state-read.test.ts:66 own_state_read_cd_worktree_scratch_script_literal_passes
    [37,"bash","cd /Users/r2fx/proj && node --experimental-strip-types .workflow/scratch/dialogs.mjs ~/.pi/agent/pi-foreman/state/trace-01a1500b-own.jsonl 2>&1 | head -80","m"],
    [37,"bash","cd /Users/r2fx/proj && node .workflow/scratch/dialogs.mjs ~/.pi/agent/pi-foreman/state/trace-01a1500b-own.jsonl","m"],
    [37,"bash","cd /Users/r2fx/proj && python3 .workflow/scratch/dialogs.py ~/.pi/agent/pi-foreman/state/trace-01a1500b-own.jsonl | head -5","m"],
    [37,"bash","f=~/.pi/agent/pi-foreman/state/trace-01a1500b-own.jsonl; node /Users/r2fx/proj/.workflow/scratch/dialogs.mjs $f","m"],
  ]);
});

test("r27-child-inplace", posixOnly, () => {
  run([
    // r27-child-inplace.test.ts:39 reads with the same interpreters are not this deny
    [38,"bash","python3 -c \"print(open('package.json').read())\"","b"],
    [38,"bash","ruby -e 'puts 1'","b"],
    [38,"bash","perl -e 'open(F,\"f\"); print <F>'","b"],
    [38,"bash","perl -e 'open(F,\"<f\"); print <F>'","b"],
    // r27-child-inplace.test.ts:58 an in-place edit whose file lies in the child's own scratch dir passes from the scratch cw
    [39,"bash","perl -pi -e s/x/y/ /Users/r2fx/scratch/f","b"],
    // r27-child-inplace.test.ts:75 an in-place perl edit whose -e code calls system() passes from scratch (system( is not a w
    [39,"bash","perl -pi -e 'system(\"rm x\")' /Users/r2fx/scratch/f","b"],
    // r27-child-inplace.test.ts:80 an awk in-place edit of a scratch file passes from the scratch cwd (the program operand is
    [39,"bash","awk -i inplace '{print}' /Users/r2fx/scratch/f","b"],
  ]);
});

test("r29-protected-read-only", posixOnly, () => {
  run([
    // r29-protected-read-only.test.ts:41 a child's read of a protected file passes: git diff, grep, cat
    [40,"bash","git diff HEAD~1..HEAD -- package.json","b"],
    [40,"bash","git diff -- package.json","b"],
    [40,"bash","git -C . diff -- package.json","b"],
    [40,"bash","git log -p -- package.json","b"],
    [40,"bash","git show HEAD:README.md | grep -n x","b"],
    [40,"bash","grep x package.json","b"],
    [40,"bash","cat package.json","b"],
    [40,"bash","cat package.json | head -2","b"],
    // r29-protected-read-only.test.ts:79 read-only git shapes on a protected file pass
    [40,"bash","git diff a..b -- package.json","b"],
    [40,"bash","git show HEAD:package.json","b"],
    // r29-protected-read-only.test.ts:108 plain git readers still pass on a protected file (new cases)
    [40,"bash","git -C sub diff -- package.json","b"],
    // r29-protected-read-only.test.ts:127 git protected readers with listed options and plain operands pass
    [40,"bash","git diff --stat main..HEAD -- package.json","b"],
    [40,"bash","git log -p -n3 -- package.json","b"],
    [40,"bash","git log --oneline -5 -- package.json","b"],
    [40,"bash","git status --short package.json","b"],
  ]);
});

test("r3-bridge-config", posixOnly, () => {
  run([
    // r3-bridge-config.test.ts:121 R3-H1 / round 3: protect set covers .pi/claude-bridge.json and remove/rename of the state 
    [4,"bash","ls ~/.pi/agent/pi-foreman","bm"],
    [4,"bash","ls -la ~/.pi/agent","bm"],
    [4,"read",{"path":"/Users/r2fx/home/.pi/agent/pi-foreman"},"bm"],
    [4,"ls",{"path":"/Users/r2fx/home/.pi/agent"},"bm"],
    [4,"foreman_copy",{"src":"/Users/r2fx/home/.pi/agent/pi-foreman","dst":"/Users/r2fx/x/pf-r3p/copy"},"m"],
  ]);
});

test("r31c-grep-own-read", posixOnly, () => {
  run([
    // r31c-grep-own-read.test.ts:50 R1.1 grep over the own trace and the own usage file passes
    [41,"bash","grep -c x ~/.pi/agent/pi-foreman/state/trace-01a1500b-own.jsonl","m"],
    [41,"bash","grep -n x ~/.pi/agent/pi-foreman/state/usage/01a1500b-fsess.jsonl","m"],
    [41,"bash","grep -nH -m 5 x ~/.pi/agent/pi-foreman/state/trace-01a1500b-own.jsonl","m"],
    [41,"bash","grep -A3 -B 2 x ~/.pi/agent/pi-foreman/state/trace-01a1500b-own.jsonl","m"],
    [41,"bash","grep --color=never -iv x ~/.pi/agent/pi-foreman/state/trace-01a1500b-own.jsonl","m"],
    [41,"bash","grep -E 'a|b' -- ~/.pi/agent/pi-foreman/state/trace-01a1500b-own.jsonl","m"],
    [41,"bash","grep '2026-10-23T10' ~/.pi/agent/pi-foreman/state/trace-01a1500b-own.jsonl | grep -E 'a\\|b' | cut -c1-700 | head","m"],
    [41,"bash","grep x ~/.pi/agent/pi-foreman/state/trace-01a1500b-own.jsonl 2>&1 | head -5","m"],
    [41,"bash","tail -n +5 ~/.pi/agent/pi-foreman/state/trace-01a1500b-own.jsonl","m"],
    [41,"bash","head -n 5 ~/.pi/agent/pi-foreman/state/trace-01a1500b-own.jsonl","m"],
    [41,"bash","tail -n5 ~/.pi/agent/pi-foreman/state/trace-01a1500b-own.jsonl","m"],
    // r31c-grep-own-read.test.ts:113 R1.3 a child or a missing own-read set never passes
    [41,"bash","grep x ~/.pi/agent/pi-foreman/state/trace-01a1500b-own.jsonl | cut -c1-9","m"],
  ]);
});

test("r31c-net-read", posixOnly, () => {
  run([
    // r31c-net-read.test.ts:156 R4.6 / R4.7 the child overlay: a read-only worktree child may run a network read, not writ
    [42,"bash","gh pr view 1","r"],
    [42,"bash","curl -sS https://e.example/x","r"],
    [42,"bash","gh pr view 1 | head -3","r"],
  ]);
});

test("r42-self-ruling-git-readonly", posixOnly, () => {
  run([
    // r42-self-ruling-git-readonly.test.ts:167 a read-only child may run a plain git ls-remote and is denied the program-running forms
    [10,"bash","git ls-remote origin b","r"],
  ]);
});

test("r46-identity-protect", posixOnly, () => {
  run([
    // r46-identity-protect.test.ts:32 live.json: a child's shell write is denied; the foreman's shell read stays open
    [4,"bash","cat /Users/r2fx/home/.pi/agent/pi-foreman/handoffs/s1/live.json","m"],
  ]);
});

test("r46-session-dir-move", posixOnly, () => {
  run([
    // r46-session-dir-move.test.ts:30 session dir and its ancestors up to sessions: mv and foreman_move ask (foreman) / deny (ch
    [4,"foreman_move",{"src":"/Users/r2fx/home/.pi/agent/sessions/--proj--/sub","dst":"/Users/r2fx/home/.pi/agent/sessions/--proj--/sub.old"},"m"],
    // r46-session-dir-move.test.ts:48 session dir: writes below it and sibling dirs still pass; agentDir above sessions is uncha
    [43,"write",{"path":"/Users/r2fx/home/.pi/agent/sessions/--proj--/sub/subagent-artifacts/run1_output.md","content":"x"},"m"],
    [43,"bash","echo x > /Users/r2fx/home/.pi/agent/sessions/--proj--/sub/subagent-artifacts/run1_output.md","m"],
    [43,"bash","mv /Users/r2fx/home/.pi/agent/sessions/--proj--/sub/subagent-artifacts/a /Users/r2fx/home/.pi/agent/sessions/--proj--/sub/subagent-artifacts/b","m"],
    [43,"foreman_move",{"src":"/Users/r2fx/home/.pi/agent/sessions/--proj--/sub/x.md","dst":"/Users/r2fx/home/.pi/agent/sessions/--proj--/sub/y.md"},"m"],
    [43,"foreman_move",{"src":"/Users/r2fx/home/.pi/agent/sessions/--proj--/other-session","dst":"/Users/r2fx/home/.pi/agent/sessions/--proj--/other-session.old"},"m"],
  ]);
});

test("r46-session-file-deny", posixOnly, () => {
  run([
    // r46-session-file-deny.test.ts:52 session file: reads stay allowed for the foreman
    [43,"read",{"path":"/Users/r2fx/home/.pi/agent/sessions/--proj--/sub/2026-01-01T00-00-00_abc.jsonl"},"m"],
    [43,"bash","cat /Users/r2fx/home/.pi/agent/sessions/--proj--/sub/2026-01-01T00-00-00_abc.jsonl","m"],
    [43,"bash","wc -l /Users/r2fx/home/.pi/agent/sessions/--proj--/sub/2026-01-01T00-00-00_abc.jsonl","m"],
    // r46-session-file-deny.test.ts:58 session dir: subagent-artifacts and other subdirs are not covered; non-jsonl files stay as
    [4,"write",{"path":"/Users/r2fx/home/.pi/agent/sessions/--proj--/subagent-artifacts/run1_output.md","content":"x"},"m"],
    [43,"write",{"path":"/Users/r2fx/home/.pi/agent/sessions/--proj--/sub/notes.md","content":"x"},"m"],
    [4,"write",{"path":"/Users/r2fx/home/.pi/agent/sessions/--proj--/notes.md","content":"x"},"m"],
    [4,"bash","echo x > /Users/r2fx/home/.pi/agent/sessions/--proj--/subagent-artifacts/run1_output.md","m"],
  ]);
});

test("r8-hub-workflow", posixOnly, () => {
  run([
    // r8-hub-workflow.test.ts:48 hub .workflow is readable by the read tool and read-only bash for main and child
    [44,"read",{"path":"/Users/r2fx/x/pf-hubwf/hub/.workflow/LEDGER.md"},"bm"],
    [44,"bash","cat /Users/r2fx/x/pf-hubwf/hub/.workflow/LEDGER.md","bm"],
    [44,"bash","grep -n item /Users/r2fx/x/pf-hubwf/hub/.workflow/LEDGER.md | head","bm"],
    // r8-hub-workflow.test.ts:58 hub .workflow stays read-only: a write or a redirect into it is not allowed
    [44,"bash","cp x /Users/r2fx/x/pf-hubwf/hub/.workflow/LEDGER.md","m"],
    [44,"bash","echo x > /Users/r2fx/x/pf-hubwf/hub/.workflow/LEDGER.md","m"],
    [44,"bash","tee /Users/r2fx/x/pf-hubwf/hub/.workflow/LEDGER.md","m"],
    [44,"write",{"path":"/Users/r2fx/x/pf-hubwf/hub/.workflow/LEDGER.md"},"m"],
    // r8-hub-workflow.test.ts:66 non-tmp hub: .workflow is readable for main and child, a write or redirect into it is not 
    [45,"read",{"path":"/Users/r2fx/x/pf-hubwf/nontmp/hub2/.workflow/LEDGER.md"},"bm"],
    [45,"bash","cat /Users/r2fx/x/pf-hubwf/nontmp/hub2/.workflow/LEDGER.md","bm"],
    [45,"bash","cp x /Users/r2fx/x/pf-hubwf/nontmp/hub2/.workflow/LEDGER.md","m"],
    [45,"bash","echo x > /Users/r2fx/x/pf-hubwf/nontmp/hub2/.workflow/LEDGER.md","m"],
    [45,"write",{"path":"/Users/r2fx/x/pf-hubwf/nontmp/hub2/.workflow/LEDGER.md"},"m"],
    // r8-hub-workflow.test.ts:82 an unconfigured sibling .workflow and an empty default behave as without the key
    [44,"bash","cat /Users/r2fx/x/pf-hubwf/sibling/.workflow/LEDGER.md","bm"],
    [44,"read",{"path":"/Users/r2fx/x/pf-hubwf/sibling/.workflow/L.md"},"bm"],
  ]);
});

test("role-skills-overlay", posixOnly, () => {
  run([
    // role-skills-overlay.test.ts:144 the read, grep and ls tools of a child get no overlay decision on the named skill
    [4,"read",{"path":"/Users/r2fx/home/.agents/skills/named/SKILL.md"},"b"],
    [4,"grep",{"pattern":"name","path":"/Users/r2fx/home/.agents/skills/named"},"b"],
    [4,"ls",{"path":"/Users/r2fx/home/.agents/skills/named"},"b"],
  ]);
});

test("roundowner-redirect", posixOnly, () => {
  run([
    // roundowner-redirect.test.ts:44 a reviewer still redirects to /dev/null, dups fds and writes its own scratch
    [10,"bash","cat f > /dev/null","r"],
    [10,"bash","ls 2>&1","r"],
    [10,"bash","grep x f 2>/dev/null","r"],
    [10,"bash","echo x > /Users/r2fx/scratch/out","r"],
    [27,"bash","echo x > out","r"],
    // roundowner-redirect.test.ts:49 a reviewer runs tracked repo scripts as test runs; interpreter code forms stay denied
    [10,"bash","python3 -I scripts/foreman_docs.py features --check","r"],
    [10,"bash","node scripts/check.mjs","r"],
  ]);
});

test("roundowner-script", posixOnly, () => {
  run([
    // roundowner-script.test.ts:66 a reviewer still runs tracked scripts and test runs
    [10,"bash","npm test","r"],
    // roundowner-script.test.ts:70 a builder keeps running scripts in its own worktree
    [10,"bash","python3 scripts/new.py","b"],
  ]);
});

test("roundowner-shell", posixOnly, () => {
  run([
    // roundowner-shell.test.ts:57 a reviewer still reads, diffs, logs, greps and runs the tests
    [10,"bash","cat f","r"],
    [10,"bash","git diff","r"],
    [10,"bash","git log","r"],
    [10,"bash","git status","r"],
    [10,"bash","git stash list","r"],
    [10,"bash","rg x","r"],
    [10,"bash","ls | wc -l","r"],
    [10,"bash","sed -n 1p f","r"],
    [10,"bash","bash -c 'cat f'","r"],
    // roundowner-shell.test.ts:61 a reviewer may write its own scratch dir
    [10,"bash","rm /Users/r2fx/scratch/x","r"],
    [10,"bash","touch /Users/r2fx/scratch/x","r"],
    // roundowner-shell.test.ts:66 git grep -O / --open-files-in-pager (any abbreviation) is no read in a reviewer; plain git
    [10,"bash","git grep x","r"],
    [10,"bash","git grep -n x -- f","r"],
    // roundowner-shell.test.ts:72 the builder in the round worktree is not restricted by the read-only check
    [10,"bash","rm f","b"],
    [10,"bash","sed -i '' s/x/y/ f","b"],
    [10,"bash","git checkout -- f","b"],
    [10,"bash","truncate -s0 f","b"],
  ]);
});

test("roundowner", posixOnly, () => {
  run([
    // roundowner.test.ts:37 owner rule: child A cannot write into child B's isolation worktree (path tool and bash red
    [46,"write",{"path":"/Users/r2fx/home/code/proj/src/a.ts"},"b"],
    // roundowner.test.ts:46 owner rule: a reviewer in the round worktree reads, never writes (path tool, redirect, mkd
    [46,"read",{"path":"/Users/r2fx/home/code/proj/src/a.ts"},"br"],
    [46,"bash","cat /Users/r2fx/home/code/proj/src/a.ts","r"],
    // roundowner.test.ts:57 owner rule: a builder in the round worktree writes it
    [46,"bash","echo x > /Users/r2fx/home/code/proj/src/a.ts","b"],
    // roundowner.test.ts:63 owner rule: an isolation child reads the round worktree, never writes it
    [46,"read",{"path":"/Users/r2fx/home/repo.worktrees/round/src/a.ts"},"b"],
  ]);
});

test("roundsurface", posixOnly, () => {
  run([
    // roundsurface.test.ts:96 overlay: the round worktrees and isolation worktrees of the session are every child's own 
    [46,"read",{"path":"/Users/r2fx/home/code/proj/.workflow/scratch/p.md"},"b"],
    [46,"bash","cat /Users/r2fx/home/code/proj/.workflow/scratch/p.md","b"],
  ]);
});

test("s2-child-heredoc", posixOnly, () => {
  run([
    // s2-child-heredoc.test.ts:22 reading heredocs and null redirects are not this deny
    [38,"bash","cat <<'EOF' | grep a\nabc\nEOF","b"],
    [38,"bash","cat package.json >/dev/null 2>&1","b"],
  ]);
});

test("s2-child-redirects", posixOnly, () => {
  run([
    // s2-child-redirects.test.ts:41 a reviewer's test runs with closed or null stdin pass
    [10,"bash","npm run typecheck </dev/null","r"],
    [10,"bash","npm run test:node </dev/null","r"],
    [10,"bash","python3 -m unittest discover -s tests </dev/null","r"],
    [10,"bash","npm run typecheck <&-","r"],
    [10,"bash","npm run test:node <&-","r"],
    [10,"bash","npm test <&-","r"],
    [10,"bash","python3 -m unittest discover -s tests <&-","r"],
    // s2-child-redirects.test.ts:56 redirects to /dev/null and fd dups are no write targets for a reviewer
    [10,"bash","cat f >/dev/null","r"],
    [10,"bash","cat f > /dev/null 2>&1","r"],
    [10,"bash","cat f 2>/dev/null","r"],
    [10,"bash","git log --oneline -3 2>&1","r"],
    [10,"bash","grep x f 2>&1 | head -3","r"],
    [10,"bash","cat f 1>&2","r"],
    // s2-child-redirects.test.ts:64 od, hexdump and xxd (without -r) are known readers for a reviewer; xxd -r is not
    [10,"bash","od -c f","r"],
    [10,"bash","hexdump -C f","r"],
    [10,"bash","xxd f","r"],
    [10,"bash","xxd -l 16 f","r"],
    [10,"bash","git show 3b77872 -- extensions/core-adapter/pressure.ts | head -40 | od -c","r"],
    [10,"bash","cat f | xxd | head -3","r"],
    [10,"bash","cat f | hexdump -C","r"],
  ]);
});

test("s2-main-ledger-read", posixOnly, () => {
  run([
    // s2-main-ledger-read.test.ts:35 every child role reads the main checkout's ledger and .workflow by bash
    [47,"bash","cat /Users/r2fx/home/repo/.workflow/LEDGER-x.md; git log --oneline -3","br"],
    [47,"bash","cat /Users/r2fx/home/repo/.workflow/notes.md","br"],
    [47,"bash","grep -n item /Users/r2fx/home/repo/.workflow/LEDGER-*.md","br"],
    // s2-main-ledger-read.test.ts:43 every child role reads the main checkout's ledger with the read tool
    [47,"read",{"path":"/Users/r2fx/home/repo/.workflow/LEDGER-x.md"},"br"],
    [47,"read",{"path":"/Users/r2fx/home/repo/.workflow/notes.md"},"br"],
  ]);
});

test("s2-readonly-falsepos", posixOnly, () => {
  run([
    // s2-readonly-falsepos.test.ts:32 read-only shell commands naming protected paths pass (main and child)
    [48,"bash","G=grep -rn --exclude-dir=node_modules --exclude-dir=.workflow --exclude-dir=.git","bm"],
    [48,"bash","cat config/foreman.defaults.json","m"],
    [48,"bash","python3 -c \"import json;print(list(json.load(open('config/foreman.defaults.json'))))\"","bm"],
    [48,"bash","cat package.json","m"],
  ]);
});

test("safety-followup", posixOnly, () => {
  run([
    // safety-followup.test.ts:70 remove/rename of the agent dir's parent is asked in the foreman, denied in children; reads
    [4,"bash","ls ~/.pi","bm"],
    [4,"bash","ls -la /Users/r2fx/home/.pi","bm"],
    [4,"ls",{"path":"/Users/r2fx/home/.pi"},"bm"],
  ]);
});

test("sec-fix-bound", posixOnly, () => {
  run([
    // sec-fix-bound.test.ts:72 R8: an unbound $S is the child's scratch; S=<round worktree> is not
    [49,"bash","S=$FOREMAN_SCRATCH; echo x > $S/f","r"],
  ]);
});

test("sec-fix-tilde", posixOnly, () => {
  run([
    // sec-fix-tilde.test.ts:44 G3: a pure read of the state dir passes in the ~/, $HOME/ and absolute forms
    [18,"bash","head -c 600 ~/.pi/agent/pi-foreman/state/usage/sess.jsonl; echo; wc -l ~/.pi/agent/pi-foreman/state/usage/sess.jsonl","m"],
    [18,"bash","cat ~/.pi/agent/pi-foreman/state/usage/sess.jsonl","m"],
    [18,"bash","wc -l ~/.pi/agent/pi-foreman/state/usage/sess.jsonl","m"],
    [18,"bash","head -c 600 $HOME/.pi/agent/pi-foreman/state/usage/sess.jsonl; echo; wc -l $HOME/.pi/agent/pi-foreman/state/usage/sess.jsonl","m"],
    [18,"bash","cat $HOME/.pi/agent/pi-foreman/state/usage/sess.jsonl","m"],
    [18,"bash","wc -l $HOME/.pi/agent/pi-foreman/state/usage/sess.jsonl","m"],
    [18,"bash","head -c 600 ${HOME}/.pi/agent/pi-foreman/state/usage/sess.jsonl; echo; wc -l ${HOME}/.pi/agent/pi-foreman/state/usage/sess.jsonl","m"],
    [18,"bash","cat ${HOME}/.pi/agent/pi-foreman/state/usage/sess.jsonl","m"],
    [18,"bash","wc -l ${HOME}/.pi/agent/pi-foreman/state/usage/sess.jsonl","m"],
    [18,"bash","head -c 600 /Users/r2fx/home/.pi/agent/pi-foreman/state/usage/sess.jsonl; echo; wc -l /Users/r2fx/home/.pi/agent/pi-foreman/state/usage/sess.jsonl","m"],
    [18,"bash","cat /Users/r2fx/home/.pi/agent/pi-foreman/state/usage/sess.jsonl","m"],
    [18,"bash","wc -l /Users/r2fx/home/.pi/agent/pi-foreman/state/usage/sess.jsonl","m"],
    // sec-fix-tilde.test.ts:62 G4: a child's $S / $FOREMAN_SCRATCH redirect is a scratch write; escapes stay denied
    [50,"bash","npm run typecheck > $FOREMAN_SCRATCH/typecheck.log 2>&1","r"],
  ]);
});

test("shellvars-cases", posixOnly, () => {
  run([
    // shellvars-cases.test.ts:47 R3b literal lines: cd, S=$FOREMAN_SCRATCH and a later $S operand or redirect never ask
    [24,"bash","cd /Users/r2fx/proj; S=$FOREMAN_SCRATCH; mkdir -p $S; npm test > $S/tc.txt","m"],
    [24,"bash","S=$FOREMAN_SCRATCH; mkdir -p $S; npm test > \"$S/tc.txt\"","m"],
    // shellvars-cases.test.ts:54 a heredoc line keeps its class: the $S line is decided like the same line with the literal
    [24,"bash","S=$FOREMAN_SCRATCH; python3 - \"$S/probe.test.ts\" <<EOF\nprint(1)\nEOF","bm"],
    [24,"bash","python3 - \"/Users/r2fx/scratch/probe.test.ts\" <<EOF\nprint(1)\nEOF","bm"],
  ]);
});

test("shellvars-win32-escape", posixOnly, () => {
  run([
    // shellvars-win32-escape.test.ts:73 win32: cat $H/f (an unknown $H stays as it is)
    [0,"bash","cat $H/f","b"],
    [0,"bash","H=C:/w/proj; cat $H/f","b"],
    // shellvars-win32-escape.test.ts:78 posix: H=C:\\w\\proj; cat $H/f (no win32 rule off win32)
    [51,"bash","H=C:\\w\\proj; cat $H/f","bm"],
    [51,"bash","cat $H/f","bm"],
    [51,"bash","H=C:x; cat $H/f","b"],
    // shellvars-win32-escape.test.ts:99 win32 child: echo x > C:/t/out/a and echo x > \"C:\\t\\out\\a\" keep their decision (outside th
    [0,"bash","cat C:/w/proj/f","r"],
    [0,"bash","cat 'C:\\w\\proj\\f'","r"],
    // shellvars-win32-escape.test.ts:109 win32 main: echo x > C:\\w\\proj\\a (the foreman keeps its decision)
    [0,"bash","echo x > C:\\w\\proj\\a","m"],
    [0,"bash","cat C:\\w\\proj\\f","m"],
    // shellvars-win32-escape.test.ts:114 posix child: echo x > a\\\\b and touch C:wproja (no win32 rule off win32)
    [51,"bash","echo x > a\\\\b","b"],
    [51,"bash","touch C:wproja","b"],
    [51,"bash","cat C:x","b"],
  ]);
});

test("shellvars-win32", posixOnly, () => {
  run([
    // shellvars-win32.test.ts:65 win32: H=C:/Profiles/u/.pi/agent/pi-foreman; cat $H/handoffs/s1/ruling.md
    [0,"bash","cat $H/handoffs/s1/ruling.md","b"],
    // shellvars-win32.test.ts:99 win32: S=$FOREMAN_SCRATCH; mkdir -p $S/x
    [0,"bash","S=$FOREMAN_SCRATCH; mkdir -p $S/x","bm"],
    // shellvars-win32.test.ts:160 posix: H=/home/u/.ssh; cat $H/id_rsa
    [51,"bash","S=$FOREMAN_SCRATCH; mkdir -p $S/x","bm"],
  ]);
});

test("switch-regression-win32", posixOnly, () => {
  run([
    // switch-regression-win32.test.ts:15 win32: switch words are not paths (no ask, no deny)
    [16,"bash","tool.exe /getConnectState","bm"],
    [16,"bash","tool.exe /switch","bm"],
    [16,"bash","dsregcmd /status","bm"],
    [16,"bash","ipconfig /all","bm"],
    [16,"bash","tasklist /fi \"imagename eq node.exe\"","bm"],
  ]);
});

test("win32-bashpath-shapes", posixOnly, () => {
  run([
    // win32-bashpath-shapes.test.ts:32 win32 child: ls C:/w/proj/node_modules | wc -l (row 6-11 shape, id 1168)
    [0,"bash","ls C:/w/proj/node_modules | wc -l","b"],
    // win32-bashpath-shapes.test.ts:37 win32 child: ls -la C:/Profiles/u/.pi (agent dir parent read, id 1533)
    [0,"bash","ls -la C:/Profiles/u/.pi","b"],
    // win32-bashpath-shapes.test.ts:53 win32 child: git -C C:/w/proj grep -nE \"x\" -- src (git grep -C operand, id 611)
    [0,"bash","git -C C:/w/proj grep -nE \"x\" -- src","b"],
  ]);
});

test("winpaths", posixOnly, () => {
  run([
    // winpaths.test.ts:23 win32: trailing dots and spaces in a segment do not hide a protected path
    [16,"write",{"path":"notes.\\x.txt"},"bm"],
    // winpaths.test.ts:45 win32: an 8.3 short name of a deny-path folder is denied
    [16,"read",{"path":"C:\\Profiles\\u\\DOCUME~1\\x.txt"},"bm"],
    // winpaths.test.ts:51 win32: short names elsewhere change nothing
    [16,"write",{"path":"C:\\PROGRA~1\\app\\settings.json"},"m"],
    [16,"write",{"path":"PROGRA~1\\x.txt"},"bm"],
    [16,"write",{"path":"docs\\CLAUDE~1\\settings.json"},"bm"],
    [16,"write",{"path":"C:\\Profiles\\u\\PI~1\\other.txt"},"m"],
    [16,"write",{"path":"GITHUB~1\\workflows\\ci.yml"},"bm"],
  ]);
});

test("worktree-root-consumers", posixOnly, () => {
  run([
    // worktree-root-consumers.test.ts:41 `overlay (${name} root): a child blocks sibling rounds under the root, keeps its own`
    [52,"write",{"path":"/Users/r2fx/home/code/proj/x.ts"},"b"],
  ]);
});
