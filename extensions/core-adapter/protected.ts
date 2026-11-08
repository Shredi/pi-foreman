// Protected targets (permissions.json `protected`): hosts, paths and commands the owner wants a context-aware check for instead of a blanket ask.
// `matchProtected` finds the entries a call touches and the effect class of what it would do (every local segment, and for `ssh <host> <cmd>` the
// remote command too); `acceptProtected` decides whether a model's verdict on the call may stand. Everything fails closed: anything not modelled
// here (an opaque segment, a command-running ssh option, an unparsable remote command) is `opaque` and never allows. Reuses effects.ts classes,
// shellast.ts segments and rules.ts path globs; not related to the `Protected` type of floors.ts.
import * as path from "node:path";
import { toChain } from "./defaults.ts";
import { segmentEffect } from "./effects.ts";
import type { EffectClass, EffectCtx } from "./effects.ts";
import { wildMatch } from "./glob.ts";
import type { ProtectedEntry } from "./permconfig.ts";
import { pathGlobMatch } from "./rules.ts";
import type { RuleCall, RuleEnv } from "./rules.ts";
import { parseShell } from "./shellast.ts";
import type { ShellSegment } from "./shellast.ts";

export type ProtectedTarget = ProtectedEntry;

export interface ProtectedMatch {
  /** The entries the call touches, in entry order. */
  entries: ProtectedEntry[];
  /** The effect class of EVERY local segment (not only the worst), plus `write-out` for a host match other than `ssh <host> <cmd>` and for path tools. */
  classes: EffectClass[];
  /** The classes of the remote command of `ssh <host> <cmd>`. */
  remoteClasses: EffectClass[];
  /** A local segment of the line could not be stated exactly. */
  opaque: boolean;
  /** The remote command could not be parsed or holds an opaque segment, or a command-running option / no remote command was seen. */
  remoteOpaque: boolean;
  /** `host`, `path`, `command` kinds of the matched entries (distinct). */
  kinds: string[];
}

export interface ProtectedEnv extends RuleEnv {
  /** The effect context of the call (shell lines only). */
  ec?: EffectCtx;
}

export interface ProtectedFacts {
  classes: EffectClass[];
  remoteClasses: EffectClass[];
  opaque: boolean;
  remoteOpaque: boolean;
  /** The owner is away: only a read-only verdict allows. */
  away: boolean;
  /** `model`: the model may allow a write; `read-only`: only a read-only verdict allows; `ask`: always the owner. */
  mode: "model" | "read-only" | "ask";
  /** A deny entry (a classifier.deny sentence; permissions deny rules never count here) exists for the verdict's entry. */
  denyEntryExists: boolean;
}

export interface ProtectedVerdict {
  verdict: "allow" | "ask" | "deny";
  effect: "read" | "write" | "deploy" | "network" | "unknown";
  confidence: "high" | "low";
  entry: string | null;
}

/** Classes that a read-only verdict must not coexist with, locally or remotely. */
const WRITING: ReadonlySet<EffectClass> = new Set(["write-in", "write-out", "build-test"]);

/** What a model verdict may do: the plan's table (see docs/permissions.md). Never `allow` without a high-confidence verdict on a fully modelled call. */
export function acceptProtected(v: ProtectedVerdict, f: ProtectedFacts): "allow" | "ask" | "deny" {
  if (f.mode === "ask") return "ask";
  if (f.classes.length === 0) return "ask";
  const modelled = !f.opaque && !f.remoteOpaque;
  if (v.verdict === "allow" && v.confidence === "high" && modelled) {
    if (v.effect === "read") return [...f.classes, ...f.remoteClasses].some((c) => WRITING.has(c)) ? "ask" : "allow";
    if ((v.effect === "write" || v.effect === "deploy" || v.effect === "network") && f.mode === "model" && !f.away) return "allow";
    return "ask";
  }
  if (v.verdict === "deny" && f.denyEntryExists) return "deny";
  return "ask";
}

/** The owner counts as away unless a fresh `present` sample exists (no sample, unknown, away or older than `awayAfterMinutes` all mean away). */
export function sampleAway(sample: { outcome: string; at: number } | null, presenceAway: boolean, awayAfterMinutes: number, now: number): boolean {
  return !sample || sample.outcome !== "present" || presenceAway || now - sample.at > awayAfterMinutes * 60_000;
}

