// Round surfaces (ledger items 7c, 7e; docs/permissions.md, "Round surfaces"): what the foreman session owns for
// the length of a round, one shared set for the foreman and every child of the session:
//   - its own handoff dirs (owned.ts ownHandoffDirs),
//   - the round worktrees recorded in the session manifest (the foreman's `git worktree add`, manifest.ts), and for a
//     child inside an isolation worktree pi-subagents makes for a round (`<repo>.worktrees/worktrees/<round>/pi-worktree-*`)
//     that isolation worktree itself, never the dir as a whole (roundRoots),
//   - the ledger file bound to the session (a read root only).
// Nothing else is inherited session-wide.
import * as fs from "node:fs";
import * as path from "node:path";
import { splitChain } from "./shellchain.ts";
import { workspaceTop } from "./gitdrift.ts";
import { traceFile } from "./trace.ts";

const px = (platform: string): path.PlatformPath => (platform === "win32" ? path.win32 : path.posix);

/** The unremoved worktree entries the foreman session itself recorded (owner = the session id, never a child's). */
export function roundWorktrees(stateDir: string, sessionId: string, platform: string = process.platform): string[] {
  const sid = (sessionId || "").split("").filter((c) => /[A-Za-z0-9_-]/.test(c)).join("");
  if (!sid) return [];
  try {
    const m = JSON.parse(fs.readFileSync(path.join(stateDir, "sessions", sid, "manifest.json"), "utf8")) as { entries?: unknown };
    if (!Array.isArray(m.entries)) return [];
    const x = px(platform);
    return m.entries
      .filter((e): e is { path: string; kind: string; owner?: unknown; removed?: unknown } => !!e && typeof e === "object" && typeof (e as { path?: unknown }).path === "string")
      .filter((e) => e.kind === "worktree" && !e.removed && (e.owner === undefined || e.owner === sessionId) && x.isAbsolute(e.path))
      .map((e) => x.resolve(e.path));
  } catch {
    return [];
  }
}

/** The dir pi-subagents puts the isolation worktrees of round worktree `round` in: `<repo>.worktrees/worktrees/<round name>`. */
export function isolationDir(round: string, platform: string = process.platform): string {
  const x = px(platform);
  return x.join(x.dirname(round), "worktrees", x.basename(round));
}

/**
 * The round roots of a child whose cwd is `cwd` (ledger 7c, security fix): the round worktree the cwd lies in, or, for a
 * child in an isolation worktree under a round's isolation dir, that isolation worktree itself (its git top level).
 * Never the isolation dir as a whole, so the sibling `pi-worktree-*` of another child stays denied. `top` resolves the git
 * top level (injectable).
 */
export function roundRoots(worktrees: string[], cwd: string, platform: string = process.platform, top: (dir: string) => string | null = workspaceTop): string[] {
  const x = px(platform);
  const below = (dir: string, p: string): boolean => {
    const rel = x.relative(x.resolve(dir), x.resolve(p));
    return rel !== "" && rel !== ".." && !rel.startsWith(".." + x.sep) && !x.isAbsolute(rel);
  };
  const within = (dir: string): boolean => x.resolve(dir) === x.resolve(cwd) || below(dir, cwd);
  // ownership is the INNERMOST git worktree of the cwd, never a prefix match on the round worktree: an isolation worktree nested below a round
  // worktree (or in its isolation dir) is its own root, the round worktree is not
  const inner = worktrees.some((w) => within(w) || within(isolationDir(w, platform))) ? top(cwd) : null;
  if (inner && !worktrees.some((w) => x.resolve(w) === x.resolve(inner)) && worktrees.some((w) => below(w, inner) || below(isolationDir(w, platform), inner))) return [x.resolve(inner)];
  const round = worktrees.find((w) => within(w));
  if (round) return [x.resolve(round)];
  for (const w of worktrees) {
    const iso = isolationDir(w, platform);
    if (!within(iso)) continue;
    const own = top(cwd);
    return own && below(iso, own) ? [x.resolve(own)] : [];
  }
  return [];
}

/**
 * The roots a child of `role` gets on the round surfaces (owner ruling, ledger 7c): `write` are its write roots (its own
 * isolation worktree, and the round worktree only for a `builder` child whose cwd lies in it); `read` are the round
 * worktrees it may read but not write (every other role in the round worktree, and any child in an isolation worktree of that round).
 */
