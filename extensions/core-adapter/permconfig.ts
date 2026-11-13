// r79 permission config: the three `permissions.json` files (user, project, tracked), their trust rules, profiles, the mode resolution and the
// remember writer. Pure Node, no Pi imports; git is injectable so tests stay hermetic.
//
//   user     <agentDir>/pi-foreman/permissions.json   every key; `profiles` live only here
//   project  <main checkout>/.workflow/permissions.json   widening keys (allow, additionalDirectories, classifier.allow) only when the file is
//            untracked AND ignored by git and neither it nor `.workflow` is a symlink; else tighten-only. `mode` and `profiles` are ignored.
//   tracked  <worktree>/.pi/permissions.json   deny, ask and classifier.deny only (it is reviewed code anyone can push)
//
// Merge: lists concatenate (user, profile, project, tracked); the verdict class decides at match time (rules.ts: deny > ask > allow).
// Mode: session override > profile > user file > `auto`. An invalid user file reads as mode `ask` with the other files applied; an invalid project or
// tracked file contributes nothing. Bad entries inside a valid file are skipped one by one, each with a notice naming it.
//
// The profile name is the caller's input. It comes from the merged foreman config key `permissions.profile` (honoured in the user, organisation and
// default config layers only: the project and session layers must not set it, `IGNORED_KEYS` in scripts/foreman_config.py) or from the env variable
// PI_FOREMAN_PERMS_PROFILE that `foreman session open --profile` sets; `profileName()` applies that order.
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { holdsHome } from "./effects.ts";
import { parseRule } from "./rules.ts";
import type { ParsedRule, RuleSets } from "./rules.ts";

export type PermMode = "auto" | "ask" | "allow" | "deny";
export const PERM_MODES: readonly PermMode[] = ["auto", "ask", "allow", "deny"];
export const PROSE_MAX = 300;
export const PROTECTED_NOTE_MAX = 200;
export const PROFILE_ENV = "PI_FOREMAN_PERMS_PROFILE";

/** One `protected` entry as written: exactly one of host / path / command as a glob, with an optional note. */
export interface ProtectedRaw {
  kind: "host" | "path" | "command";
  glob: string;
  note?: string;
}

/** A protected-target entry after merging: `P1`.. in merged order (user file first, then the trusted project file). */
export interface ProtectedEntry extends ProtectedRaw {
  id: string;
  source: string;
}

/** The file shape both files and profiles share. */
export interface PermBody {
  mode?: PermMode;
  /** Protected targets (user file and trusted project file only; dropped everywhere else). */
  protected?: ProtectedRaw[];
  allow: string[];
  ask: string[];
  deny: string[];
  additionalDirectories: string[];
  classifier: { allow: string[]; deny: string[] };
  /** `floors.noteTools`: tool names whose prose fields skip the raw-text floors (user file and its profiles only; dropped everywhere else). */
  noteTools?: string[];
}

export type FileKind = "user" | "project" | "tracked";

/** The built-in profiles. `steward` runs ask-free (mode auto) and may type text into other panes, read them and look at processes. */
export const BUILTIN_PROFILES: Readonly<Record<string, PermBody>> = {
  steward: {
    mode: "auto",
    allow: ["Bash(herdr pane send-text *)", "Bash(herdr pane send-keys *)", "Bash(herdr pane read *)", "Bash(herdr pane list *)", "Bash(pgrep *)", "Bash(ps *)", "Bash(intercom *)", "intercom"],
    ask: [],
    deny: [],
    additionalDirectories: [],
    classifier: { allow: [], deny: [] },
  },
};

/** A folder the user works in (user file only): reads allowed; `auto` also relaxes writes no root covers (pathrules.ts workFolderOf). */
export interface WorkFolder {
  path: string;
  mode: "auto" | "read";
}

export interface RuleEntry {
  kind: "allow" | "ask" | "deny";
  rule: ParsedRule;
  /** `user`, `project`, `tracked` or `profile <name>`. */
  source: string;
}

export interface ProseEntry {
  /** `A1`.. for allow entries, `D1`.. for deny entries. */
  id: string;
  text: string;
  source: string;
}

