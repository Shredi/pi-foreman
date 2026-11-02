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
import { parseRule } from "./rules.ts";
import type { ParsedRule, RuleSets } from "./rules.ts";

export type PermMode = "auto" | "ask" | "allow" | "deny";
export const PERM_MODES: readonly PermMode[] = ["auto", "ask", "allow", "deny"];
export const PROSE_MAX = 300;
export const PROFILE_ENV = "PI_FOREMAN_PERMS_PROFILE";

/** The file shape both files and profiles share. */
export interface PermBody {
  mode?: PermMode;
  allow: string[];
  ask: string[];
  deny: string[];
  additionalDirectories: string[];
  classifier: { allow: string[]; deny: string[] };
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
  profile: string | null;
  rules: RuleSets;
  entries: RuleEntry[];
  prose: { allow: ProseEntry[]; deny: ProseEntry[] };
  /** Absolute directories the read roots widen by. */
  additionalDirectories: string[];
  /** The project file may widen (untracked, ignored, no symlink). */
  projectTrusted: boolean;
  /** The project file as the remember writer would write it. */
  projectFile: string;
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

function parseBody(o: Json, where: string, notices: string[]): PermBody | string {
  const body: PermBody = { allow: [], ask: [], deny: [], additionalDirectories: [], classifier: { allow: [], deny: [] } };
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
  const body = parseBody(raw, "", notices);
  if (typeof body === "string") return { ok: false, error: body };
  const profiles: Record<string, PermBody> = {};
  const dropped: string[] = [];
  if (raw.profiles !== undefined) {
    if (kind !== "user") dropped.push("profiles");
    else if (!isObj(raw.profiles)) return { ok: false, error: "profiles must be an object" };
    else {
      for (const [name, v] of Object.entries(raw.profiles)) {
        if (!isObj(v)) {
          notices.push(`profiles.${name} is not an object; skipped`);
          continue;
        }
        const b = parseBody(v, `profiles.${name}.`, notices);
        if (typeof b === "string") notices.push(`${b}; profile skipped`);
        else profiles[name] = b;
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
  return { ok: true, body, profiles, dropped, notices };
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

  /** `/foreman perms reload` and every remember write: forget everything read so far. */
  reload(): void {
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
        const t = { ...project.parsed.body, allow: [], additionalDirectories: [], classifier: { allow: [], deny: project.parsed.body.classifier.deny } };
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
    for (const p of parts) {
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
    if (this.sessionMode) {
      mode = this.sessionMode;
      modeSource = "session";
    }
    const resolved: Resolved = { mode, modeSource, profile, rules: sets, entries, prose, additionalDirectories: [...new Set(dirs)], projectTrusted: project.parsed?.ok ? distrust === null : this.projectDistrust() === null, projectFile: this.filePath("project") };
    this.cached = { sig, resolved };
    return resolved;
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
}
