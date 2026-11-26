// Protected targets (permissions.json `protected`): hosts, paths and commands the owner wants a context-aware check for instead of a blanket ask.
// `matchProtected` finds the entries a call touches and the effect class of what it would do (every local segment, and for `ssh <host> <cmd>` the
// remote command too); `acceptProtected` decides whether a model's verdict on the call may stand. Everything fails closed: anything not modelled
// here (an opaque segment, a command-running ssh option, an unparsable remote command) is `opaque` and never allows. Reuses effects.ts classes,
// shellast.ts segments and rulecall.ts path globs; not related to the `Protected` type of floors.ts.
import * as path from "node:path";
import { toChain } from "./defaults.ts";
import type { ProtectedCause } from "./classifier.ts";
import { RUNNERS, segmentEffect } from "./effects.ts";
import type { EffectClass, EffectCtx } from "./effects.ts";
import { wildMatch } from "./glob.ts";
import type { ProtectedEntry } from "./permconfig.ts";
import { pathGlobMatch } from "./rulecall.ts";
import type { RuleCall, RuleEnv } from "./rulecall.ts";
import { parseShell } from "./shellast.ts";
import type { OpaqueReason, ShellSegment } from "./shellast.ts";

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
  verdict: "allow" | "ask" | "unsure" | "deny";
  effect: "read" | "write" | "deploy" | "network" | "unknown";
  confidence: "high" | "low";
  entry: string | null;
}

const MODE_RANK = { model: 0, "read-only": 1, ask: 2 } as const;

/** The check mode of a call: the strictest of the global `gate.protected.check` and the `check` of every matched entry (model < read-only < ask). */
export function effectiveCheckMode(global: ProtectedFacts["mode"], entries: readonly { check?: ProtectedFacts["mode"] }[]): ProtectedFacts["mode"] {
  let m = global;
  for (const e of entries) if (e.check && MODE_RANK[e.check] > MODE_RANK[m]) m = e.check;
  return m;
}

/** Classes that a read-only verdict must not coexist with, locally or remotely. */
const WRITING: ReadonlySet<EffectClass> = new Set(["write-in", "write-out", "build-test"]);

/**
 * The causes for which the owner is asked: the call changes the protected target in a way the code sees (`read_only`, `local_write`, `remote_write`,
 * `away`), the owner set the target to always ask (`mode`), or the model says the call needs the owner (`judge_ask`). Every other cause is a refusal.
 */
export const PROTECTED_ASK_CAUSES: ReadonlySet<ProtectedCause> = new Set<ProtectedCause>(["mode", "read_only", "local_write", "remote_write", "away", "judge_ask"]);

/** Causes of a refusal that count towards the repeat stop: what the model answered (`judge_unsure`, `low_confidence`, `unknown_effect`) and what the code saw (`local_opaque`, `remote_opaque`, `no_classes`). */
export const PROTECTED_COUNTED_CAUSES: ReadonlySet<ProtectedCause> = new Set<ProtectedCause>(["judge_unsure", "low_confidence", "unknown_effect", "local_opaque", "remote_opaque", "no_classes"]);

/**
 * What a model verdict may do, and why the gate does not allow when it does: the plan's table (see docs/permissions.md). Every `ask` and `refuse` carries a
 * cause. Never `allow` without a high-confidence verdict on a fully modelled call. A line the code cannot fully read (opaque) is refused first, before the
 * check mode and whatever the model said: the owner could not approve what nobody can read.
 */
export function judgeProtected(v: ProtectedVerdict, f: ProtectedFacts): { decision: "allow" | "ask" | "refuse" | "deny"; cause?: ProtectedCause } {
  const ask = (cause: ProtectedCause): { decision: "ask"; cause: ProtectedCause } => ({ decision: "ask", cause });
  const refuse = (cause: ProtectedCause): { decision: "refuse"; cause: ProtectedCause } => ({ decision: "refuse", cause });
  if (f.opaque) return refuse("local_opaque");
  if (f.remoteOpaque) return refuse("remote_opaque");
  if (f.mode === "ask") return ask("mode");
  if (f.classes.length === 0) return refuse("no_classes");
  if (v.verdict === "allow") {
    if (v.confidence !== "high") return refuse("low_confidence");
    // a remote segment the harness sees as a write always asks, whatever the verdict says
    if (f.remoteClasses.some((c) => WRITING.has(c))) return ask("remote_write");
    if (v.effect === "read") return f.classes.some((c) => WRITING.has(c)) ? ask("local_write") : { decision: "allow" };
    if (v.effect === "write" || v.effect === "deploy" || v.effect === "network") {
      if (f.mode === "read-only") return ask("read_only");
      if (f.away) return ask("away");
      return { decision: "allow" };
    }
    return refuse("unknown_effect");
  }
  if (v.verdict === "deny" && f.denyEntryExists) return { decision: "deny" };
  if (v.verdict === "unsure") return refuse("judge_unsure");
  return ask("judge_ask");
}

/** The decision of `judgeProtected`. */
export function acceptProtected(v: ProtectedVerdict, f: ProtectedFacts): "allow" | "ask" | "refuse" | "deny" {
  return judgeProtected(v, f).decision;
}