export interface Resolved {
  mode: PermMode;
  modeSource: "session" | "profile" | "user" | "invalid-user-file" | "default";
  /** The mode without the session override. */
  baseMode: PermMode;
  profile: string | null;
  rules: RuleSets;
  entries: RuleEntry[];
  prose: { allow: ProseEntry[]; deny: ProseEntry[] };
  /** Protected targets (user, then trusted project), numbered P1.. */
  protected: ProtectedEntry[];
  /** Bumps on every reload and every re-resolve that saw a change (caches key on it). */
  version: number;
  /** Absolute directories the read roots widen by. */
  additionalDirectories: string[];
  /** Validated work folders of the user file: absolute, normalised, never the home dir or one of its ancestors. */
  workFolders: WorkFolder[];
  /** Why a folder was dropped or kept with a warning (shown by `/foreman perms list`). */
  workFolderNotes: string[];
  /** The project file may widen (untracked, ignored, no symlink). */
  projectTrusted: boolean;
  /** The project file as the remember writer would write it. */
  projectFile: string;
  /** `floors.noteTools` of the user file and the selected profile: note tools added to the built-in list (gate.ts `NOTE_TOOLS`). */
  noteTools: string[];
}

export interface GitRun {
  (args: string[], cwd: string): { status: number; stdout: string };
}

export const realGit: GitRun = (args, cwd) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] });
  return { status: r.status ?? 1, stdout: r.stdout ?? "" };
};

export interface PermEnv {
  agentDir: string;
  /** The session's worktree (the tracked file lives below it; git runs here). */
  cwd: string;
  home: string;
  /** Name of the selected profile (see `profileName`), or null. */
  profile?: string | null;
  /** The session override of `/foreman perms mode`. */
  sessionMode?: PermMode | null;
  git?: GitRun;
}

/** The profile name: the env variable of `foreman session open --profile` wins, then the config key. Empty means none. */
export function profileName(config: unknown, env: Record<string, string | undefined> = process.env): string | null {
  const e = env[PROFILE_ENV];
  if (typeof e === "string" && e.trim() !== "") return e.trim();
  const c = (config as { permissions?: { profile?: unknown } } | null | undefined)?.permissions?.profile;
  return typeof c === "string" && c.trim() !== "" ? c.trim() : null;
}

export const userFilePath = (agentDir: string): string => path.join(agentDir, "pi-foreman", "permissions.json");

/** The "Protected" block of `/foreman perms list`: id, kind, glob, note and source of each entry. */
export function protectedBlock(r: Pick<Resolved, "protected">): string[] {
  if (r.protected.length === 0) return [];
  return ["Protected:", ...r.protected.map((e) => `  ${e.id}: ${e.kind} ${e.glob}${e.note ? ` - ${e.note}` : ""} (${e.source})`)];
}

/** Doctor INFO lines: a `Bash(*<word>*)` ask rule whose word looks like a host or path fragment is a candidate for a `protected` entry (docs/permissions.md "Protected targets"). */
export function protectHintLines(r: Pick<Resolved, "entries" | "protected">): string[] {
  const out: string[] = [];
  for (const e of r.entries) {
    if (e.kind !== "ask" || e.rule.tool !== "Bash" || !e.rule.pattern) continue;
    const m = /^\*([A-Za-z0-9._/-]{3,})\*$/.exec(e.rule.pattern);
    if (!m || !/[./-]|prod|stag/i.test(m[1])) continue;
    if (r.protected.some((p) => p.glob.includes(m[1]))) continue;
    out.push(`INFO ${e.rule.text} (${e.source}) asks on every call that names ${m[1]}; a protected entry (\`/foreman perms protect add host|path ${m[1]}\`) lets the small model judge reads and writes instead`);
  }
  return out;
}

/** The "Work folders" block of `/foreman perms list`: each folder with its mode and the spelling matched (the real path when it differs), then the warnings. */
export function workFoldersBlock(r: Pick<Resolved, "workFolders" | "workFolderNotes">, real: (p: string) => string = (p) => p): string[] {
  if (r.workFolders.length === 0 && r.workFolderNotes.length === 0) return [];
  const lines = ["Work folders:"];
  for (const f of r.workFolders) {
    const rp = real(f.path);
    lines.push(`  ${f.path} (${f.mode === "auto" ? "auto: reads allowed, uncovered writes run under auto" : "read: reads allowed"})${rp !== f.path ? `, also matched as ${rp}` : ""}`);
  }
  for (const n of r.workFolderNotes) lines.push(`  warning: ${n}`);
  return lines;
}

// ------------------------------------------------------------------ parsing

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);
const clip = (s: string, n = 60): string => (s.length > n ? `${s.slice(0, n)}...` : s);

interface ParsedFile {
  ok: true;
  body: PermBody;
  profiles: Record<string, PermBody>;
  /** Keys present that this file kind may not use. */
  dropped: string[];
  /** `workFolders` as written in the user file (validated at resolve time). */
  workFolders: WorkFolder[];
  notices: string[];
}