// ------------------------------------------------------------------ matching

const SSH_ARG = new Set(["p", "i", "J", "l", "o", "F", "e", "S", "P", "b", "c", "D", "L", "R", "W", "w", "E", "I", "m", "O", "Q", "B"]);
const CMD_OPTION = /^(?:proxycommand|localcommand|remotecommand)(?:[=\s]|$)/i;
const SHELL_PROGS = new Set(["ssh", "scp", "sftp", "rsync"]);
const URL_HOST = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/\s]*@)?(\[[^\]]+\]|[^:/?#\s]+)/i;
const REMOTE_HOST = /^(?:[^@/\s]+@)?(\[[^\]]+\]|[^:/\s]+):/;

const baseName = (p: string): string => p.replace(/^.*[\\/]/, "");
const stripUser = (w: string): string => w.replace(/^[^@/\s]*@/, "");

/** The host of a URL or `[user@]host:path` operand, or null. */
function operandHost(w: string): string | null {
  const u = URL_HOST.exec(w);
  if (u) return u[1];
  const r = REMOTE_HOST.exec(w);
  return r && r[1].length > 1 ? r[1] : null;
}

interface RemoteView {
  hosts: string[];
  opaque: boolean;
  /** ssh: the argv after the host (the remote command), or null when there is none; set only for `ssh <host> ...`. */
  remote: string[] | null;
}

/** The remote operands of ssh / scp / sftp / rsync and whether an option can run a local command. */
function remoteView(prog: string, argv: string[]): RemoteView {
  if (prog === "ssh") return sshView(argv);
  const out: RemoteView = { hosts: [], opaque: false, remote: null };
  let sawHost = false;
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--") {
      for (const o of argv.slice(i + 1)) out.hosts.push(...hostsOfOperand(prog, o));
      break;
    }
    if (prog === "rsync") {
      if (t.startsWith("--")) {
        if (/^--rsh(?:=|$)/.test(t)) out.opaque = true;
        continue;
      }
      if (t.startsWith("-") && t.length > 1) {
        if (t.includes("e")) out.opaque = true;
        continue;
      }
      out.hosts.push(...hostsOfOperand(prog, t));
      continue;
    }
    if (t.startsWith("-") && t.length > 1) {
      const letter = t[1];
      if (!SSH_ARG.has(letter)) continue;
      const value = t.length > 2 ? t.slice(2) : (argv[++i] ?? "");
      if (letter === "F" || (letter === "S" && prog === "scp")) out.opaque = true;
      else if (letter === "o" && CMD_OPTION.test(value.trim())) out.opaque = true;
      else if (letter === "J") for (const j of value.split(",")) if (j) out.hosts.push(stripUser(j).replace(/:\d+$/, ""));
      continue;
    }
    out.hosts.push(...hostsOfOperand(prog, t, !sawHost));
    sawHost = true;
  }
  return out;
}

/** ssh: getopt-style option words before AND after the host (OpenSSH re-parses options after the host) until the first non-option word. */
function sshView(argv: string[]): RemoteView {
  const out: RemoteView = { hosts: [], opaque: false, remote: null };
  const setHost = (t: string): void => {
    const m = /^ssh:\/\/(?:[^@/\s]*@)?(\[[^\]]+\]|[^:/?#\s]+)/i.exec(t);
    out.hosts.push(m ? m[1] : stripUser(t));
    out.remote = [];
  };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--") {
      if (out.remote === null) {
        if (i + 1 < argv.length) setHost(argv[i + 1]);
        out.remote = argv.slice(i + 2);
      } else out.remote = argv.slice(i + 1);
      break;
    }
    if (t.startsWith("-") && t.length > 1) {
      for (let k = 1; k < t.length; k++) {
        const letter = t[k];
        if (!SSH_ARG.has(letter)) continue;
        const value = k + 1 < t.length ? t.slice(k + 1) : (argv[++i] ?? "");
        if (letter === "F") out.opaque = true;
        else if (letter === "o" && CMD_OPTION.test(value.trim())) out.opaque = true;
        else if (letter === "J") for (const j of value.split(",")) if (j) out.hosts.push(stripUser(j).replace(/:\d+$/, ""));
        break;
      }
      continue;
    }
    if (out.remote !== null) {
      out.remote = argv.slice(i);
      break;
    }
    setHost(t);
  }
  return out;
}

