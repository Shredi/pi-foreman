// Plan publication for the side panel (herdr-app plan mod): <scratch dir>/show/<sessionId>/ holds plan.json (what the
// session tracks as its plan, its version and the hashes of two snapshots), plan.ruled.md (the plan at the last ruling
// point) and plan.prev.md (the snapshot before that). The mod reads them through the radar's `show` pointer (livestate.ts).
//
// The plan itself is never copied as "current": plan.json.path names the tracked file, the scratch plan-<topic>.md of a top-level
// foreman or <handoff dir>/plan.md of a child session. Every plan is read through the guarded readers (readPlan, readHandoffPlan:
// no symlink, one hard link, 256 KiB, O_NOFOLLOW); a file that fails the check is not read, not hashed, not copied, and `path` is cleared.
//
// Ruling points roll the snapshots in a fixed order that keeps plan.json consistent when a step fails: (1) the new copy goes to a temp
// file, (2) plan.ruled.md is renamed to plan.prev.md (ENOENT = skip), (3) the temp file is renamed to plan.ruled.md, (4) plan.json is
// written last. All writes of a session go through one promise queue, and a job reads the plan when it runs, never when it was queued.
//
// Notes (`foreman_show`): note.md, note.prev.md (kept only while the title stays the same) and note.json (written last) in the same dir.
// Diagram sidecars (diagrams/<sha>-dark.svg and -light.svg, mermaid.ts) are rendered by a second chain after the document is published:
// the write that published a plan or note never waits for a render, and plan.json / note.json list the sidecars once they exist.
//
// Pages (pages.ts): <show dir>/pages/ holds plan.html, note-<n>.html (the last 20), result.html and pages.json (`{v:1, pages, events}`). The plan
// page is written on each trigger call whether or not plan.json changed, on a checkpoint answer and a plan-review verdict, and again when its diagrams
// are listed; a note page by every foreman_show; the result page from the child's result.md through the guarded reader. `pages/` is made one level at a
// time and checked with realDir; a delete only ever names a file derived from a page id, inside that checked dir, after lstat.
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { clean, handoffPlanPath, HANDOFF_PLAN, HANDOFF_RESULT, isPlanPath, PLAN_MAX_BYTES, planBody, planHash, readHandoffPlan, readHandoffResult, readPlan, sha256 } from "./checkpoint.ts";
import type { PlanOpts } from "./checkpoint.ts";
import { scratchRoot } from "./editmode.ts";
import { planReviewFiles } from "./findings.ts";
import { liveDir } from "./livestate.ts";
import type { LiveShow } from "./livestate.ts";
import { createEngine, DIAGRAMS_DIR, diagramName, renderSidecars, scanFences, sidecarOnDisk, SVG_MAX_BYTES, validateSvg } from "./mermaid.ts";
import type { Diagram, Engine, Fence } from "./mermaid.ts";
import { EVENTS_MAX, fileOfId, foldPlanSection, NOTES_KEPT, noteId, PAGES_DIR, PAGES_JSON, parsePagesJson, renderHtmlPlanPage, renderPage } from "./pages.ts";
import type { PageEntry, PageEvent, PagesIndex, Svgs } from "./pages.ts";
import { resolveToolPath } from "./payload.ts";
import { planPathsOf } from "./planreview.ts";
import { workspaceOf } from "./python.ts";
import { realDeep } from "./triage.ts";

export const SHOW_TOOL = "foreman_show";
export const SHOW_DIR = "show";
export const PLAN_JSON = "plan.json";
export const PLAN_RULED = "plan.ruled.md";
export const PLAN_PREV = "plan.prev.md";
export const NOTE_MD = "note.md";
export const NOTE_PREV = "note.prev.md";
export const NOTE_JSON = "note.json";
export const NOTE_TITLE_MAX = 120;
export const NOTE_MAX_BYTES = 256 * 1024;
const ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const JSON_MAX_BYTES = 64 * 1024;
const RETRY_MS = 50;
/** `Plan from <label>: <path>` and the alias `foreman:plan <path>` (a child's plan notice). */
const PLAN_NOTICE = /^(?:Plan from \S+: |foreman:plan )/;

/** plan.json. `path` is null when the tracked plan failed the guarded read. `fences` stays empty until diagrams exist. */
export interface PlanJson {
  path: string | null;
  title: string;
  v: number;
  at: string;
  hash: string;
  ruledPath: string | null;
  ruledHash: string | null;
  prevHash: string | null;
  /** Shas of the mermaid fences that have both sidecars. */
  fences: string[];
  /** The same fences with the relative sidecar paths; the key is absent while there are none. */
  diagrams?: Diagram[];
}

/** note.json. */
export interface NoteJson {
  v: number;
  title: string;
  at: string;
  hash: string;
  prevHash: string | null;
  fences: string[];
  diagrams: Diagram[];
}

export interface NoteResult {
  v: number;
  /** Mermaid fences in the note (their sidecars are rendered after this returns). */
  diagrams: number;
  path: string;
  /** The note's page file, or null when the page could not be written (the note itself is published). */
  page: string | null;
}

/** The plan page of a trigger: its file, or why there is none. */
export type PageOutcome = { path: string } | { reason: string };

/** What the owner or the review decided about the plan the page shows. */
const PLAN_STATES: readonly string[] = ["draft", "in review", "waits for you", "approved", "revise", "rejected"];
export type PlanState = "draft" | "in review" | "waits for you" | "approved" | "revise" | "rejected";