/** The string list at `key`; a non-string item is skipped with a notice, a non-array is an error. */
function strList(v: unknown, where: string, notices: string[]): string[] | null {
  if (v === undefined) return [];
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  v.forEach((x, i) => {
    if (typeof x === "string" && x.trim() !== "") out.push(x.trim());
    else notices.push(`${where}[${i}] is not a non-empty string; skipped`);
  });
  return out;
}

/** The `protected` list: each entry has exactly one of host / path / command (a glob of 1-300 characters) and an optional note of at most 200; a bad entry is skipped with a notice naming it. */
function protectedList(v: unknown, where: string, notices: string[]): ProtectedRaw[] | null {
  if (v === undefined) return [];
  if (!Array.isArray(v)) return null;
  const out: ProtectedRaw[] = [];
  v.forEach((x, i) => {
    const at = `${where}protected[${i}]`;
    if (!isObj(x)) {
      notices.push(`${at} is not an object; skipped`);
      return;
    }
    const kinds = (["host", "path", "command"] as const).filter((k) => x[k] !== undefined);
    if (kinds.length !== 1) {
      notices.push(`${at} must have exactly one of host, path or command; skipped`);
      return;
    }
    const kind = kinds[0];
    const g = x[kind];
    if (typeof g !== "string" || g.trim() === "" || g.length > PROSE_MAX) {
      notices.push(`${at} ${kind} '${clip(String(g))}' must be a glob of 1 to ${PROSE_MAX} characters; skipped`);
      return;
    }
    const n = x.note;
    if (n !== undefined && (typeof n !== "string" || n.length > PROTECTED_NOTE_MAX)) {
      notices.push(`${at} (${kind} '${clip(g)}') note must be a string of at most ${PROTECTED_NOTE_MAX} characters; skipped`);
      return;
    }
    out.push({ kind, glob: g.trim(), ...(typeof n === "string" && n.trim() !== "" ? { note: n.trim() } : {}) });
  });
  return out;
}

/** `floors.noteTools`: a list of tool names; a non-string item is skipped with a notice, a bad shape is ignored with one. */
function noteToolList(v: unknown, where: string, notices: string[]): string[] {
  if (!isObj(v)) {
    notices.push(`${where}floors must be an object; ignored`);
    return [];
  }
  const l = strList(v.noteTools, `${where}floors.noteTools`, notices);
  if (l === null) {
    notices.push(`${where}floors.noteTools must be a list of tool names; ignored`);
    return [];
  }
  return l;
}

function parseBody(o: Json, where: string, notices: string[], dropped?: string[]): PermBody | string {
  const body: PermBody = { allow: [], ask: [], deny: [], additionalDirectories: [], classifier: { allow: [], deny: [] } };
  if (o.protected !== undefined) {
    if (dropped) dropped.push(`${where}protected`);
    else {
      const l = protectedList(o.protected, where, notices);
      if (l === null) return `${where}protected must be a list`;
      body.protected = l;
    }
  }
  if (o.mode !== undefined) {
    if (typeof o.mode === "string" && (PERM_MODES as readonly string[]).includes(o.mode)) body.mode = o.mode as PermMode;
    else notices.push(`${where}mode '${clip(String(o.mode))}' is not auto, ask, allow or deny; ignored`);
  }
  for (const k of ["allow", "ask", "deny", "additionalDirectories"] as const) {
    const l = strList(o[k], `${where}${k}`, notices);
    if (l === null) return `${where}${k} must be a list of strings`;
    body[k] = l;
  }
  if (o.classifier !== undefined) {
    if (!isObj(o.classifier)) return `${where}classifier must be an object`;
    for (const k of ["allow", "deny"] as const) {
      const l = strList(o.classifier[k], `${where}classifier.${k}`, notices);
      if (l === null) return `${where}classifier.${k} must be a list of strings`;
      body.classifier[k] = l;
    }
  }
  return body;
}

