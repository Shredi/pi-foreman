// Permission config: the three `permissions.json` files (user, project, tracked) and their trust rules. What they still hold: protected targets, work
// folders, additional directories, `floors.noteTools` and `classifier.deny` (the protected-target check cites those sentences). The modes, profiles, rule
// lists (`allow`, `ask`, `deny`) and allow sentences (`classifier.allow`) were removed: a file that still sets one is read, the key is ignored and recorded
// in `Resolved.ignored` (the doctor prints one INFO line per key). Pure Node, no Pi imports; git is injectable so tests stay hermetic.
//
//   user     <agentDir>/pi-foreman/permissions.json   every key
//   project  <main checkout>/.workflow/permissions.json   widening keys (additionalDirectories, protected) only when the file is untracked AND ignored by
//            git and neither it nor `.workflow` is a symlink; else tighten-only (classifier.deny).
//   tracked  <worktree>/.pi/permissions.json   classifier.deny only (it is reviewed code anyone can push)
//
// An invalid file contributes nothing. Bad entries inside a valid file are skipped one by one, each with a notice naming it.
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { holdsHome } from "./effects.ts";
export const PROSE_MAX = 300;
export const PROTECTED_NOTE_MAX = 200;

/** The check mode of one protected entry; it can only tighten `gate.protected.check` (model < read-only < ask). */
export type ProtectedCheckMode = "model" | "read-only" | "ask";
export const PROTECTED_CHECK_MODES: readonly ProtectedCheckMode[] = ["model", "read-only", "ask"];

/** One `protected` entry as written: exactly one of host / path / command as a glob, with an optional note and an optional stricter check mode. */
export interface ProtectedRaw {
  kind: "host" | "path" | "command";
  glob: string;
  note?: string;
  check?: ProtectedCheckMode;
}

/** A protected-target entry after merging: `P1`.. in merged order (user file first, then the trusted project file). */
export interface ProtectedEntry extends ProtectedRaw {
  id: string;
  source: string;
}

/** The file shape of one permissions file: what is still read (the removed keys are only recorded in `ignored`). */
export interface PermBody {
  /** Protected targets (user file and trusted project file only; dropped everywhere else). */
  protected?: ProtectedRaw[];
  additionalDirectories: string[];
  classifier: { deny: string[] };
  /** `floors.noteTools`: tool names whose prose fields skip the raw-text floors (user file only; dropped everywhere else). */
  noteTools?: string[];
  /** The removed keys this file still sets (`mode`, `profiles`, `allow`, `ask`, `deny`, `classifier.allow`). */
  ignored: string[];
}

export type FileKind = "user" | "project" | "tracked";

/** A folder the user works in (user file only): reads allowed; `auto` also relaxes writes no root covers (pathrules.ts workFolderOf). */
export interface WorkFolder {
  path: string;
  mode: "auto" | "read";
}

export interface ProseEntry {
  /** `D1`.. for deny entries. */
  id: string;
  text: string;
  source: string;
}

export interface Resolved {
  prose: { deny: ProseEntry[] };
  /** Protected targets (user, then trusted project), numbered P1.. */
  protected: ProtectedEntry[];
  /** Bumps on every reload and every re-resolve that saw a change (caches key on it). */
  version: number;
  /** Absolute directories the read roots widen by. */
  additionalDirectories: string[];
  /** The removed keys still set, one per key and file: `<file kind> <key>` (the doctor prints one INFO line each). */
  ignored: string[];
  /** Validated work folders of the user file: absolute, normalised, never the home dir or one of its ancestors. */
  workFolders: WorkFolder[];
  /** Why a folder was dropped or kept with a warning (shown by `/foreman perms list`). */
  workFolderNotes: string[];
  /** The project file may widen (untracked, ignored, no symlink). */
  projectTrusted: boolean;
  /** The project file (protected entries are written there). */
  projectFile: string;
  /** `floors.noteTools` of the user file: note tools added to the built-in list (gate.ts `NOTE_TOOLS`). */
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
  git?: GitRun;
}