export function childSurface(worktrees: string[], cwd: string, role: string | undefined, platform: string = process.platform, top: (dir: string) => string | null = workspaceTop): { write: string[]; read: string[] } {
  const x = px(platform);
  const within = (dir: string): boolean => {
    const rel = x.relative(x.resolve(dir), x.resolve(cwd));
    return rel === "" || (rel !== ".." && !rel.startsWith(".." + x.sep) && !x.isAbsolute(rel));
  };
  const roots = roundRoots(worktrees, cwd, platform, top);
  const rounds = worktrees.map((w) => x.resolve(w));
  const read = rounds.filter((w) => within(w) || within(isolationDir(w, platform)));
  return { write: role === "builder" ? roots : roots.filter((r) => !rounds.includes(r)), read };
}

/**
 * The path patterns a child may READ although the child block names them (permoverlay.ts `MatchCtx.readable`): the ledger bound to the session and
 * its `LEDGER-*.md` siblings, the session's own handoff dirs and its round worktrees, each dir with its subtree. Writes stay closed.
 */
export function childReadable(ledger: string | null, handoffDirs: string[], worktrees: string[], platform: string = process.platform): string[] {
  const x = px(platform);
  const dirs = [...handoffDirs, ...worktrees].map((d) => x.resolve(d));
  return [...(ledger ? [x.resolve(ledger), x.join(x.dirname(x.resolve(ledger)), "LEDGER-*.md")] : []), ...dirs.flatMap((d) => [d, `${d}/*`])];
}

/**
 * Read patterns for the session's own `bg_run` task dirs: `<root>/.pi/tasks/<session id>-*` (the add-on writes `<session>-<pid>/`) and everything below, for each
 * workspace/cwd root. The id is cut to `[A-Za-z0-9_-]`, so another session's dir (`<other id>-<pid>`) never matches; no id, no patterns.
 */
export function ownTaskReadable(roots: string[], sessionId: string, platform: string = process.platform): string[] {
  const x = px(platform);
  const sid = (sessionId || "").split("").filter((c) => /[A-Za-z0-9_-]/.test(c)).join("");
  if (!sid) return [];
  return [...new Set(roots.filter((r) => x.isAbsolute(r)).map((r) => x.resolve(r)))].map((r) => `${x.join(r, ".pi", "tasks")}/${sid}-*`);
}

/**
 * Read patterns for `<root>/.pi/scratch` and everything below, for each absolute workspace/cwd root (R10 item 2): the session's (and a child's, in
 * its own worktree) log copies there are readable by a strictly read-only shell command through `MatchCtx.ownTasks`, although the protect rule
 * `{cwd}/.pi/*` covers `.pi`; the rest of `.pi` and every write stay protected.
 */
export function piScratchReadable(roots: string[], platform: string = process.platform): string[] {
  const x = px(platform);
  return [...new Set(roots.filter((r) => x.isAbsolute(r)).map((r) => x.resolve(r)))].flatMap((r) => { const d = x.join(r, ".pi", "scratch"); return [d, `${d}/*`]; });
}

/**
 * Exact read patterns for Pi's truncated bash output logs (`pi-bash-<hex>.log`, a bash `tool_result`'s `details.fullOutputPath`) the session recorded (R13 item 5):
 * a strictly read-only shell command of that session may name them through `MatchCtx.ownTasks`. Only absolute paths of that shape, no `..` or glob character.
 */
export function bashOutputLogs(paths: Iterable<string>, platform: string = process.platform): string[] {
  const x = px(platform);
  const out: string[] = [];
  for (const p of paths) {
    if (typeof p !== "string" || !x.isAbsolute(p) || /[*?[\]{}\n]/.test(p) || p.split(/[\\/]/).includes("..")) continue;
    if (/^pi-bash-[0-9a-f]+\.log$/.test(x.basename(p))) out.push(x.normalize(p));
  }
  return [...new Set(out)];
}

/** At most this many recorded bash output log spellings per session; the oldest is evicted. */
const MAX_BASH_LOGS = 50;

/**
 * Record a bash `tool_result`'s `details.fullOutputPath` (and its realpath spelling) into `logs`, newest kept (R13 item 5).
 * Only that structured field counts: the result text is the command's own output and can carry a forged `Full output:` line.
 */
export function recordBashOutputLog(logs: Set<string>, details: unknown, platform: string = process.platform): void {
  const given = details && typeof details === "object" ? (details as Record<string, unknown>).fullOutputPath : undefined;
  if (typeof given !== "string") return;
  for (const q of bashOutputLogs([given], platform)) {
    const spellings = [q];
    try {
      spellings.push(fs.realpathSync.native(q));
    } catch {
      // not there: the given spelling only
    }
    for (const p of spellings) {
      logs.delete(p);
      logs.add(p);
      if (logs.size > MAX_BASH_LOGS) logs.delete(logs.values().next().value as string);
    }
  }
}