/** The file operations of the show dir, replaceable by tests to inject a failure at one step. */
export interface ShowIo {
  /** Non-recursive; an existing dir is not an error. */
  mkdir(dir: string): Promise<void>;
  /** Exclusive create: a temp file never follows a planted name. */
  writeFile(file: string, data: string | Buffer): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** Force: a missing file is not an error. */
  rm(file: string): Promise<void>;
}

const realIo: ShowIo = {
  mkdir: async (dir) => {
    try {
      await fs.promises.mkdir(dir);
    } catch (e) {
      if (codeOf(e) !== "EEXIST") throw e;
    }
  },
  writeFile: (file, data) => fs.promises.writeFile(file, data, { flag: "wx" }),
  rename: (from, to) => fs.promises.rename(from, to),
  rm: (file) => fs.promises.rm(file, { force: true }),
};

export interface ShowInit {
  agentDir: string;
  sessionId: string;
  cwd: string;
  home: string;
  platform: string;
  scratchDir: string;
  /** env PI_FOREMAN_HANDOFF_DIR of a child session, else null. */
  handoffDir: string | null;
  trace?: (rec: Record<string, unknown>) => void;
  /** Called after plan.json changed on disk (the adapter flushes the live file). */
  onChange?: () => void;
  io?: Partial<ShowIo>;
  /** Replaces the mermaid render engine (tests). */
  engine?: (onMissing: () => void) => Engine;
}

type Tracked = { kind: "scratch"; path: string } | { kind: "handoff" };

const fold = (platform: string) => (platform === "win32" || platform === "darwin" ? (s: string) => s.toLowerCase() : (s: string) => s);
/** Real folder or throw: lstat, so a symlink (planted by agent content) never counts. */
function realDir(dir: string): void {
  if (!fs.lstatSync(dir).isDirectory()) throw Object.assign(new Error("show dir is not a directory"), { code: "ENOTDIR" });
}

const codeOf = (e: unknown): string => String((e as { code?: unknown } | null)?.code ?? (e instanceof Error ? e.name : "error"));
const isStr = (v: unknown): v is string => typeof v === "string";
const isStrOrNull = (v: unknown): v is string | null => v === null || typeof v === "string";

/** First `# ` heading of the plan body, else its first non-blank line (a comment line such as the generated marker skipped), at most 120 chars without control characters. */
export function titleOf(bytes: Buffer): string {
  const lines = planBody(bytes).toString("utf8").split(/\r?\n/);
  const heading = lines.map((l) => /^#[ \t]+(.+?)[ \t#]*$/.exec(l)).find((m) => m);
  const raw = heading ? heading[1] : (lines.find((l) => l.trim() && !l.startsWith("<!--")) ?? "");
  return raw.replace(/[\u0000-\u001f\u007f\u0080-\u009f]/g, " ").trim().slice(0, 120) || "plan";
}

/** The page title of a read plan: an HTML plan's own `<h1>` (else `<title>`), else the first heading or line of its markdown. */
function titleOfCur(cur: Cur): string {
  const own = cur.kind === "html" ? (cur.title ?? "").replace(/[\u0000-\u001f\u007f\u0080-\u009f]/g, " ").trim().slice(0, 120) : "";
  return own || titleOf(cur.kind === "html" ? Buffer.from(cur.markdown, "utf8") : cur.bytes);
}

/** A tracked plan as read now: the source bytes and their version hash, and for an HTML plan the generated markdown copy, title and rulings. */
interface Cur {
  path: string;
  bytes: Buffer;
  hash: string;
  kind: "md" | "html";
  markdown: string;
  title: string | null;
  rulings: string;
}

/** plan.json text -> PlanJson, or null when a field has the wrong type. */
export function parsePlanJson(text: string): PlanJson | null {
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    if (!j || typeof j !== "object" || !isStrOrNull(j.path) || !isStr(j.title) || !Number.isInteger(j.v) || (j.v as number) < 1 || !isStr(j.at) || !isStr(j.hash)) return null;
    if (!isStrOrNull(j.ruledPath) || !isStrOrNull(j.ruledHash) || !isStrOrNull(j.prevHash) || !Array.isArray(j.fences) || !j.fences.every(isStr)) return null;
    const diagrams = Array.isArray(j.diagrams) && j.diagrams.every(isDiagram) ? (j.diagrams as Diagram[]) : undefined;
    return { path: j.path, title: j.title, v: j.v as number, at: j.at, hash: j.hash, ruledPath: j.ruledPath, ruledHash: j.ruledHash, prevHash: j.prevHash, fences: j.fences, ...(diagrams?.length ? { diagrams } : {}) };
  } catch {
    return null;
  }
}

const isDiagram = (d: unknown): d is Diagram => !!d && typeof d === "object" && isStr((d as Diagram).sha) && isStr((d as Diagram).dark) && isStr((d as Diagram).light);

/** note.json text -> NoteJson, or null when a field has the wrong type. */
export function parseNoteJson(text: string): NoteJson | null {
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    if (!j || typeof j !== "object" || !Number.isInteger(j.v) || (j.v as number) < 1 || !isStr(j.title) || !isStr(j.at) || !isStr(j.hash) || !isStrOrNull(j.prevHash)) return null;
    if (!Array.isArray(j.fences) || !j.fences.every(isStr) || !Array.isArray(j.diagrams) || !j.diagrams.every(isDiagram)) return null;
    return { v: j.v as number, title: j.title, at: j.at, hash: j.hash, prevHash: j.prevHash, fences: j.fences, diagrams: j.diagrams };
  } catch {
    return null;
  }
}