function parseText(text: string, kind: FileKind): ParsedFile | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `not valid JSON (${clip((e as Error).message, 80)})` };
  }
  if (!isObj(raw)) return { ok: false, error: "the top level must be an object" };
  const notices: string[] = [];
  const dropped: string[] = [];
  const body = parseBody(raw, "", notices, kind === "tracked" ? dropped : undefined);
  if (typeof body === "string") return { ok: false, error: body };
  const profiles: Record<string, PermBody> = {};
  const workFolders: WorkFolder[] = [];
  if (raw.floors !== undefined) {
    if (kind !== "user") dropped.push("floors");
    else body.noteTools = noteToolList(raw.floors, "", notices);
  }
  if (raw.workFolders !== undefined) {
    if (kind !== "user") dropped.push("workFolders");
    else if (!Array.isArray(raw.workFolders)) notices.push("workFolders must be a list; ignored");
    else {
      raw.workFolders.forEach((f, i) => {
        const p = isObj(f) ? f.path : undefined;
        if (typeof p !== "string" || p.trim() === "") {
          notices.push(`workFolders[${i}] has no path; skipped`);
          return;
        }
        const m = (f as Json).mode;
        if (m !== undefined && m !== "auto" && m !== "read") notices.push(`workFolders[${i}] mode '${clip(String(m))}' is not auto or read; using read`);
        workFolders.push({ path: p.trim(), mode: m === undefined || m === "auto" ? "auto" : "read" });
      });
    }
  }
  if (raw.profiles !== undefined) {
    if (kind !== "user") dropped.push("profiles");
    else if (!isObj(raw.profiles)) return { ok: false, error: "profiles must be an object" };
    else {
      for (const [name, v] of Object.entries(raw.profiles)) {
        if (!isObj(v)) {
          notices.push(`profiles.${name} is not an object; skipped`);
          continue;
        }
        if (v.workFolders !== undefined) dropped.push(`profiles.${name}.workFolders`);
        const b = parseBody(v, `profiles.${name}.`, notices, dropped);
        if (typeof b === "string") notices.push(`${b}; profile skipped`);
        else {
          if (v.floors !== undefined) b.noteTools = noteToolList(v.floors, `profiles.${name}.`, notices);
          profiles[name] = b;
        }
      }
    }
  }
  if (kind === "project" && raw.mode !== undefined) {
    dropped.push("mode");
    delete body.mode;
  }
  if (kind === "tracked") {
    for (const k of ["mode", "allow", "additionalDirectories"] as const) if (raw[k] !== undefined) dropped.push(k);
    if (isObj(raw.classifier) && raw.classifier.allow !== undefined) dropped.push("classifier.allow");
    delete body.mode;
    body.allow = [];
    body.additionalDirectories = [];
    body.classifier.allow = [];
  }
  return { ok: true, body, profiles, dropped, workFolders, notices };
}

// ------------------------------------------------------------------ the store

interface Slot {
  sig: string;
  parsed: ParsedFile | { ok: false; error: string } | null;
}

const sigOf = (file: string): string => {
  try {
    const l = fs.lstatSync(file);
    return `${l.mtimeMs}:${l.size}:${l.ino}:${l.isSymbolicLink() ? "l" : "f"}`;
  } catch {
    return "missing";
  }
};

export class PermStore {
  private readonly env: PermEnv;
  private readonly git: GitRun;
  private sessionMode: PermMode | null;
  private slots: Partial<Record<FileKind, Slot>> = {};
  private cached: { sig: string; resolved: Resolved } | null = null;
  private pending: string[] = [];
  private told = new Set<string>();
  private mainCheckout: string | null = null;
  private trust: { sig: string; ok: boolean; why: string } | null = null;
  private ver = 0;

  constructor(env: PermEnv) {
    this.env = env;
    this.git = env.git ?? realGit;
    this.sessionMode = env.sessionMode ?? null;
  }

  /** The session override of `/foreman perms mode`; null clears it. */
  setSessionMode(m: PermMode | null): void {
    this.sessionMode = m;
    this.cached = null;
  }

  /** Monotonic: grows on every reload, remember write and re-resolve that saw a change. */
  get version(): number {
    return this.resolve().version;
  }

  /** `/foreman perms reload` and every remember write: forget everything read so far. */
  reload(): void {
    this.ver++;
    this.slots = {};
    this.cached = null;
    this.trust = null;
    this.mainCheckout = null;
  }

  /** Notices produced since the last call, each text only once per store. */
  drainNotices(): string[] {
    const out = this.pending;
    this.pending = [];
    return out;
  }

  private note(text: string): void {
    const t = `pi-foreman: ${text}`;
    if (this.told.has(t)) return;
    this.told.add(t);
    this.pending.push(t);
  }

  /** The main checkout (first entry of `git worktree list`), or the worktree itself outside git. */
  main(): string {
    if (this.mainCheckout) return this.mainCheckout;
    const r = this.git(["worktree", "list", "--porcelain"], this.env.cwd);
    const first = r.status === 0 ? r.stdout.split(/\r?\n/).find((l) => l.startsWith("worktree ")) : undefined;
    this.mainCheckout = first ? first.slice("worktree ".length).trim() : this.env.cwd;
    return this.mainCheckout;
  }

  filePath(kind: FileKind): string {
    if (kind === "user") return userFilePath(this.env.agentDir);
    if (kind === "project") return path.join(this.main(), ".workflow", "permissions.json");
    return path.join(this.env.cwd, ".pi", "permissions.json");
  }

