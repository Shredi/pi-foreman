// R41 self-modification rules (plan 2.5, ledger item 7): writes that change how Pi or pi-foreman itself runs are a dialog by rule, never
// a default and never a model verdict. The gate runs this layer after the floors and before the defaults. An owner or round session is
// asked; a child or headless session is denied with the rule name and what to report. Targets are judged lexically and through realpath
// (a link placed in `.pi/scratch` that points at `.pi/settings.json` is the settings file), and by inode for a hard link.
import * as fs from "node:fs";
import * as path from "node:path";
import { opsOf, realDefault, realSpelling, resolveWord, under } from "./pathrules.ts";
import type { GateRoots } from "./pathrules.ts";
import type { ShellSegment } from "./shellast.ts";

export interface SelfmodHit {
  rule: string;
  reason: string;
}

const HITS = {
  "selfmod-project-settings": "this writes the project's .pi/settings.json, which changes how Pi and its extensions run",
  "selfmod-project-pi": "this writes the project's .pi/ directory outside .pi/scratch and .pi/tasks, which holds Pi's project configuration",
  "selfmod-agent-settings": "this writes the Pi agent settings.json, which changes how Pi and its extensions run",
  "selfmod-state": "this writes pi-foreman session state, which other sessions and the foreman read as live data",
  "selfmod-session-dir": "this moves or removes the Pi session dir or one of its ancestors up to the agent sessions dir, which breaks the running session's file",
  "selfmod-identity": "this writes a handoff's live.json, the session identity file the adapter keeps",
  "selfmod-state-read": "this reads pi-foreman session state of other sessions, which a child does not read",
} as const;
type SelfmodRule = keyof typeof HITS;
const hit = (rule: SelfmodRule): SelfmodHit => ({ rule, reason: HITS[rule] });

type Dir = "read" | "write";

/** `a` and its realpath spelling when that differs. */
function spellings(platform: string, a: string, real: (p: string) => string | null): string[] {
  const r = realSpelling(platform, a, real);
  return r === a ? [a] : [a, r];
}

function sameFile(a: string, b: string): boolean {
  try {
    const sa = fs.statSync(a);
    const sb = fs.statSync(b);
    return sa.isFile() && sa.nlink > 1 && sa.ino === sb.ino && sa.dev === sb.dev;
  } catch {
    return false;
  }
}

/** The session dir and each ancestor up to a sessions dir (inclusive); only the dir itself when it lies elsewhere. */
function sessionDirChain(platform: string, dirs: string[], stops: string[]): string[] {
  const x = platform === "win32" ? path.win32 : path.posix;
  const out = new Set(dirs);
  for (const d of dirs) {
    for (const stop of stops) {
      if (!under(platform, stop, d)) continue;
      for (let p = d; p !== stop && p !== x.dirname(p);) out.add((p = x.dirname(p)));
    }
  }
  return [...out];
}