function readNoteMeta(file: string): NoteJson | null {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > JSON_MAX_BYTES) return null;
    return parseNoteJson(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function readMeta(file: string): PlanJson | null {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > JSON_MAX_BYTES) return null;
    return parsePlanJson(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** pages.json, validated entry by entry (pages.ts parsePagesJson); null when it is missing, too big or not an index. */
function readPages(file: string): PagesIndex | null {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > JSON_MAX_BYTES) return null;
    return parsePagesJson(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** A sidecar SVG as text: a regular file within the size cap that passes the allow-list again; else null. */
function readSidecar(dir: string, name: string): string | null {
  try {
    const file = path.join(dir, name);
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > SVG_MAX_BYTES) return null;
    const svg = fs.readFileSync(file, "utf8");
    return validateSvg(svg) === null ? svg : null;
  } catch {
    return null;
  }
}

/** The version hash of a snapshot: a snapshot holds the source bytes, so it is hashed by the name of the tracked plan (an `.html` page hashes whole). */
function ruledHashOnDisk(file: string, planName: string): string | null {
  try {
    const st = fs.lstatSync(file);
    return st.isFile() && st.size <= PLAN_MAX_BYTES ? planHash(planName, fs.readFileSync(file)) : null;
  } catch {
    return null;
  }
}

function noteHashOnDisk(file: string): string | null {
  try {
    const st = fs.lstatSync(file);
    return st.isFile() && st.size <= NOTE_MAX_BYTES ? sha256(fs.readFileSync(file)) : null;
  } catch {
    return null;
  }
}

/** Why a session has no Show (Show.start returned null or never ran): live state off, an unsafe session id, else the scratch dir is off. */
export function showOffReason(hasLive: boolean, sessionId: string): string {
  if (!hasLive) return "live state off";
  return !ID_RE.test(sessionId) || sessionId === "." || sessionId === ".." ? "session id unsafe" : "scratch dir off";
}

/** The checkpoint dialog's plan page line: waits up to `waitMs` for the page write, then names the file URL or the real reason. No promise: `off` says why (default: the scratch dir is off). */
export async function planPageLine(page: Promise<PageOutcome> | undefined, waitMs = 3000, off = "scratch dir off"): Promise<string> {
  if (!page) return `Plan page: not available (${off})`;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<PageOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ reason: "page not written yet" }), waitMs);
  });
  try {
    const r = await Promise.race([page, late]);
    return "path" in r ? `Plan page: ${pathToFileURL(r.path).href} (a path on this session's machine)` : `Plan page: not available (${r.reason})`;
  } finally {
    clearTimeout(timer);
  }
}

export class Show {
  /** Absolute show dir of this session. */
  readonly dir: string;
  private meta: PlanJson | null;
  private noteMeta: NoteJson | null = null;
  private pages: PagesIndex = { v: 1, pages: [], events: [] };
  /** The state of the plan version with this hash; any other version is a draft. */
  private pstate: { state: PlanState; hash: string | null } | null = null;
  /** The latest note as written, for the page rewrite when its diagrams arrive (a model-written html page has none). */
  private noteSrc: { hash: string; markdown: string; html: boolean } | null = null;
  private tracked: Tracked | null = null;
  private q: Promise<void> = Promise.resolve();
  /** The render chain: sidecars only, never awaited by a publication. */
  private rq: Promise<void> = Promise.resolve();
  private noModule = false;
  private seq = 0;
  private readonly io: ShowIo;

  /** Null when the scratch root is disabled or the session id is not a safe folder name: no show dir, no live field. */
  static start(init: ShowInit): Show | null {
    if (!ID_RE.test(init.sessionId) || init.sessionId === "." || init.sessionId === "..") return null;
    const root = scratchRoot(realDeep(path.resolve(workspaceOf(init.cwd).root)), init.scratchDir, init.platform);
    if (!root) return null;
    const show = new Show(init, path.join(root, SHOW_DIR));
    show.prune(init.agentDir);
    return show;
  }

  private readonly init: ShowInit;
  private readonly showRoot: string;

  private constructor(init: ShowInit, showRoot: string) {
    this.init = init;
    this.showRoot = showRoot;
    this.dir = path.join(showRoot, init.sessionId);
    this.io = { ...realIo, ...init.io };
    this.meta = null;
    try {
      // both levels must be real folders before anything is read from them (a planted link would feed us a foreign plan.json)
      realDir(this.showRoot);
      realDir(this.dir);
      this.meta = readMeta(path.join(this.dir, PLAN_JSON)); // v continues across a reload
      this.noteMeta = readNoteMeta(path.join(this.dir, NOTE_JSON));
      const pages = path.join(this.dir, PAGES_DIR);
      if (fs.existsSync(pages)) {
        realDir(pages);
        this.pages = readPages(path.join(pages, PAGES_JSON)) ?? this.pages;
        const entry = this.pages.pages.find((p) => p.id === "plan");
        if (entry && this.meta && entry.version === this.meta.v && PLAN_STATES.includes(entry.state)) this.pstate = { state: entry.state as PlanState, hash: this.meta.hash };
      }
    } catch (e) {
      if (codeOf(e) === "ENOTDIR") init.trace?.({ event: "show_error", kind: "start", errorKind: "ENOTDIR" });
    }
  }