  /** Why the project file may not widen (or be written), or null when it may. Cached until the file changes or `reload()`. */
  projectDistrust(): string | null {
    const file = this.filePath("project");
    const dir = path.dirname(file);
    const sig = `${sigOf(file)}|${sigOf(dir)}`;
    if (!this.trust || this.trust.sig !== sig) this.trust = { sig, ...this.checkTrust(file, dir) };
    return this.trust.ok ? null : this.trust.why;
  }

  private checkTrust(file: string, dir: string): { ok: boolean; why: string } {
    const main = this.main();
    const link = (p: string): boolean => {
      try {
        return fs.lstatSync(p).isSymbolicLink();
      } catch {
        return false;
      }
    };
    if (link(dir) || link(file)) return { ok: false, why: `${link(dir) ? ".workflow" : "permissions.json"} is a symbolic link` };
    const rel = path.relative(main, file).split(path.sep).join("/");
    if (this.git(["ls-files", "--error-unmatch", "--", rel], main).status === 0) return { ok: false, why: "the file is tracked by git" };
    if (this.git(["check-ignore", "-q", "--", rel], main).status !== 0) return { ok: false, why: "the file is not ignored by git (add `.workflow/` to .git/info/exclude)" };
    return { ok: true, why: "" };
  }

  private slot(kind: FileKind): Slot {
    const file = this.filePath(kind);
    const sig = sigOf(file);
    const have = this.slots[kind];
    if (have && have.sig === sig) return have;
    let parsed: Slot["parsed"] = null;
    if (sig !== "missing") {
      let text: string | null = null;
      try {
        text = fs.readFileSync(file, "utf8");
      } catch (e) {
        parsed = { ok: false, error: `cannot be read (${clip((e as Error).message, 80)})` };
      }
      if (text !== null) {
        parsed = parseText(text, kind);
        if (parsed.ok) {
          for (const n of parsed.notices) this.note(`${file}: ${n}`);
          if (parsed.dropped.length) this.note(`${file}: ${parsed.dropped.join(", ")} ${parsed.dropped.length === 1 ? "is" : "are"} not honoured in the ${kind} file; dropped`);
        }
      }
      if (parsed && "error" in parsed) this.note(`${file} is invalid: ${parsed.error}.${kind === "user" ? " Mode ask applies until it is fixed." : " The file is ignored."}`);
    }
    const s: Slot = { sig, parsed };
    this.slots[kind] = s;
    this.cached = null;
    return s;
  }