function classify(abs: string, dir: Dir, cwd: string, r: GateRoots, platform: string): SelfmodHit | undefined {
  const real = r.realpath ?? (platform === process.platform ? realDefault : () => null);
  const x = platform === "win32" ? path.win32 : path.posix;
  const pis = [...new Set([r.worktree, cwd].flatMap((b) => spellings(platform, b, real)).map((b) => x.join(b, ".pi")).flatMap((p) => spellings(platform, p, real)))];
  const settings = [...new Set(pis.map((p) => x.join(p, "settings.json")))];
  const agent = r.agentDir ? spellings(platform, r.agentDir, real) : [];
  const agentSettings = agent.map((a) => x.join(a, "settings.json"));
  const states = agent.map((a) => x.join(a, "pi-foreman", "state"));
  const own = [...r.handoffs, ...r.scratch].flatMap((d) => spellings(platform, d, real));
  const handoffRoots = agent.map((a) => x.join(a, "pi-foreman", "handoffs"));
  const sessionDirs = r.sessionDir ? sessionDirChain(platform, spellings(platform, r.sessionDir, real), agent.map((a) => x.join(a, "sessions"))) : [];
  for (const c of spellings(platform, abs, real)) {
    if (dir === "read") {
      if (r.child && states.some((s) => under(platform, s, c)) && !own.some((d) => under(platform, d, c))) return hit("selfmod-state-read");
      continue;
    }
    if (sessionDirs.includes(c)) return hit("selfmod-session-dir");
    for (const h of handoffRoots) {
      const rel = under(platform, h, c) ? x.relative(h, c).split(/[\\/]/) : [];
      if (rel.length === 2 && rel[1] === "live.json") return hit("selfmod-identity");
    }
    if (settings.includes(c)) return hit("selfmod-project-settings");
    if (agentSettings.includes(c)) return hit("selfmod-agent-settings");
    for (const pi of pis) {
      if (!under(platform, pi, c)) continue;
      if (under(platform, x.join(pi, "scratch"), c) || under(platform, x.join(pi, "tasks"), c)) continue;
      return hit("selfmod-project-pi");
    }
    if (states.some((s) => under(platform, s, c)) && !own.some((d) => under(platform, d, c))) return hit("selfmod-state");
  }
  if (dir === "write" && [...settings, ...agentSettings].some((s) => sameFile(abs, s))) {
    return hit(agentSettings.some((s) => sameFile(abs, s)) ? "selfmod-agent-settings" : "selfmod-project-settings");
  }
  return undefined;
}

/** The self-modification hit of a path tool call, or undefined. */
export function pathSelfmod(tool: string, input: Record<string, unknown>, cwd: string, roots: GateRoots, platform: string): SelfmodHit | undefined {
  for (const [w, dir] of opsOf(tool, input) ?? []) {
    const abs = resolveWord(platform, cwd, w);
    const h = abs ? classify(abs, dir, cwd, roots, platform) : undefined;
    if (h) return h;
  }
  return undefined;
}

const isOpt = (w: string): boolean => w.length > 1 && w.startsWith("-");
const ALL_OPERANDS = new Set(["mv", "rm", "tee", "touch", "truncate", "rmdir", "unlink", "shred"]);
const DEST_LAST = new Set(["cp", "install", "ln"]);

/** The words a shell segment writes: redirect targets, and the destination (for `ln` also the source) operands of cp, mv, rm, ln ... */
function writtenWords(s: ShellSegment): string[] {
  const out = s.redirects.filter((rd) => rd.op !== "<" && rd.op !== "dup").map((rd) => rd.target);
  const operands = s.argv.filter((w) => !isOpt(w));
  if (ALL_OPERANDS.has(s.program)) out.push(...operands);
  else if (DEST_LAST.has(s.program)) {
    const t = s.argv.findIndex((w) => w === "-t" || w === "--target-directory");
    const tv = t >= 0 ? s.argv[t + 1] : s.argv.find((w) => w.startsWith("--target-directory="))?.slice("--target-directory=".length);
    if (tv) out.push(tv);
    else if (operands.length) out.push(operands[operands.length - 1]);
    if (s.program === "ln") out.push(...operands);
  }
  return out;
}

/** The self-modification hit of a shell line, or undefined. A child also hits on any word that names another session's state. */
export function shellSelfmod(segs: ShellSegment[], cwd: string, roots: GateRoots, platform: string): SelfmodHit | undefined {
  for (const s of segs) {
    const at = s.cwd ?? cwd;
    for (const w of writtenWords(s)) {
      const abs = resolveWord(platform, at, w);
      const h = abs ? classify(abs, "write", cwd, roots, platform) : undefined;
      if (h) return h;
    }
    if (roots.child) {
      for (const w of [s.program, ...s.argv, ...s.redirects.map((rd) => rd.target)]) {
        const abs = resolveWord(platform, at, w);
        const h = abs ? classify(abs, "read", cwd, roots, platform) : undefined;
        if (h) return h;
      }
    }
  }
  return undefined;
}