  /** The live file's `show` pointer: the dir, and the plan version while a plan is published. */
  field(): LiveShow {
    return { dir: this.dir, ...(this.meta && this.meta.path !== null ? { plan: this.meta.v } : {}), ...(this.noteMeta ? { note: this.noteMeta.v } : {}) };
  }

  /** The current plan.json as this session wrote it (null before the first publication). */
  get plan(): PlanJson | null {
    return this.meta;
  }

  /** Resolves when every queued write and render has finished (a failed job never rejects it). */
  async idle(): Promise<void> {
    for (;;) {
      const [q, rq] = [this.q, this.rq];
      await Promise.all([q, rq]);
      if (q === this.q && rq === this.rq) return;
    }
  }

  /**
   * `foreman_show`: publish a note. Resolves once note.json is on disk; the diagram sidecars come later (renderChain). The caller checks the
   * caps; a title or text over them is refused here too. Rejects when a write failed (the note is then not published).
   */
  note(title: string, markdown: string, html?: string): Promise<NoteResult> {
    return new Promise<NoteResult>((resolve, reject) => {
      this.q = this.q.then(async () => {
        try {
          resolve(await this.writeNote(title, markdown, html));
        } catch (e) {
          reject(e);
          throw e;
        }
      }).catch((e) => this.init.trace?.({ event: "show_error", kind: "note", errorKind: codeOf(e) }));
    });
  }

  /** A write or edit tool result named `raw`: track it when it is the scratch plan or the handoff plan, and refresh plan.json. */
  planWritten(raw: unknown): boolean {
    const t = this.trackedFor(raw);
    if (!t) return false;
    this.tracked = t;
    this.enqueue("refresh", async () => {
      await this.sync(false);
      await this.planPage();
    });
    return true;
  }

  /**
   * `foreman_checkpoint` passed the plan guards for `planPath`: track it and roll the snapshots. The promise is for this call's own plan page write
   * (not for the diagram renders) and never rejects: the file, or the reason there is none. `state` is "approved" for a plan the owner approved before.
   */
  checkpointed(planPath: string, state: PlanState = "waits for you"): Promise<PageOutcome> {
    this.tracked = { kind: "scratch", path: planPath };
    return new Promise<PageOutcome>((resolve) => {
      this.enqueue("checkpoint", async () => {
        try {
          await this.sync(true);
          this.setState(state);
          resolve(await this.planPage());
        } catch (e) {
          resolve({ reason: `page failed: ${codeOf(e)}` });
          throw e;
        }
      });
    });
  }

  /** The owner answered the checkpoint for the plan version `hash`: rewrite the plan page with the new state and add the milestone. */
  planDecided(state: "approved" | "revise" | "rejected", hash: string): void {
    this.enqueue("decided", async () => {
      await this.sync(false);
      this.pstate = { state, hash };
      await this.planPage({ kind: "checkpoint", text: state === "approved" ? "You approved the plan" : state === "revise" ? "You asked for a revision of the plan" : "You rejected the plan", page: "plan" });
    });
  }

  /** A plan-review verdict for the plan version `hash`: a PASS leaves the draft for the checkpoint, a FAIL asks for a revision. */
  planReviewed(pass: boolean, hash: string): void {
    this.enqueue("verdict", async () => {
      await this.sync(false);
      this.pstate = { state: pass ? "draft" : "revise", hash };
      await this.planPage({ kind: "plan_review", text: `Plan review: ${pass ? "PASS" : "FAIL"}`, page: "plan" });
    });
  }

  /** A milestone for the page list (PR opened, ready or merged); `page` names the page it belongs to. */
  milestone(kind: string, text: string, page?: string): void {
    this.enqueue("milestone", async () => {
      const dir = await this.ensurePages();
      await this.writeIndex(dir, this.pages.pages, { kind, text, ...(page ? { page } : {}) });
    });
  }