  /** The merged view. Re-reads a file whose mtime, size or inode changed; the same object is returned while nothing changed. */
  resolve(): Resolved {
    const user = this.slot("user");
    const project = this.slot("project");
    const tracked = this.slot("tracked");
    const distrust = project.parsed?.ok ? this.projectDistrust() : null;
    const sig = [user.sig, project.sig, tracked.sig, distrust ?? "trusted", this.sessionMode ?? "", this.env.profile ?? ""].join("|");
    if (this.cached && this.cached.sig === sig) return this.cached.resolved;

    const parts: { src: string; body: PermBody; widen: boolean }[] = [];
    const userOk = user.parsed?.ok === true ? user.parsed : null;
    const userBody = userOk ? userOk.body : null;
    if (userBody) parts.push({ src: "user", body: userBody, widen: true });

    let profile: string | null = null;
    let profileBody: PermBody | null = null;
    const want = this.env.profile ?? null;
    if (want) {
      const b = userOk?.profiles[want] ?? BUILTIN_PROFILES[want];
      if (b) {
        profile = want;
        profileBody = b;
        parts.push({ src: `profile ${want}`, body: b, widen: true });
      } else this.note(`permissions profile '${clip(want)}' is not defined (built-in: ${Object.keys(BUILTIN_PROFILES).join(", ")}; others come from the profiles key of the user file); ignored`);
    }
    if (project.parsed?.ok) {
      if (distrust === null) parts.push({ src: "project", body: project.parsed.body, widen: true });
      else {
        const t: PermBody = { ...project.parsed.body, allow: [], additionalDirectories: [], classifier: { allow: [], deny: project.parsed.body.classifier.deny }, protected: [] };
        if (project.parsed.body.protected?.length) this.note(`${this.filePath("project")}: ${distrust}, so protected is not honoured; dropped`);
        parts.push({ src: "project", body: t, widen: false });
        if (project.parsed.body.allow.length || project.parsed.body.additionalDirectories.length || project.parsed.body.classifier.allow.length) {
          this.note(`${this.filePath("project")}: ${distrust}, so only its deny, ask and classifier.deny keys apply (allow, additionalDirectories and classifier.allow are ignored)`);
        }
      }
    }
    if (tracked.parsed?.ok) parts.push({ src: "tracked", body: tracked.parsed.body, widen: false });

    const sets: RuleSets = { deny: [], ask: [], allow: [] };
    const entries: RuleEntry[] = [];
    const prose = { allow: [] as ProseEntry[], deny: [] as ProseEntry[] };
    const dirs: string[] = [];
    const prot: ProtectedEntry[] = [];
    for (const p of parts) {
      for (const e of p.body.protected ?? []) prot.push({ ...e, id: `P${prot.length + 1}`, source: p.src });
      for (const kind of ["deny", "ask", "allow"] as const) {
        for (const text of p.body[kind]) {
          const r = parseRule(text);
          if ("error" in r) this.note(`${p.src} ${kind} rule '${clip(text)}': ${r.error}; skipped`);
          else {
            sets[kind].push(r.rule);
            entries.push({ kind, rule: r.rule, source: p.src });
          }
        }
      }
      for (const kind of ["allow", "deny"] as const) {
        for (const text of p.body.classifier[kind]) {
          if (text.length > PROSE_MAX) {
            this.note(`${p.src} classifier.${kind} entry '${clip(text)}' is longer than ${PROSE_MAX} characters; skipped`);
            continue;
          }
          const list = prose[kind];
          list.push({ id: `${kind === "allow" ? "A" : "D"}${list.length + 1}`, text, source: p.src });
        }
      }
      for (const d of p.body.additionalDirectories) dirs.push(this.expandDir(d));
    }

    const workFolderNotes: string[] = [];
    const workFolders = this.validFolders(userOk?.workFolders ?? [], workFolderNotes);
    let mode: PermMode = "auto";
    let modeSource: Resolved["modeSource"] = "default";
    if (user.parsed && !user.parsed.ok) {
      mode = "ask";
      modeSource = "invalid-user-file";
    } else if (userBody?.mode) {
      mode = userBody.mode;
      modeSource = "user";
    }
    if (profileBody?.mode) {
      mode = profileBody.mode;
      modeSource = "profile";
    }
    const baseMode = mode;
    if (this.sessionMode) {
      mode = this.sessionMode;
      modeSource = "session";
    }
    const resolved: Resolved = { mode, modeSource, baseMode, profile, rules: sets, entries, prose, protected: prot, version: ++this.ver, additionalDirectories: [...new Set(dirs)], workFolders, workFolderNotes, projectTrusted: project.parsed?.ok ? distrust === null : this.projectDistrust() === null, projectFile: this.filePath("project"), noteTools: [...new Set([...(userBody?.noteTools ?? []), ...(profileBody?.noteTools ?? [])])] };
    this.cached = { sig, resolved };
    return resolved;
  }

  /** The mode without the session override (profile mode, user file mode, `auto`). */
  baseMode(): PermMode {
    return this.resolve().baseMode;
  }

  /** Work folders that may stand: absolute (after `~`), not the filesystem root, the home dir or an ancestor of it. Each drop and the outside-home case warn once. */
  private validFolders(list: WorkFolder[], notes: string[]): WorkFolder[] {
    const warn = (t: string): void => {
      notes.push(t);
      this.note(t);
    };
    const out: WorkFolder[] = [];
    const platform = process.platform;
    const home = this.env.home;
    const real = (p: string): string => {
      try {
        return fs.realpathSync(p);
      } catch {
        return p;
      }
    };
    for (const f of list) {
      const tilde = f.path === "~" || f.path.startsWith("~/") || f.path.startsWith("~\\");
      if (!tilde && !path.isAbsolute(f.path)) {
        warn(`workFolders '${clip(f.path, 200)}' is not an absolute path; dropped`);
        continue;
      }
      const p = this.expandDir(f.path);
      const rp = real(p);
      if (path.dirname(p) === p || [p, rp].some((r) => holdsHome(platform, r, home) || holdsHome(platform, r, real(home)))) {
        warn(`workFolders '${clip(f.path, 200)}' is the filesystem root, your home dir or one of its parents; dropped`);
        continue;
      }
      if (!holdsHome(platform, home, p) && !holdsHome(platform, home, rp)) warn(`workFolders '${clip(f.path, 200)}' lies outside your home dir; kept`);
      if (!out.some((o) => o.path === p)) out.push({ path: p, mode: f.mode });
    }
    return out;
  }

  private expandDir(d: string): string {
    if (d === "~" || d.startsWith("~/") || d.startsWith("~\\")) return path.join(this.env.home, d.slice(1));
    return path.isAbsolute(d) ? path.normalize(d) : path.resolve(this.main(), d);
  }