/** The hosts one scp / sftp / rsync operand names; the first operand of sftp is the host itself. */
function hostsOfOperand(prog: string, w: string, first = false): string[] {
  const h = operandHost(w);
  if (h) return [h];
  return prog === "sftp" && first ? [stripUser(w)] : [];
}

/** The URL hosts of a curl / wget segment (also bare `host/path` words). */
function urlHosts(argv: string[]): string[] {
  const out: string[] = [];
  for (const w of argv) {
    const v = w.startsWith("--url=") ? w.slice(6) : w;
    if (v.startsWith("-")) continue;
    const u = URL_HOST.exec(v);
    if (u) out.push(u[1]);
    else if (/^[A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z]{2,}(?::\d+)?(?:\/|$)/.test(v)) out.push(v.replace(/[:/].*$/, ""));
  }
  return out;
}

const hostMatch = (glob: string, host: string): boolean => wildMatch(glob.replace(/\.$/, ""), host.replace(/^\[|\]$/g, "").replace(/\.$/, ""), true);

interface PathCtx {
  env: ProtectedEnv;
}

/** Resolve a word against `cwd` (`~/` is the home dir); null for a word that cannot be a path (a variable survives only in an opaque segment). */
function resolveAbs(env: ProtectedEnv, cwd: string | null, w: string): string | null {
  if (w === "" || w.includes("\0")) return null;
  const x = env.platform === "win32" ? path.win32 : path.posix;
  const e = w === "~" || w.startsWith("~/") || w.startsWith("~\\") ? x.join(env.home, w.slice(1)) : w;
  return x.resolve(cwd ?? env.cwd, e);
}

const pathMatches = (c: PathCtx, glob: string, cwd: string | null, w: string): boolean => {
  const abs = resolveAbs(c.env, cwd, w);
  return abs !== null && pathGlobMatch(glob, abs, c.env);
};

/** The path operands of a segment: every non-option word (also the value of `--opt=value`) and every output redirect target. */
function pathWords(seg: ShellSegment): string[] {
  const out: string[] = [];
  for (const w of seg.argv) {
    if (w.startsWith("--") && w.includes("=")) out.push(w.slice(w.indexOf("=") + 1));
    else if (!w.startsWith("-")) out.push(w);
  }
  for (const r of seg.redirects) if (r.op !== "<" && r.op !== "dup") out.push(r.target);
  return out;
}

const PATH_LIKE = /[\\/]|^\.|^~/;

const WRITE_PATH_TOOLS: ReadonlySet<string> = new Set(["write", "edit", "foreman_move", "foreman_copy"]);

/** Classify one remote command: each of its segments; a parse failure or an opaque segment makes it opaque. */
function remoteClasses(argv: string[], env: ProtectedEnv): { classes: EffectClass[]; opaque: boolean } {
  if (argv.length === 0 || !env.ec) return { classes: [], opaque: true };
  const segs = parseShell(argv.join(" "), { cwd: env.ec.cwd, platform: env.platform });
  const classes: EffectClass[] = [];
  let opaque = segs.length === 0;
  for (const s of segs) {
    if (s.opaque !== null) {
      opaque = true;
      classes.push("unknown");
      continue;
    }
    classes.push(segClass(env, s, null));
  }
  return { classes, opaque };
}

function segClass(env: ProtectedEnv, s: ShellSegment, cwd: string | null): EffectClass {
  if (s.program === "") return s.argv.length === 0 && s.redirects.length === 0 ? "read" : "unknown";
  const chain = toChain(s);
  if (!chain || !env.ec || s.opaque !== null) return "unknown";
  try {
    return segmentEffect(env.ec, cwd ?? env.ec.cwd, chain).cls;
  } catch {
    return "unknown";
  }
}

/**
 * The protected entries `call` touches (null: none). `segments` are the parsed segments of a shell tool's line. A read-class segment never matches a host
 * or path entry (listing a protected file is not touching it); a command entry matches the program of any segment. Opaque segments are matched on their
 * raw words and flag the match opaque.
 */