export const userFilePath = (agentDir: string): string => path.join(agentDir, "pi-foreman", "permissions.json");

/** The "Protected" block of `/foreman perms list`: id, kind, glob, note, check mode (when set) and source of each entry. */
export function protectedBlock(r: Pick<Resolved, "protected">): string[] {
  if (r.protected.length === 0) return [];
  return ["Protected:", ...r.protected.map((e) => `  ${e.id}: ${e.kind} ${e.glob}${e.note ? ` - ${e.note}` : ""}${e.check ? ` [check: ${e.check}]` : ""} (${e.source})`)];
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
    for (const k of Object.keys(x)) if (k !== kind && k !== "note" && k !== "check") notices.push(`${at} (${kind} '${clip(g)}') has an unknown key '${clip(k)}'; ignored`);
    let check: ProtectedCheckMode | undefined;
    if (x.check !== undefined) {
      if ((PROTECTED_CHECK_MODES as readonly unknown[]).includes(x.check)) check = x.check as ProtectedCheckMode;
      else {
        check = "ask";
        notices.push(`${at} (${kind} '${clip(g)}') check '${clip(String(x.check))}' must be model, read-only or ask; treated as ask`);
      }
    }
    out.push({ kind, glob: g.trim(), ...(typeof n === "string" && n.trim() !== "" ? { note: n.trim() } : {}), ...(check ? { check } : {}) });
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
  const body: PermBody = { additionalDirectories: [], classifier: { deny: [] }, ignored: [] };
  if (o.protected !== undefined) {
    if (dropped) dropped.push(`${where}protected`);
    else {
      const l = protectedList(o.protected, where, notices);
      if (l === null) return `${where}protected must be a list`;
      body.protected = l;
    }
  }
  for (const k of ["mode", "allow", "ask", "deny"] as const) if (o[k] !== undefined) body.ignored.push(k);
  const l = strList(o.additionalDirectories, `${where}additionalDirectories`, notices);
  if (l === null) return `${where}additionalDirectories must be a list of strings`;
  body.additionalDirectories = l;
  if (o.classifier !== undefined) {
    if (!isObj(o.classifier)) return `${where}classifier must be an object`;
    if (o.classifier.allow !== undefined) body.ignored.push("classifier.allow");
    const d = strList(o.classifier.deny, `${where}classifier.deny`, notices);
    if (d === null) return `${where}classifier.deny must be a list of strings`;
    body.classifier.deny = d;
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
  if (raw.profiles !== undefined) body.ignored.push("profiles");
  if (kind === "tracked" && raw.additionalDirectories !== undefined) dropped.push("additionalDirectories");
  if (kind === "tracked") body.additionalDirectories = [];
  return { ok: true, body, dropped, workFolders, notices };
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
  }

  /** Monotonic: grows on every reload, protected write and re-resolve that saw a change. */
  get version(): number {
    return this.resolve().version;
  }

  /** Every protected write: forget everything read so far. */
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
      if (parsed && "error" in parsed) this.note(`${file} is invalid: ${parsed.error}. The file is ignored.`);
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
    const sig = [user.sig, project.sig, tracked.sig, distrust ?? "trusted"].join("|");
    if (this.cached && this.cached.sig === sig) return this.cached.resolved;

    const parts: { src: string; body: PermBody }[] = [];
    const userOk = user.parsed?.ok === true ? user.parsed : null;
    const userBody = userOk ? userOk.body : null;
    if (userBody) parts.push({ src: "user", body: userBody });
    if (project.parsed?.ok) {
      if (distrust === null) parts.push({ src: "project", body: project.parsed.body });
      else {
        const t: PermBody = { ...project.parsed.body, additionalDirectories: [], protected: [] };
        if (project.parsed.body.protected?.length) this.note(`${this.filePath("project")}: ${distrust}, so protected is not honoured; dropped`);
        parts.push({ src: "project", body: t });
        if (project.parsed.body.additionalDirectories.length) this.note(`${this.filePath("project")}: ${distrust}, so only its classifier.deny key applies (additionalDirectories is ignored)`);
      }
    }
    if (tracked.parsed?.ok) parts.push({ src: "tracked", body: tracked.parsed.body });

    const prose = { deny: [] as ProseEntry[] };
    const dirs: string[] = [];
    const prot: ProtectedEntry[] = [];
    const ignored: string[] = [];
    for (const p of parts) {
      for (const e of p.body.protected ?? []) prot.push({ ...e, id: `P${prot.length + 1}`, source: p.src });
      for (const k of p.body.ignored) ignored.push(`${p.src} ${k}`);
      for (const text of p.body.classifier.deny) {
        if (text.length > PROSE_MAX) {
          this.note(`${p.src} classifier.deny entry '${clip(text)}' is longer than ${PROSE_MAX} characters; skipped`);
          continue;
        }
        prose.deny.push({ id: `D${prose.deny.length + 1}`, text, source: p.src });
      }
      for (const d of p.body.additionalDirectories) dirs.push(this.expandDir(d));
    }

    const workFolderNotes: string[] = [];
    const workFolders = this.validFolders(userOk?.workFolders ?? [], workFolderNotes);
    const resolved: Resolved = { prose, protected: prot, ignored, version: ++this.ver, additionalDirectories: [...new Set(dirs)], workFolders, workFolderNotes, projectTrusted: project.parsed?.ok ? distrust === null : this.projectDistrust() === null, projectFile: this.filePath("project"), noteTools: [...new Set(userBody?.noteTools ?? [])] };
    this.cached = { sig, resolved };
    return resolved;
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
   * The `protected` writer (foreman_protect, `/foreman perms protect`): adds or removes one entry in the `protected` list of the trusted project file or
   * the user file, keeping the file's other keys and their order, with the symlink, trust and atomic-write checks of the other writers. The entry is
   * re-validated here; a duplicate add and a missing remove are refused. Reloads (a version bump that clears the gate caches) on success.
   */
  writeProtected(file: "project" | "user", op: "add" | "remove", entry: { kind: string; glob: string; note?: string; check?: string }): { ok: true; file: string } | { ok: false; reason: string } {
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
      if (at >= 0) return { ok: false, reason: `not written: ${clean.kind} ${clean.glob} is already protected in ${target}; to change its note or check, remove it and add it again` };
      list.push({ [clean.kind]: clean.glob, ...(clean.note ? { note: clean.note } : {}), ...(clean.check ? { check: clean.check } : {}) });
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
export function cleanProtected(e: { kind: unknown; glob: unknown; note?: unknown; check?: unknown }): ProtectedRaw | string {
  if (e.kind !== "host" && e.kind !== "path" && e.kind !== "command") return "kind must be host, path or command";
  const strip = (s: string): string => s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim();
  if (typeof e.glob !== "string") return "glob must be a string";
  const glob = strip(e.glob);
  if (glob === "" || glob.length > PROSE_MAX) return `glob must be 1 to ${PROSE_MAX} characters`;
  const rawNote = e.note;
  if (rawNote !== undefined && typeof rawNote !== "string") return "note must be a string";
  const note = typeof rawNote === "string" ? strip(rawNote) : "";
  if (note.length > PROTECTED_NOTE_MAX) return `note must be at most ${PROTECTED_NOTE_MAX} characters`;
  const check = e.check === undefined ? undefined : (PROTECTED_CHECK_MODES as readonly unknown[]).includes(e.check) ? (e.check as ProtectedCheckMode) : "ask";
  return { kind: e.kind, glob, ...(note ? { note } : {}), ...(check ? { check } : {}) };
}