  /**
   * The remember writer: appends a prose sentence to `classifier.allow` and/or a pattern rule to `allow` in the project file, keeping the file's
   * other keys and their order. Refuses (with the reason) when the project file may not widen, when it is not valid JSON, or when an input is bad.
   */
  writeRemember(input: { prose?: string; rule?: string }): { ok: true; file: string } | { ok: false; reason: string } {
    const file = this.filePath("project");
    const prose = input.prose === undefined ? undefined : input.prose.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim();
    if (prose === undefined && input.rule === undefined) return { ok: false, reason: "nothing to remember" };
    if (prose !== undefined && (prose === "" || prose.length > PROSE_MAX)) return { ok: false, reason: `the sentence must be 1 to ${PROSE_MAX} characters` };
    if (input.rule !== undefined) {
      const r = parseRule(input.rule);
      if ("error" in r) return { ok: false, reason: `the pattern rule is not valid: ${r.error}` };
    }
    this.trust = null;
    const why = this.projectDistrust();
    if (why !== null) return { ok: false, reason: `not written: ${why}. The remembered entries live in ${file}, which has to be untracked and ignored by git; add \`.workflow/\` to .git/info/exclude.` };
    let obj: Json = {};
    if (fs.existsSync(file)) {
      try {
        const v = JSON.parse(fs.readFileSync(file, "utf8"));
        if (!isObj(v)) return { ok: false, reason: `not written: ${file} is not a JSON object` };
        obj = v;
      } catch (e) {
        return { ok: false, reason: `not written: ${file} is not valid JSON (${clip((e as Error).message, 80)}); fix it first` };
      }
    }
    const push = (holder: Json, key: string, value: string): string | null => {
      const cur = holder[key];
      if (cur === undefined) holder[key] = [value];
      else if (Array.isArray(cur)) {
        if (!cur.includes(value)) cur.push(value);
      } else return `${key} in ${file} is not a list`;
      return null;
    };
    if (input.rule !== undefined) {
      const e = push(obj, "allow", input.rule.trim());
      if (e) return { ok: false, reason: `not written: ${e}` };
    }
    if (prose !== undefined) {
      if (obj.classifier === undefined) obj.classifier = {};
      if (!isObj(obj.classifier)) return { ok: false, reason: `not written: classifier in ${file} is not an object` };
      const e = push(obj.classifier, "allow", prose);
      if (e) return { ok: false, reason: `not written: ${e}` };
    }
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      // a directory made by mkdir is no link; a link made since the check is caught by the second look
      if (fs.lstatSync(path.dirname(file)).isSymbolicLink()) return { ok: false, reason: "not written: .workflow is a symbolic link" };
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (e) {
      return { ok: false, reason: `not written: ${clip((e as Error).message, 120)}` };
    }
    this.reload();
    return { ok: true, file };
  }