  /** A write or edit tool result named `raw`: when it is this child session's `<handoff dir>/result.md`, publish the result page (guarded read, no close.ts trigger). */
  resultWritten(raw: unknown): boolean {
    if (!this.resultNamed(raw)) return false;
    this.enqueue("result", async () => {
      const r = this.init.handoffDir ? readHandoffResult(this.init.handoffDir, this.init.platform) : null;
      if (!r || "error" in r) return;
      const markdown = r.bytes.toString("utf8");
      const title = clean(/^#[ \t]+(.+?)[ \t#]*$/m.exec(markdown)?.[1] ?? "").slice(0, 120) || "Result";
      const version = (this.pages.pages.find((p) => p.id === "result")?.version ?? 0) + 1;
      const html = renderPage({ title, kicker: `Result · v${version}`, markdown, source: HANDOFF_RESULT });
      await this.putPage({ id: "result", kind: "result", title, state: "written", version }, html, { kind: "result", text: "Result written", page: "result" });
    });
    return true;
  }

  /**
   * A `[plan-review]` launch passed every check. The plan the task names (a scratch plan, or in a child session the handoff plan by
   * the path as written or as its realpath) becomes the tracked one under the path-change rule, then the snapshots roll. Any other
   * path in the task leaves tracking unchanged.
   */
  planReviewLaunched(task: string): void {
    const t = this.handoffNamedIn(task) ? ({ kind: "handoff" } as Tracked) : this.scratchNamedIn(task);
    if (!t) return;
    this.tracked = t;
    this.enqueue("review", async () => {
      await this.sync(true);
      this.setState("in review");
      await this.planPage();
    });
  }

  /** A successful `intercom` send: a `Plan from <label>: <path>` or `foreman:plan <path>` notice rolls the snapshots of the tracked plan. */
  planSent(message: unknown): void {
    if (!isStr(message) || !PLAN_NOTICE.test(message)) return;
    const named = this.trackedFor(message.replace(PLAN_NOTICE, "").split(/\r?\n/, 1)[0].trim());
    if (named) this.tracked = named;
    else if (!this.tracked && this.trackedHtml() && this.meta?.path) this.tracked = { kind: "scratch", path: this.meta.path }; // after a reload the page from plan.json is the plan
    if (!this.tracked) return;
    this.enqueue("send", async () => {
      await this.sync(true);
      await this.planPage();
    });
  }

  private get planOpts(): PlanOpts {
    const i = this.init;
    return { cwd: i.cwd, home: i.home, platform: i.platform, scratchDir: i.scratchDir };
  }

  /** The tracked plan is a scratch HTML page: the handoff `plan.md` of a child is its text copy for the parent, never the page source. */
  private trackedHtml(): boolean {
    // after a reload or resume nothing is tracked in memory: the page loaded from plan.json still counts
    const p = this.tracked ? (this.tracked.kind === "scratch" ? this.tracked.path : null) : (this.meta?.path ?? null);
    return !!p && p.endsWith(".html") && fs.existsSync(p); // a deleted page is no page source: the handoff plan.md is the plan again
  }

  private trackedFor(raw: unknown): Tracked | null {
    const abs = resolveToolPath(raw, this.init.cwd, this.init.home);
    if (abs && isPlanPath(abs, this.planOpts)) {
      // a page and its markdown copy are one plan, tracked under the page's path
      const r = readPlan(abs, this.planOpts);
      return { kind: "scratch", path: "plan" in r ? r.plan.path : abs };
    }
    if (!handoffPlanPath(raw, this.init.handoffDir, this.planOpts)) return null;
    return this.trackedHtml() ? null : { kind: "handoff" };
  }

  /** A write of the rulings sidecar of the tracked HTML plan: the page is written again (it shows the rulings); the tracked path and the snapshots do not change. */
  rulingsWritten(planPath: string): void {
    const f = fold(this.init.platform);
    if (this.tracked?.kind !== "scratch" || f(realDeep(this.tracked.path)) !== f(realDeep(planPath))) return;
    this.enqueue("rulings", async () => {
      await this.planPage();
    });
  }

  private resultNamed(raw: unknown): boolean {
    const dir = this.init.handoffDir?.trim();
    const abs = resolveToolPath(raw, this.init.cwd, this.init.home);
    if (!dir || !path.isAbsolute(dir) || !abs) return false;
    const f = fold(this.init.platform);
    const real = path.join(realDeep(path.dirname(abs)), path.basename(abs));
    return f(path.dirname(real)) === f(realDeep(path.resolve(dir))) && path.basename(real) === HANDOFF_RESULT;
  }

  private namesHandoff(task: string): boolean {
    const dir = this.init.handoffDir?.trim();
    if (!dir || !path.isAbsolute(dir)) return false;
    return [path.join(dir, HANDOFF_PLAN), path.join(realDeep(path.resolve(dir)), HANDOFF_PLAN)].some((p) => task.includes(p));
  }

  /** The task names the handoff plan and the session does not track a scratch page (that stays the page source). */
  private handoffNamedIn(task: string): boolean {
    return !this.trackedHtml() && this.namesHandoff(task);
  }

  /** The scratch plan a task names that passes the guarded read: the tracked one when it is named, else the first. */
  private scratchNamedIn(task: string): Tracked | null {
    if (this.trackedHtml() && this.namesHandoff(task)) return this.tracked ?? (this.meta?.path ? { kind: "scratch", path: this.meta.path } : null); // the review of the child's text copy is the review of its page
    const f = fold(this.init.platform);
    const named = planPathsOf(planReviewFiles(task, null), this.init.scratchDir)
      .map((p) => resolveToolPath(p, this.init.cwd, this.init.home))
      .flatMap((abs) => {
        const r = abs && isPlanPath(abs, this.planOpts) ? readPlan(abs, this.planOpts) : null;
        return r && "plan" in r ? [r.plan.path] : []; // a page and its copy: the page's path
      });
    const cur = this.tracked?.kind === "scratch" ? this.tracked.path : null;
    const keep = cur && named.find((p) => f(realDeep(p)) === f(realDeep(cur)));
    const pick = keep ?? named[0];
    return pick ? { kind: "scratch", path: pick } : null;
  }

  /** `q = q.then(job).catch(trace)`: a failed job never stalls the chain. */
  private enqueue(op: string, job: () => Promise<void>): void {
    this.q = this.q.then(job).catch((e) => this.init.trace?.({ event: "show_error", kind: op, errorKind: codeOf(e) }));
  }

  private read(t: Tracked): Cur | null {
    if (t.kind === "handoff") {
      const r = this.init.handoffDir ? readHandoffPlan(this.init.handoffDir, this.init.platform) : null;
      return r && "plan" in r ? { ...r.plan, kind: "md", markdown: r.plan.bytes.toString("utf8"), title: null, rulings: "" } : null;
    }
    const r = readPlan(t.path, this.planOpts);
    return "plan" in r ? { path: r.plan.path, bytes: r.plan.bytes, hash: r.plan.hash, kind: r.plan.kind, markdown: r.plan.markdown, title: r.plan.title ?? null, rulings: r.plan.rulings ?? "" } : null;
  }

  /** One queued job: read the tracked plan now, apply the path-change rule, refresh plan.json, and roll when asked and the version differs from the ruled one. */
  private async sync(roll: boolean): Promise<void> {
    const t = this.tracked;
    if (!t) return;
    const prev = this.meta;
    const cur = this.read(t);
    if (!cur) {
      if (prev && prev.path !== null) await this.writeMeta({ ...prev, path: null }); // a swapped or vanished file is never followed
      return;
    }
    await this.ensureDir(); // before any rm or write: both levels are real folders or this job fails here
    const f = fold(this.init.platform);
    const moved = (prev?.path != null && f(prev.path) !== f(cur.path)) || (prev?.ruledPath != null && f(prev.ruledPath) !== f(cur.path));
    if (moved) {
      await this.io.rm(path.join(this.dir, PLAN_RULED));
      await this.io.rm(path.join(this.dir, PLAN_PREV));
    }
    const changed = !prev || moved || prev.hash !== cur.hash;
    const meta: PlanJson = {
      path: cur.path,
      title: titleOfCur(cur),
      v: !prev ? 1 : changed ? prev.v + 1 : prev.v,
      at: changed ? new Date().toISOString() : prev.at,
      hash: cur.hash,
      ruledPath: moved ? null : (prev?.ruledPath ?? null),
      ruledHash: moved ? null : (prev?.ruledHash ?? null),
      prevHash: moved ? null : (prev?.prevHash ?? null),
      fences: changed ? [] : (prev?.fences ?? []),
      ...(!changed && prev?.diagrams?.length ? { diagrams: prev.diagrams } : {}),
    };
    if (changed || !prev) this.renderChain("plan", cur.hash, planBody(Buffer.from(cur.markdown, "utf8")).toString("utf8")); // the fences of the markdown copy, for an HTML plan
    if (roll && (meta.ruledPath === null || meta.ruledHash !== cur.hash)) await this.rollTo(cur, meta);
    else if (!prev || JSON.stringify(prev) !== JSON.stringify(meta)) await this.writeMeta(meta);
  }

  private async rollTo(cur: Cur, meta: PlanJson): Promise<void> {
    const ruled = path.join(this.dir, PLAN_RULED);
    const tmp = this.tmpName(ruled);
    // prev.md will hold what ruled.md holds now (it can differ from plan.json after a failed step 4); with no ruled.md, prev.md is left as it is.
    const prevHash = ruledHashOnDisk(ruled, path.basename(cur.path)) ?? meta.ruledHash;
    try {
      await this.io.writeFile(tmp, cur.bytes); // (1)
      try {
        await this.rename(ruled, path.join(this.dir, PLAN_PREV)); // (2)
      } catch (e) {
        if (codeOf(e) !== "ENOENT") throw e; // first roll, or the repair after an earlier step-3 failure
      }
      await this.rename(tmp, ruled); // (3)
    } catch (e) {
      await this.io.rm(tmp).catch(() => undefined);
      throw e;
    }
    await this.writeMeta({ ...meta, ruledPath: cur.path, ruledHash: cur.hash, prevHash }); // (4)
  }

  private async writeMeta(meta: PlanJson): Promise<void> {
    await this.ensureDir();
    await this.atomic(path.join(this.dir, PLAN_JSON), JSON.stringify(meta) + "\n");
    this.meta = meta;
    try {
      this.init.onChange?.();
    } catch {
      // the live refresh is best effort
    }
  }

  /** One queued job: note.md (the previous one rolls to note.prev.md only when the title is unchanged), then note.json last. */
  private async writeNote(rawTitle: string, given: string, html?: string): Promise<NoteResult> {
    const title = rawTitle.replace(/[\u0000-\u001f\u007f\u0080-\u009f]/g, " ").trim();
    if (!title || title.length > NOTE_TITLE_MAX) throw new Error("title");
    // a model-written html page is stored as it is; note.md then only points at it
    const markdown = html === undefined ? given : `# ${title}\n\nThis note is an HTML page: ${PAGES_DIR}/${noteId((this.noteMeta?.v ?? 0) + 1)}.html\n`;
    const bytes = Buffer.from(markdown, "utf8");
    if (bytes.length > NOTE_MAX_BYTES || (html !== undefined && Buffer.byteLength(html, "utf8") > NOTE_MAX_BYTES)) throw new Error("too_large");
    await this.ensureDir();
    const md = path.join(this.dir, NOTE_MD);
    const prev = this.noteMeta;
    const same = prev?.title === title;
    const tmp = this.tmpName(md);
    let prevHash: string | null = null;
    try {
      await this.io.writeFile(tmp, bytes); // (1)
      if (same) {
        try {
          prevHash = noteHashOnDisk(md);
          await this.rename(md, path.join(this.dir, NOTE_PREV)); // (2)
        } catch (e) {
          if (codeOf(e) !== "ENOENT") throw e;
        }
      } else {
        await this.io.rm(path.join(this.dir, NOTE_PREV)); // another note: no previous version to compare with
      }
      await this.rename(tmp, md); // (3)
    } catch (e) {
      await this.io.rm(tmp).catch(() => undefined);
      throw e;
    }
    const fences = scanFences(markdown);
    const keep = prev && prev.hash === sha256(bytes) ? prev : null; // the same text again: its sidecars are already listed
    const meta: NoteJson = { v: (prev?.v ?? 0) + 1, title, at: new Date().toISOString(), hash: sha256(bytes), prevHash: same ? prevHash : null, fences: keep?.fences ?? [], diagrams: keep?.diagrams ?? [] };
    await this.atomic(path.join(this.dir, NOTE_JSON), JSON.stringify(meta) + "\n"); // (4)
    this.noteMeta = meta;
    this.init.trace?.({ event: "show_note", v: meta.v, diagrams: fences.length, bytes: bytes.length });
    try {
      this.init.onChange?.();
    } catch {
      // the live refresh is best effort
    }
    this.noteSrc = { hash: meta.hash, markdown, html: html !== undefined };
    let page: string | null = null;
    try {
      page = await this.notePage(meta, markdown, html);
    } catch (e) {
      this.init.trace?.({ event: "show_error", kind: "page", errorKind: codeOf(e) }); // the note is published; only its page is missing
    }
    if (fences.length > 0) this.renderChain("note", meta.hash, markdown);
    return { v: meta.v, diagrams: fences.length, path: md, page };
  }

  private notePage(meta: NoteJson, markdown: string, html?: string): Promise<string> {
    const body = html ?? renderPage({ title: meta.title, kicker: `Note v${meta.v}`, markdown, svgs: this.svgsFor(meta.diagrams), source: NOTE_MD });
    return this.putPage({ id: noteId(meta.v), kind: "note", title: meta.title, state: "shown", version: meta.v }, body);
  }

  private setState(state: PlanState): void {
    this.pstate = { state, hash: this.meta?.hash ?? null };
  }

  /** Write the plan page of the tracked plan as the guarded reader sees it now; `event` is a milestone of the same write. */
  private async planPage(event?: Omit<PageEvent, "at">): Promise<PageOutcome> {
    const cur = this.tracked ? this.read(this.tracked) : null;
    const meta = this.meta;
    if (!cur || !meta) return { reason: "plan not readable" };
    const state: PlanState = this.pstate && this.pstate.hash === cur.hash ? this.pstate.state : "draft";
    const title = titleOfCur(cur);
    const kicker = `Plan v${meta.v} · ${state} · ${cur.hash.slice(0, 8)}`;
    const svgs = meta.hash === cur.hash ? this.svgsFor(meta.diagrams) : undefined;
    const html = cur.kind === "html"
      ? renderHtmlPlanPage({ title, kicker, html: cur.bytes.toString("utf8"), rulings: cur.rulings, svgs, source: path.basename(cur.path) })
      : renderPage({ title, kicker, markdown: cur.bytes.toString("utf8"), svgs, fold: foldPlanSection, source: path.basename(cur.path) });
    return { path: await this.putPage({ id: "plan", kind: "plan", title, state, version: meta.v }, html, event) };
  }

  /** The SVG texts of the listed diagrams that are still valid sidecars on disk (names derived from the sha, never from the listing). */
  private svgsFor(diagrams: Diagram[] | undefined): Map<string, Svgs> | undefined {
    if (!diagrams?.length) return undefined;
    const dir = path.join(this.dir, DIAGRAMS_DIR);
    const out = new Map<string, Svgs>();
    try {
      realDir(dir);
    } catch {
      return undefined;
    }
    for (const d of diagrams) {
      if (!/^[0-9a-f]{64}$/.test(d.sha)) continue;
      const dark = readSidecar(dir, diagramName(d.sha, "dark"));
      const light = readSidecar(dir, diagramName(d.sha, "light"));
      if (dark !== null && light !== null) out.set(d.sha, { dark, light });
    }
    return out;
  }

  /** `<show dir>/pages`, made one level at a time and checked like diagrams/. */
  private async ensurePages(): Promise<string> {
    await this.ensureDir();
    const dir = path.join(this.dir, PAGES_DIR);
    await this.io.mkdir(dir);
    realDir(dir);
    return dir;
  }

  /** Write a page file, then its index entry (and the milestone); the notes beyond the last NOTES_KEPT are removed afterwards. Returns the page file. */
  private async putPage(e: Omit<PageEntry, "file" | "at">, html: string, event?: Omit<PageEvent, "at">): Promise<string> {
    const file = fileOfId(e.id);
    if (!file) throw new Error("page id");
    const dir = await this.ensurePages();
    await this.atomic(path.join(dir, file), html);
    const prev = this.pages.pages.find((p) => p.id === e.id);
    const entry: PageEntry = { ...e, file, at: prev && prev.title === e.title && prev.state === e.state && prev.version === e.version ? prev.at : new Date().toISOString() };
    let list = prev ? this.pages.pages.map((p) => (p.id === e.id ? entry : p)) : [...this.pages.pages, entry];
    const notes = list.filter((p) => p.kind === "note").sort((a, b) => a.version - b.version);
    const drop = notes.slice(0, Math.max(0, notes.length - NOTES_KEPT));
    list = list.filter((p) => !drop.includes(p));
    await this.writeIndex(dir, list, event);
    for (const d of drop) await this.rmPage(dir, d.id);
    return path.join(dir, file);
  }

  private async writeIndex(dir: string, pages: PageEntry[], event?: Omit<PageEvent, "at">): Promise<void> {
    const events = event ? [...this.pages.events, { at: new Date().toISOString(), ...event }].slice(-EVENTS_MAX) : this.pages.events;
    const idx: PagesIndex = { v: 1, pages, events };
    await this.atomic(path.join(dir, PAGES_JSON), JSON.stringify(idx) + "\n");
    this.pages = idx;
  }

  /** Delete the page of `id`: only the name derived from the id, inside the checked pages dir, and only a regular file. */
  private async rmPage(dir: string, id: string): Promise<void> {
    const file = fileOfId(id);
    if (!file) return;
    try {
      if (!fs.lstatSync(path.join(dir, file)).isFile()) return;
    } catch {
      return;
    }
    await this.io.rm(path.join(dir, file));
  }

  /** Render the missing sidecars of a published document, then list them. Runs after the publication, on its own chain. */
  private renderChain(kind: "plan" | "note", hash: string, markdown: string): void {
    if (this.noModule) return;
    const fences = scanFences(markdown);
    if (fences.length === 0) return;
    this.rq = this.rq.then(() => this.renderJob(kind, hash, fences)).catch((e) => this.init.trace?.({ event: "show_error", kind: "diagrams", errorKind: codeOf(e) }));
  }

  private async renderJob(kind: "plan" | "note", hash: string, fences: Fence[]): Promise<void> {
    if (this.noModule) return;
    const dir = path.join(this.dir, DIAGRAMS_DIR);
    const onMissing = (): void => {
      this.noModule = true; // once per session: later documents skip the render chain
      this.init.trace?.({ event: "show_diagram", outcome: "module_missing" });
    };
    const engine = this.init.engine?.(onMissing) ?? createEngine({ onMissing });
    let shas: string[];
    try {
      await this.ensureDir();
      await this.io.mkdir(dir);
      realDir(dir); // lstat: a planted link is not a folder
      shas = await renderSidecars(engine, fences, {
        write: (name, data) => this.atomic(path.join(dir, name), data),
        trace: (r) => this.init.trace?.(r),
        has: (name) => sidecarOnDisk(dir, name),
      });
    } finally {
      engine.close();
    }
    if (shas.length === 0) return;
    this.enqueue("diagrams", () => this.listDiagrams(kind, hash, shas));
  }

  /** One queued job: add the sidecars to plan.json or note.json when that document is still the one they were rendered for. */
  private async listDiagrams(kind: "plan" | "note", hash: string, shas: string[]): Promise<void> {
    const diagrams: Diagram[] = [...new Set(shas)].map((sha) => ({ sha, dark: `${DIAGRAMS_DIR}/${diagramName(sha, "dark")}`, light: `${DIAGRAMS_DIR}/${diagramName(sha, "light")}` }));
    if (kind === "plan") {
      const m = this.meta;
      if (!m || m.hash !== hash || JSON.stringify(m.diagrams ?? []) === JSON.stringify(diagrams)) return;
      await this.writeMeta({ ...m, fences: diagrams.map((d) => d.sha), diagrams });
      await this.planPage(); // the page shows the diagrams now
      return;
    }
    const n = this.noteMeta;
    if (!n || n.hash !== hash || JSON.stringify(n.diagrams) === JSON.stringify(diagrams)) return;
    const meta: NoteJson = { ...n, fences: diagrams.map((d) => d.sha), diagrams };
    await this.ensureDir();
    await this.atomic(path.join(this.dir, NOTE_JSON), JSON.stringify(meta) + "\n");
    this.noteMeta = meta;
    try {
      this.init.onChange?.();
    } catch {
      // the live refresh is best effort
    }
    if (this.noteSrc && this.noteSrc.hash === hash && !this.noteSrc.html) await this.notePage(meta, this.noteSrc.markdown); // the page shows the diagrams now
  }

  private tmpName(file: string): string {
    return `${file}.${process.pid}.${++this.seq}.tmp`;
  }

  /** Temp file in the same folder, then rename. */
  private async atomic(file: string, data: string | Buffer): Promise<void> {
    const tmp = this.tmpName(file);
    try {
      await this.io.writeFile(tmp, data);
      await this.rename(tmp, file);
    } catch (e) {
      await this.io.rm(tmp).catch(() => undefined);
      throw e;
    }
  }

  /** A rename that fails with EPERM (a reader holds the target on Windows) is retried once after 50 ms. */
  private async rename(from: string, to: string): Promise<void> {
    try {
      await this.io.rename(from, to);
    } catch (e) {
      if (codeOf(e) !== "EPERM") throw e;
      await sleep(RETRY_MS);
      await this.io.rename(from, to);
    }
  }

  /** The show dir exists and neither it nor its parent is a link (agent content could plant one in the checkout). */
  private async ensureDir(): Promise<void> {
    // the scratch dir is checked by editmode; the show root and the session dir are made one level at a time and checked before the next
    await fs.promises.mkdir(path.dirname(this.showRoot), { recursive: true });
    for (const d of [this.showRoot, this.dir]) {
      await this.io.mkdir(d);
      realDir(d);
    }
  }

  /** Remove the show dirs of sessions whose live file is gone (at session start, never this session's). */
  private prune(agentDir: string): void {
    try {
      // lstat: a symlinked show root (planted by agent content) must never be listed or emptied
      try {
        realDir(this.showRoot);
      } catch (e) {
        if (codeOf(e) === "ENOTDIR") this.init.trace?.({ event: "show_error", kind: "prune", errorKind: "ENOTDIR" });
        return;
      }
      for (const name of fs.readdirSync(this.showRoot)) {
        if (name === this.init.sessionId || !ID_RE.test(name) || name === "." || name === "..") continue;
        const dir = path.join(this.showRoot, name);
        if (!fs.lstatSync(dir).isDirectory() || fs.existsSync(path.join(liveDir(agentDir), `${name}.json`))) continue;
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch {
      // no show root yet, or a dir that cannot be removed: pruning is best effort
    }
  }
}