/** The owner counts as away unless a fresh `present` sample exists (no sample, unknown, away or older than `awayAfterMinutes` all mean away). */
export function sampleAway(sample: { outcome: string; at: number } | null, presenceAway: boolean, awayAfterMinutes: number, now: number): boolean {
  return !sample || sample.outcome !== "present" || presenceAway || now - sample.at > awayAfterMinutes * 60_000;
}

// ------------------------------------------------------------------ matching

export const SSH_ARG = new Set(["p", "i", "J", "l", "o", "F", "e", "S", "P", "b", "c", "D", "L", "R", "W", "w", "E", "I", "m", "O", "Q", "B"]);
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
  /** ssh: `-n` was seen (stdin is /dev/null, nothing is sent). */
  noStdin?: boolean;
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
        if (letter === "n") out.noStdin = true;
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

/**
 * What one opaque reason of a remote segment means (docs/permissions.md, the remote class table): `writing_wrapper` is a write; the reasons the parser
 * cannot state but the judge can read in the command text are `unknown`; `stdin_fed`, `parse_error`, `depth` (the walker does not read inside a segment cut at the nesting limit) and any reason not listed here (a later parser
 * version) make the remote command opaque, which always asks.
 */
export function remoteReasonClass(reason: OpaqueReason): EffectClass | "opaque" {
  switch (reason) {
    case "writing_wrapper":
      return "write-out";
    case "unresolved_var":
    case "glob_target":
    case "process_substitution":
    case "nonliteral_script":
    case "function_def":
    case "shell_builtin":
    case "assignment":
    case "xargs_stdin":
    case "wrapper_option":
    case "unsupported":
    case "foreign_shell":
      return "unknown";
    case "stdin_fed":
    case "parse_error":
    case "depth":
      return "opaque";
    default:
      return "opaque";
  }
}

/** An output redirect that writes somewhere other than the literal /dev/null (a string compare on every platform); an fd dup never counts. */
const writesFile = (r: { op: string; target: string }): boolean => r.op !== "<" && r.op !== "dup" && r.target !== "/dev/null";

/** `unsupported` is judge-only (unknown) just for a runner (sudo, su, ...), whose wrapped write the harness does not see (a documented limit); every other unsupported node (`[[`, `((`, `select`, `coproc`, a C-style `for`, an unmapped node) is remote opaque, because its words are not walked. */
const judgeOnly = (program: string): boolean => RUNNERS.has(program);

/** Classify one remote command: each of its segments (the remote class table); zero segments or a segment the harness cannot see into makes it opaque. */
function remoteClasses(argv: string[], env: ProtectedEnv): { classes: EffectClass[]; opaque: boolean } {
  if (argv.length === 0 || !env.ec) return { classes: [], opaque: true };
  const segs = parseShell(argv.join(" "), { cwd: env.ec.cwd, platform: env.platform });
  const classes: EffectClass[] = [];
  let opaque = segs.length === 0;
  for (const s of segs) {
    const redirected = s.redirects.some(writesFile);
    if (redirected) classes.push("write-out");
    if (s.opaque !== null) {
      const c = s.opaque === "unsupported" && !judgeOnly(s.program) ? "opaque" : remoteReasonClass(s.opaque);
      if (c === "opaque") opaque = true;
      if (!redirected || c !== "write-out") classes.push(c === "opaque" ? "unknown" : c);
      continue;
    }
    if (!redirected) classes.push(segClass(env, s, null));
  }
  return { classes, opaque };
}

/**
 * The ssh segment's own stdin is not in the call text: a pipe, a heredoc or here-string, a `<` / `<>` from anything but /dev/null, or an fd dup onto
 * stdin (`<&3`; `>&2` reads the same, fail closed) means the harness cannot see what the remote shell reads. `ssh -n` and an input only from /dev/null send nothing.
 */
function stdinOpaque(s: ShellSegment, noStdin: boolean): boolean {
  if (noStdin) return false;
  const dup = s.redirects.some((r) => r.op === "dup" && (r.fd === null || r.fd === "0"));
  if (s.stdinFed === false && !dup) return false; // a missing fact (a cloned segment) counts as fed
  if (!dup && !s.heredoc) {
    const ins = s.redirects.filter((r) => (r.op === "<" || r.op === "<>") && (r.fd === null || r.fd === "0"));
    if (ins.length > 0 && ins.every((r) => r.target === "/dev/null")) return false;
  }
  return true;
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
      let noStdin = false;
      if (SHELL_PROGS.has(prog)) {
        const v = remoteView(prog, s.argv);
        hosts = v.hosts;
        hostOpaque = v.opaque;
        sshCmd = prog === "ssh" ? v.remote : null;
        noStdin = v.noStdin === true;
      } else if ((prog === "curl" || prog === "wget") && cls !== "net-read") hosts = urlHosts(s.argv);
      const matched = byKind("host").filter((e) => hosts.some((h) => hostMatch(e.glob, h)));
      if (matched.length) {
        for (const e of matched) add(e);
        if (prog === "ssh" && !hostOpaque && sshCmd !== null && sshCmd.length > 0) {
          const r = remoteClasses(sshCmd, env);
          remote.push(...r.classes);
          if (r.opaque || stdinOpaque(s, noStdin)) remoteOpaque = true;
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