  /**
   * The `protected` writer (foreman_protect, `/foreman perms protect`): adds or removes one entry in the `protected` list of the trusted project file or
   * the user file, keeping the file's other keys and their order, with the symlink, trust and atomic-write checks of the other writers. The entry is
   * re-validated here; a duplicate add and a missing remove are refused. Reloads (a version bump that clears the gate caches) on success.
   */
  writeProtected(file: "project" | "user", op: "add" | "remove", entry: { kind: string; glob: string; note?: string }): { ok: true; file: string } | { ok: false; reason: string } {
    const clean = cleanProtected(entry);
    if (typeof clean === "string") return { ok: false, reason: clean };
    const target = this.filePath(file);
    if (file === "project") {
      this.trust = null;
      const why = this.projectDistrust();
      if (why !== null) return { ok: false, reason: `not written: ${why}. Protected entries live in ${target}, which has to be untracked and ignored by git; add \`.workflow/\` to .git/info/exclude.` };
    }
    let obj: Json = {};
    try {
      if (fs.lstatSync(target).isSymbolicLink()) return { ok: false, reason: `not written: ${target} is a symbolic link` };
      const v = JSON.parse(fs.readFileSync(target, "utf8"));
      if (!isObj(v)) return { ok: false, reason: `not written: ${target} is not a JSON object` };
      obj = v;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") return { ok: false, reason: `not written: ${target} is not valid JSON (${clip((e as Error).message, 80)}); fix it first` };
    }
    const cur = obj.protected;
    if (cur !== undefined && !Array.isArray(cur)) return { ok: false, reason: `not written: protected in ${target} is not a list` };
    const list: unknown[] = cur === undefined ? [] : (cur as unknown[]);
    const same = (x: unknown): boolean => isObj(x) && x[clean.kind] === clean.glob && (Object.keys(x).filter((k) => k === "host" || k === "path" || k === "command").length === 1);
    const at = list.findIndex(same);
    if (op === "add") {
      if (at >= 0) return { ok: false, reason: `not written: ${clean.kind} ${clean.glob} is already protected in ${target}` };
      list.push({ [clean.kind]: clean.glob, ...(clean.note ? { note: clean.note } : {}) });
    } else {
      if (at < 0) return { ok: false, reason: `not written: ${clean.kind} ${clean.glob} is not in the protected list of ${target}` };
      list.splice(at, 1);
    }
    obj.protected = list;
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (fs.lstatSync(path.dirname(target)).isSymbolicLink()) return { ok: false, reason: `not written: ${path.dirname(target)} is a symbolic link` };
      const tmp = `${target}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(tmp, target);
    } catch (e) {
      return { ok: false, reason: `not written: ${clip((e as Error).message, 120)}` };
    }
    this.reload();
    return { ok: true, file: target };
  }
}

/** Validate one protected entry as foreman_protect and the slash command receive it: one kind, a glob of 1 to 300 characters, a note of at most 200; control characters are stripped from both. */
export function cleanProtected(e: { kind: unknown; glob: unknown; note?: unknown }): ProtectedRaw | string {
  if (e.kind !== "host" && e.kind !== "path" && e.kind !== "command") return "kind must be host, path or command";
  const strip = (s: string): string => s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim();
  if (typeof e.glob !== "string") return "glob must be a string";
  const glob = strip(e.glob);
  if (glob === "" || glob.length > PROSE_MAX) return `glob must be 1 to ${PROSE_MAX} characters`;
  const rawNote = e.note;
  if (rawNote !== undefined && typeof rawNote !== "string") return "note must be a string";
  const note = typeof rawNote === "string" ? strip(rawNote) : "";
  if (note.length > PROTECTED_NOTE_MAX) return `note must be at most ${PROTECTED_NOTE_MAX} characters`;
  return { kind: e.kind, glob, ...(note ? { note } : {}) };
}

/**
 * The workshop writer (`foreman perms adopt`): appends pattern rules to `allow` and whitelist sentences to `classifier.allow` of the USER file,
 * atomically, keeping the file's other keys (`workFolders`, `profiles`, ...) and their order. Every input is re-validated here (the rule grammar,
 * the sentence length, control characters); the whole call is refused when one is bad, so nothing is half written. Never reachable from a dialog.
 */
export function writeUserAllow(agentDir: string, input: { rules?: string[]; sentences?: string[] }): { ok: true; file: string; added: string[] } | { ok: false; reason: string } {
  const file = userFilePath(agentDir);
  const rules = (input.rules ?? []).map((r) => (typeof r === "string" ? r.trim() : r));
  const sentences = input.sentences ?? [];
  if (rules.length + sentences.length === 0) return { ok: false, reason: "nothing to write" };
  for (const r of rules) {
    const p = typeof r === "string" ? parseRule(r) : null;
    if (!p || "error" in p) return { ok: false, reason: `the pattern rule is not valid: ${p && "error" in p ? p.error : "not a string"}` };
  }
  for (const s of sentences) {
    if (typeof s !== "string" || s.trim() === "" || s.length > PROSE_MAX || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(s)) return { ok: false, reason: `a sentence must be 1 to ${PROSE_MAX} characters without control characters` };
  }
  let obj: Json = {};
  try {
    if (fs.lstatSync(file).isSymbolicLink()) return { ok: false, reason: `not written: ${file} is a symbolic link` };
    const v = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!isObj(v)) return { ok: false, reason: `not written: ${file} is not a JSON object` };
    obj = v;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") return { ok: false, reason: `not written: ${file} is not valid JSON (${clip((e as Error).message, 80)}); fix it first` };
  }
  const added: string[] = [];
  const push = (holder: Json, key: string, value: string): string | null => {
    const cur = holder[key];
    if (cur === undefined) holder[key] = [value];
    else if (Array.isArray(cur)) {
      if (cur.includes(value)) return null;
      cur.push(value);
    } else return `${key} in ${file} is not a list`;
    added.push(value);
    return null;
  };
  for (const r of rules) {
    const e = push(obj, "allow", r);
    if (e) return { ok: false, reason: `not written: ${e}` };
  }
  if (sentences.length) {
    if (obj.classifier === undefined) obj.classifier = {};
    if (!isObj(obj.classifier)) return { ok: false, reason: `not written: classifier in ${file} is not an object` };
    for (const s of sentences) {
      const e = push(obj.classifier, "allow", s.trim());
      if (e) return { ok: false, reason: `not written: ${e}` };
    }
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (e) {
    return { ok: false, reason: `not written: ${clip((e as Error).message, 120)}` };
  }
  return { ok: true, file, added };
}