/**
 * Read patterns for the foreman's own state records (R10 item 1, R12 item 2, R14 item 1): `<agentDir>/pi-foreman/state/usage` and everything below,
 * the session's own presence file `state/live/<session>.json` and its own trace file (trace.ts traceFile: `trace.dir` when set, else the state
 * dir). A read-only shell command of the foreman (permoverlay.ts ownRead: ls/cat/head/tail/wc/stat, the python/node read forms, ownReadChain)
 * may name them although the protect rule `{agentDir}/pi-foreman/state/*` covers state/; a write there and another session's files stay
 * protected. Never given to a child.
 */
export function ownUsageReadable(agentDir: string, platform: string = process.platform, sessionId?: string, trace?: { dir: unknown; stateDir: string }): string[] {
  const x = px(platform);
  if (!agentDir || !x.isAbsolute(agentDir)) return [];
  const d = x.join(x.resolve(agentDir), "pi-foreman", "state", "usage");
  const sid = sessionId && /^[A-Za-z0-9_.-]+$/.test(sessionId) && !sessionId.startsWith(".") ? sessionId : "";
  // R12 item 2: and the session's own presence file state/live/<session>.json (livestate.ts), never another session's
  const live = sid ? [x.join(x.resolve(agentDir), "pi-foreman", "state", "live", `${sid}.json`)] : [];
  // R14 item 1: and its own trace file, by the name the trace writer uses; a glob character in it would widen the pattern
  const tf = sid && trace?.stateDir ? traceFile(trace.dir, trace.stateDir, sid) : "";
  const own = tf && x.isAbsolute(tf) && !/[*?[\]{}]/.test(tf) ? [tf] : [];
  return [d, `${d}/*`, ...live, ...own];
}

/**
 * The main checkout's `.workflow` dir of each round worktree `<repo>.worktrees/<round>`, with its subtree: the round's own ledger and its notes
 * live there, so it is a READ root for every child role of the round (R1). Nothing else of the main checkout, and no write.
 */
export function mainWorkflowReadable(worktrees: string[], platform: string = process.platform): string[] {
  const x = px(platform);
  const out: string[] = [];
  for (const w of worktrees) {
    const home = x.dirname(x.resolve(w));
    const name = x.basename(home);
    if (!name.endsWith(".worktrees") || name === ".worktrees") continue;
    const flow = x.join(x.dirname(home), name.slice(0, -".worktrees".length), ".workflow");
    out.push(flow, `${flow}/*`);
  }
  return [...new Set(out)];
}

/**
 * The foreman's own subagent run dirs, from the files recorded for its child runs: `<tmp>/pi-subagents-uid-<uid>/async-subagent-runs/<run>` for each
 * run seen, plus that uid dir's `async-subagent-results`. A READ root for the foreman session (k); files elsewhere add nothing.
 */
export function asyncRunDirs(files: Iterable<string>, platform: string = process.platform): string[] {
  const x = px(platform);
  const out = new Set<string>();
  for (const f of files) {
    const m = /^(.*[\\/]pi-subagents-uid-[^\\/]+)[\\/]async-subagent-(?:runs|results)(?:[\\/]([^\\/]+))?/.exec(f);
    if (!m || !x.isAbsolute(m[1])) continue;
    // only the results of runs this session saw (`results/<run>.json`), never the whole results dir of the uid
    const run = m[2]?.replace(/\.json$/, "");
    if (!run || m[2] === "." || m[2] === ".." || run === "." || run === "..") continue;
    out.add(x.join(m[1], "async-subagent-results", `${run}.json`));
    if (/async-subagent-runs/.test(f)) out.add(x.join(m[1], "async-subagent-runs", run));
  }
  return [...out];
}

/**
 * Every root the foreman session owns for reads and writes, listed in the permission reviewer's prompt (review.ts): its live child scratch dirs, the
 * round worktrees and their isolation dirs, its handoff dirs, the global npm root, `state/scratch/<session>` and the async run dirs of its own child runs.
 */
export function sessionOwnedRoots(i: { scratch: string[]; rounds: string[]; handoffs: string[]; npmRoot?: string | null; stateScratch?: string | null; asyncRuns?: Iterable<string> }, platform: string = process.platform): string[] {
  const x = px(platform);
  const all = [...i.scratch, ...i.rounds, ...i.rounds.map((r) => isolationDir(r, platform)), ...i.handoffs, ...(i.npmRoot ? [i.npmRoot] : []), ...(i.stateScratch ? [i.stateScratch] : []), ...(i.asyncRuns ?? [])];
  return [...new Set(all.filter((p) => x.isAbsolute(p)).map((p) => x.resolve(p)))];
}