export function matchProtected(call: RuleCall, segments: ShellSegment[] | undefined, entries: ProtectedEntry[], env: ProtectedEnv): ProtectedMatch | null {
  if (entries.length === 0) return null;
  const hit = new Set<ProtectedEntry>();
  const classes: EffectClass[] = [];
  const remote: EffectClass[] = [];
  let opaque = false;
  let remoteOpaque = false;
  const c: PathCtx = { env };
  const add = (e: ProtectedEntry): void => void hit.add(e);
  const byKind = (k: ProtectedEntry["kind"]): ProtectedEntry[] => entries.filter((e) => e.kind === k);

  if (segments) {
    for (const s of segments) {
      const cwd = s.cwd;
      const prog = baseName(s.program);
      const cls = segClass(env, s, cwd);
      classes.push(s.opaque !== null ? "unknown" : cls);
      const reading = cls === "read" || cls === "net-read";
      if (s.opaque !== null) {
        // the raw words decide: a host or command glob over any word, a path glob over the path-like ones
        const words = [s.program, ...s.argv, ...s.redirects.map((r) => r.target)].filter((w) => w !== "");
        for (const e of entries) {
          const m =
            e.kind === "command" ? words.some((w) => wildMatch(e.glob, baseName(w))) :
            e.kind === "host" ? words.some((w) => hostMatch(e.glob, operandHost(w) ?? stripUser(w)) || hostMatch(e.glob, stripUser(w).replace(/[:/].*$/, ""))) :
            words.some((w) => PATH_LIKE.test(w) && pathMatches(c, e.glob, cwd, w));
          if (m) add(e);
        }
        continue;
      }
      for (const e of byKind("command")) if (prog !== "" && wildMatch(e.glob, prog)) add(e);
      if (!reading) {
        for (const e of byKind("path")) if (pathWords(s).some((w) => pathMatches(c, e.glob, cwd, w))) add(e);
      }
      // hosts
      let hosts: string[] = [];
      let hostOpaque = false;
      let sshCmd: string[] | null = null;
      if (SHELL_PROGS.has(prog)) {
        const v = remoteView(prog, s.argv);
        hosts = v.hosts;
        hostOpaque = v.opaque;
        sshCmd = prog === "ssh" ? v.remote : null;
      } else if ((prog === "curl" || prog === "wget") && cls !== "net-read") hosts = urlHosts(s.argv);
      const matched = byKind("host").filter((e) => hosts.some((h) => hostMatch(e.glob, h)));
      if (matched.length) {
        for (const e of matched) add(e);
        if (prog === "ssh" && !hostOpaque && sshCmd !== null && sshCmd.length > 0) {
          const r = remoteClasses(sshCmd, env);
          remote.push(...r.classes);
          if (r.opaque) remoteOpaque = true;
        } else {
          if (prog === "ssh") remoteOpaque = true;
          else classes.push("write-out");
          if (hostOpaque) remoteOpaque = true;
        }
        if (hostOpaque && prog === "ssh") remoteOpaque = true;
      }
    }
    if (hit.size && segments.some((s) => s.opaque !== null)) opaque = true;
  } else if (WRITE_PATH_TOOLS.has(call.tool)) {
    for (const e of byKind("path")) if ((call.paths ?? []).some((p) => pathGlobMatch(e.glob, p, env))) add(e);
    if (hit.size) classes.push("write-out");
  } else if (call.tool === "fetch" && call.url) {
    const h = URL_HOST.exec(call.url)?.[1];
    if (h && !plainGet(call.payload)) {
      for (const e of byKind("host")) if (hostMatch(e.glob, h)) add(e);
      if (hit.size) classes.push("write-out");
    }
  }
  if (hit.size === 0) return null;
  const list = entries.filter((e) => hit.has(e));
  return { entries: list, classes, remoteClasses: remote, opaque, remoteOpaque, kinds: [...new Set(list.map((e) => e.kind))] };
}

/** The fetch payload is a plain GET or HEAD without a body. */
function plainGet(payload: string | undefined): boolean {
  let inp: Record<string, unknown> = {};
  try {
    const v = JSON.parse(payload ?? "{}");
    if (v && typeof v === "object") inp = v as Record<string, unknown>;
  } catch {
    return false;
  }
  const m = inp.method === undefined ? "GET" : typeof inp.method === "string" ? inp.method.toUpperCase() : "";
  if (m !== "GET" && m !== "HEAD") return false;
  return !Object.keys(inp).some((k) => /^(?:body|data|json|form|payload|files?)$/i.test(k) && inp[k] !== undefined && inp[k] !== null && inp[k] !== "");
}
