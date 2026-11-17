// R41 self-modification rules (plan 2.5, ledger item 7): writes that change how Pi or pi-foreman itself runs are a dialog by rule, never
// a default and never a model verdict. The gate runs this layer after the floors and before the defaults. An owner or a session opened by another session is
// asked; a child or headless session is denied with the rule name and what to report. Targets are judged lexically and through realpath
// (a link placed in `.pi/scratch` that points at `.pi/settings.json` is the settings file), and by inode for a hard link.
import * as fs from "node:fs";
import * as path from "node:path";
import { opsOf, realDefault, realSpelling, resolveWord, under } from "./pathrules.ts";
import type { GateRoots } from "./pathrules.ts";
import type { ShellSegment } from "./shellast.ts";
import { shellWriteTargets } from "./defaults.ts";
import { shortNameSpellings, toolPath } from "./pathnorm.ts";

export interface SelfmodHit {
  rule: string;
  reason: string;
}

const HITS = {
  "selfmod-project-settings": "this writes the project's .pi/settings.json, which changes how Pi and its extensions run",
  "selfmod-project-pi": "this writes the project's .pi/ directory outside .pi/scratch and .pi/tasks, which holds Pi's project configuration",
  "selfmod-project-claude": "this writes the project's .claude/settings*.json or .mcp.json (or the .claude folder itself), which run commands as the owner",
  "selfmod-agent-settings": "this writes the Pi agent settings.json, which changes how Pi and its extensions run",
  "selfmod-state": "this writes pi-foreman session state, which other sessions and the foreman read as live data",
  "selfmod-session-dir": "this moves or removes the Pi session dir or one of its ancestors up to the agent sessions dir, which breaks the running session's file",
  "selfmod-identity": "this writes a handoff's live.json, parent or child file, the session identity files the adapter keeps",
  "selfmod-agent-harness": "this writes a harness folder or file of the Pi agent dir (extensions, npm, agents, intercom, claude-config, foreman.json, claude-bridge.json), which changes what Pi loads and runs",
  "selfmod-user-config": "this writes the user's git config or Claude folder (~/.gitconfig, ~/.config/git, $XDG_CONFIG_HOME/git, ~/.claude), which change how git and Claude run commands as the owner",
  "selfmod-agent-dir": "this removes or renames the Pi agent dir, the folder that holds it, or its pi-foreman folder, which breaks every running session",
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

/** A file name as the name tests compare it: lowercased on win32 and darwin (`under()` itself lowercases only on win32); on win32 also without an `::$DATA` suffix and trailing dots and spaces. */
function leaf(platform: string, name: string): string {
  if (platform === "win32") return name.replace(/:.*$/, "").replace(/[. ]+$/, "").toLowerCase();
  return platform === "darwin" ? name.toLowerCase() : name;
}

/** win32 drops trailing dots and spaces of a path component (`.claude.` is `.claude`); `.` and `..` stay. */
function dotFold(platform: string, p: string): string {
  if (platform !== "win32") return p;
  return p.split(/([\\/]+)/).map((s, i) => (i % 2 === 0 && s.replace(/[. ]+$/, "") !== "" ? s.replace(/[. ]+$/, "") : s)).join("");
}

/** The agent dir folders and files that change what Pi loads and runs (each directly under the agent dir, folders with everything below them). */
const AGENT_HARNESS = ["extensions", "npm", "agents", "intercom", "claude-config", "foreman.json", "claude-bridge.json"];

/** Every name the rules of `classify` compare a path segment with (the 8.3 short-name fold reads a short name as one of these). */
const RULE_NAMES = [...AGENT_HARNESS, ".pi", ".claude", ".mcp.json", "settings.json", "pi-foreman", "state", "handoffs", "sessions", "live.json", "parent", "child", ".gitconfig", ".config", "git", "scratch", "tasks"];

/** `p` is `base/<names...>` or below it (the names compared as `leaf()` spells them). */
function below(platform: string, base: string, p: string, names: string[]): boolean {
  if (!under(platform, base, p)) return false;
  const rel = (platform === "win32" ? path.win32 : path.posix).relative(base, p).split(/[\\/]/);
  return names.every((n, i) => rel[i] !== undefined && leaf(platform, rel[i]) === leaf(platform, n));
}

/** `a` is an existing regular file with more than one hard link. */
function linked(a: string): boolean {
  try {
    const s = fs.statSync(a);
    return s.isFile() && s.nlink > 1;
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
  const bases = [...new Set([r.worktree, cwd].flatMap((b) => spellings(platform, b, real)))];
  const claudes = [...new Set(bases.map((b) => x.join(b, ".claude")).flatMap((p) => spellings(platform, p, real)))];
  const mcps = [...new Set(bases.map((b) => x.join(b, ".mcp.json")).flatMap((p) => spellings(platform, p, real)))];
  const settings = [...new Set(pis.map((p) => x.join(p, "settings.json")))];
  const agent = r.agentDir ? spellings(platform, r.agentDir, real) : [];
  const agentSettings = agent.map((a) => x.join(a, "settings.json"));
  const states = agent.map((a) => x.join(a, "pi-foreman", "state"));
  const own = [...r.handoffs, ...r.scratch].flatMap((d) => spellings(platform, d, real));
  const handoffRoots = agent.map((a) => x.join(a, "pi-foreman", "handoffs"));
  // the home-based rules fire only when the roots carry the home folder
  const homes = r.home ? spellings(platform, r.home, real) : [];
  const userConfigs = [...homes.flatMap((h): [string, string[]][] => [[h, [".gitconfig"]], [h, [".config", "git"]], [h, [".claude"]]]), ...(r.configHome ? spellings(platform, r.configHome, real).map((h): [string, string[]] => [h, ["git"]]) : [])];
  const agentDirs = [...agent, ...agent.map((a) => x.dirname(a)), ...agent.map((a) => x.join(a, "pi-foreman"))];
  const sessionDirs = r.sessionDir ? sessionDirChain(platform, spellings(platform, r.sessionDir, real), agent.map((a) => x.join(a, "sessions"))) : [];
  // win32: a short-name segment (`CLAUDE~1`) that fits a name the rules below compare is also judged as that name
  // win32: a component with trailing dots or spaces is judged as the name without them, for every rule below
  const real_ = spellings(platform, abs, real).flatMap((s) => [...new Set([s, dotFold(platform, s)])]);
  for (const c of [...real_, ...real_.flatMap((s) => shortNameSpellings(platform, s, RULE_NAMES))]) {
    if (dir === "read") {
      if (r.child && states.some((s) => under(platform, s, c)) && !own.some((d) => under(platform, d, c))) return hit("selfmod-state-read");
      continue;
    }
    if (sessionDirs.includes(c)) return hit("selfmod-session-dir");
    for (const h of handoffRoots) {
      const rel = under(platform, h, c) ? x.relative(h, c).split(/[\\/]/) : [];
      if (rel.length === 2 && ["live.json", "parent", "child"].includes(leaf(platform, rel[1]))) return hit("selfmod-identity");
    }
    if (settings.includes(c)) return hit("selfmod-project-settings");
    if (agentSettings.includes(c)) return hit("selfmod-agent-settings");
    if (agent.some((a) => AGENT_HARNESS.some((n) => below(platform, a, c, [n])))) return hit("selfmod-agent-harness");
    if (userConfigs.some(([b, names]) => below(platform, b, c, names))) return hit("selfmod-user-config");
    if (agentDirs.some((d) => under(platform, d, c) && under(platform, c, d))) return hit("selfmod-agent-dir");
    for (const pi of pis) {
      if (!under(platform, pi, c)) continue;
      if (under(platform, x.join(pi, "scratch"), c) || under(platform, x.join(pi, "tasks"), c)) continue;
      return hit("selfmod-project-pi");
    }
    if (mcps.some((m) => under(platform, m, c) && under(platform, c, m)) || (leaf(platform, x.basename(c)) === ".mcp.json" && bases.some((b) => under(platform, b, x.dirname(c)) && under(platform, x.dirname(c), b)))) return hit("selfmod-project-claude");
    for (const cl of claudes) {
      if (!under(platform, cl, c)) continue;
      const rel = x.relative(cl, c).split(/[\\/]/);
      if (rel[0] === "" || (rel.length === 1 && /^settings.*\.json$/.test(leaf(platform, rel[0])))) return hit("selfmod-project-claude");
    }
    if (states.some((s) => under(platform, s, c)) && !own.some((d) => under(platform, d, c))) return hit("selfmod-state");
  }
  if (dir === "write" && linked(abs)) {
    if ([...settings, ...agentSettings].some((s) => sameFile(abs, s))) return hit(agentSettings.some((s) => sameFile(abs, s)) ? "selfmod-agent-settings" : "selfmod-project-settings");
    // the 5g files: `.mcp.json` and the existing `.claude/settings*.json` of each base (one listing of `.claude` per base)
    const claudeFiles = bases.flatMap((b) => {
      try {
        return fs.readdirSync(x.join(b, ".claude")).filter((n) => /^settings.*\.json$/.test(leaf(platform, n))).map((n) => x.join(b, ".claude", n));
      } catch {
        return [];
      }
    });
    if ([...mcps, ...claudeFiles].some((f) => sameFile(abs, f))) return hit("selfmod-project-claude");
  }
  return undefined;
}

/** The self-modification hit of a path tool call, or undefined. */
export function pathSelfmod(tool: string, input: Record<string, unknown>, cwd: string, roots: GateRoots, platform: string): SelfmodHit | undefined {
  for (const [w, dir] of opsOf(tool, input, roots.readTools) ?? []) {
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
export function shellSelfmod(lines: ShellSegment[], cwd: string, roots: GateRoots, platform: string): SelfmodHit | undefined {
  // a word that is `~` or starts `~/` names the home folder, as Pi's file tools read it (`toolPath`); the segments are copied with those words expanded
  const home = roots.home;
  const expand = (w: string): string => (home && (w === "~" || w.startsWith("~/") || (platform === "win32" && w.startsWith("~\\"))) ? (toolPath(w, cwd, home, platform) ?? w) : w);
  const segs = home ? lines.map((s) => ({ ...s, argv: s.argv.map(expand), redirects: s.redirects.map((rd) => ({ ...rd, target: expand(rd.target) })) })) : lines;
  // the named targets of the write-target code (in-place `sed -i`, `perl -i`, `dd of=` ...) join the fixed word list
  const targets = shellWriteTargets(segs, platform).filter((t) => t.named);
  for (const s of segs) {
    const at = s.cwd ?? cwd;
    for (const w of writtenWords(s)) {
      const abs = resolveWord(platform, at, w);
      const h = abs ? classify(abs, "write", cwd, roots, platform) : undefined;
      if (h) return h;
    }
    for (const t of targets) {
      if (t.seg !== s) continue;
      const h = classify(t.path, "write", cwd, roots, platform);
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