/**
 * The owned roots split by what a child may do there (the permission reviewer's prompt and owned-roots allow): `write` are read-write (child scratch dirs,
 * round and isolation worktrees, handoff dirs, `state/scratch/<session>`), `read` are read only (the global npm root, the async run dirs of the session's own child runs).
 */
export function sessionOwnedSplit(i: { scratch: string[]; rounds: string[]; handoffs: string[]; npmRoot?: string | null; stateScratch?: string | null; asyncRuns?: Iterable<string>; hubFlow?: string[] }, platform: string = process.platform): { write: string[]; read: string[] } {
  const x = px(platform);
  const norm = (all: string[]): string[] => [...new Set(all.filter((p) => x.isAbsolute(p)).map((p) => x.resolve(p)))];
  const write = norm([...i.scratch, ...i.rounds, ...i.rounds.map((r) => isolationDir(r, platform)), ...i.handoffs, ...(i.stateScratch ? [i.stateScratch] : [])]);
  return { write, read: norm([...(i.npmRoot ? [i.npmRoot] : []), ...(i.asyncRuns ?? []), ...(i.hubFlow ?? [])]).filter((p) => !write.includes(p)) };
}

/**
 * `paths.hubWorkflow` (a string or a list of absolute dirs) as the `.workflow` dir of each hub: the hub's ledger family, a READ root for the foreman and
 * its children (never a write). Relative entries, `..` components and a filesystem root are dropped; empty by default.
 */
export function hubWorkflowDirs(value: unknown, platform: string = process.platform): string[] {
  const x = px(platform);
  const list = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
  const out: string[] = [];
  for (const v of list) {
    if (typeof v !== "string" || !x.isAbsolute(v) || v.split(/[\\/]/).includes("..")) continue;
    const d = x.resolve(v);
    if (d === x.parse(d).root) continue;
    out.push(x.join(d, ".workflow"));
  }
  return [...new Set(out)];
}

/** The read patterns of hubWorkflowDirs: the dir and its subtree. */
export function hubWorkflowReadable(value: unknown, platform: string = process.platform): string[] {
  return hubWorkflowDirs(value, platform).flatMap((d) => [d, `${d}/*`]);
}

const PLAIN = /^[A-Za-z0-9_./@+=,:%-]+$/;

/**
 * The target of the foreman's `git [-C <dir>] worktree add [-b|-B <branch>] <path> [<commit-ish>]` when it is the
 * whole line and `<path>` is a direct child of `<repo>.worktrees` beside the repository, else null. No other option,
 * no redirect, no `$`/`~`/`..` inside a word beyond the leading `../`. `repoTop` resolves the git top level (injectable).
 */
export function roundWorktreeAdd(command: string, cwd: string, platform: string = process.platform, repoTop: (dir: string) => string | null = workspaceTop): string | null {
  const chain = splitChain(command);
  if (!chain || chain.segments.length !== 1) return null;
  const seg = chain.segments[0];
  if (seg.redirects.length) return null;
  const w = seg.words;
  const x = px(platform);
  let k = 0;
  if (w[k++] !== "git") return null;
  let gitDir = x.resolve(cwd);
  if (w[k] === "-C") {
    if (!w[k + 1] || !PLAIN.test(w[k + 1])) return null;
    gitDir = x.resolve(gitDir, w[k + 1]);
    k += 2;
  }
  if (w[k] !== "worktree" || w[k + 1] !== "add") return null;
  const args = w.slice(k + 2);
  const pos: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-b" || a === "-B") {
      const b = args[++i];
      if (!b || b.startsWith("-") || !PLAIN.test(b) || b.includes("..")) return null;
    } else if (a.startsWith("-") || !PLAIN.test(a)) return null;
    else pos.push(a);
  }
  if (pos.length < 1 || pos.length > 2) return null;
  const rest = pos[0].replace(/^(\.\.\/)+/, "");
  if (rest.split("/").includes("..") || rest === "" || pos[1]?.includes("..")) return null;
  const target = x.resolve(gitDir, pos[0]);
  const top = repoTop(gitDir);
  if (!top) return null;
  const home = x.join(x.dirname(x.resolve(top)), `${x.basename(x.resolve(top))}.worktrees`);
  return x.dirname(target) === home && x.basename(target) !== "" ? target : null;
}
