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
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { handoffPlanPath, HANDOFF_PLAN, isPlanPath, PLAN_MAX_BYTES, planBody, planVersionHash, readHandoffPlan, readPlan } from "./checkpoint.ts";
import type { PlanOpts } from "./checkpoint.ts";
import { scratchRoot } from "./editmode.ts";
import { planReviewFiles } from "./findings.ts";
import { liveDir } from "./livestate.ts";
import type { LiveShow } from "./livestate.ts";
import { resolveToolPath } from "./payload.ts";
import { planPathsOf } from "./planreview.ts";
import { workspaceOf } from "./python.ts";
import { realDeep } from "./triage.ts";

export const SHOW_DIR = "show";
export const PLAN_JSON = "plan.json";
export const PLAN_RULED = "plan.ruled.md";
export const PLAN_PREV = "plan.prev.md";
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
  fences: string[];
}

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

/** First `# ` heading of the plan body, else its first non-blank line, at most 120 chars without control characters. */
export function titleOf(bytes: Buffer): string {
  const lines = planBody(bytes).toString("utf8").split(/\r?\n/);
  const heading = lines.map((l) => /^#[ \t]+(.+?)[ \t#]*$/.exec(l)).find((m) => m);
  const raw = heading ? heading[1] : (lines.find((l) => l.trim()) ?? "");
  return raw.replace(/[\u0000-\u001f\u007f\u0080-\u009f]/g, " ").trim().slice(0, 120) || "plan";
}

/** plan.json text -> PlanJson, or null when a field has the wrong type. */
export function parsePlanJson(text: string): PlanJson | null {
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    if (!j || typeof j !== "object" || !isStrOrNull(j.path) || !isStr(j.title) || !Number.isInteger(j.v) || (j.v as number) < 1 || !isStr(j.at) || !isStr(j.hash)) return null;
    if (!isStrOrNull(j.ruledPath) || !isStrOrNull(j.ruledHash) || !isStrOrNull(j.prevHash) || !Array.isArray(j.fences) || !j.fences.every(isStr)) return null;
    return { path: j.path, title: j.title, v: j.v as number, at: j.at, hash: j.hash, ruledPath: j.ruledPath, ruledHash: j.ruledHash, prevHash: j.prevHash, fences: j.fences };
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

function ruledHashOnDisk(file: string): string | null {
  try {
    const st = fs.lstatSync(file);
    return st.isFile() && st.size <= PLAN_MAX_BYTES ? planVersionHash(fs.readFileSync(file)) : null;
  } catch {
    return null;
  }
}

export class Show {
  /** Absolute show dir of this session. */
  readonly dir: string;
  private meta: PlanJson | null;
  private tracked: Tracked | null = null;
  private q: Promise<void> = Promise.resolve();
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
    } catch (e) {
      if (codeOf(e) === "ENOTDIR") init.trace?.({ event: "show_error", kind: "start", errorKind: "ENOTDIR" });
    }
  }

  /** The live file's `show` pointer: the dir, and the plan version while a plan is published. */
  field(): LiveShow {
    return { dir: this.dir, ...(this.meta && this.meta.path !== null ? { plan: this.meta.v } : {}) };
  }

  /** The current plan.json as this session wrote it (null before the first publication). */
  get plan(): PlanJson | null {
    return this.meta;
  }

  /** Resolves when every queued write has finished (a failed job never rejects it). */
  idle(): Promise<void> {
    return this.q;
  }

  /** A write or edit tool result named `raw`: track it when it is the scratch plan or the handoff plan, and refresh plan.json. */
  planWritten(raw: unknown): boolean {
    const t = this.trackedFor(raw);
    if (!t) return false;
    this.tracked = t;
    this.enqueue("refresh", () => this.sync(false));
    return true;
  }

  /** `foreman_checkpoint` passed the plan guards for `planPath`: track it and roll the snapshots. */
  checkpointed(planPath: string): void {
    this.tracked = { kind: "scratch", path: planPath };
    this.enqueue("checkpoint", () => this.sync(true));
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
    this.enqueue("review", () => this.sync(true));
  }

  /** A successful `intercom` send: a `Plan from <label>: <path>` or `foreman:plan <path>` notice rolls the snapshots of the tracked plan. */
  planSent(message: unknown): void {
    if (!isStr(message) || !PLAN_NOTICE.test(message)) return;
    const named = this.trackedFor(message.replace(PLAN_NOTICE, "").split(/\r?\n/, 1)[0].trim());
    if (named) this.tracked = named;
    if (!this.tracked) return;
    this.enqueue("send", () => this.sync(true));
  }

  private get planOpts(): PlanOpts {
    const i = this.init;
    return { cwd: i.cwd, home: i.home, platform: i.platform, scratchDir: i.scratchDir };
  }

  private trackedFor(raw: unknown): Tracked | null {
    const abs = resolveToolPath(raw, this.init.cwd, this.init.home);
    if (abs && isPlanPath(abs, this.planOpts)) return { kind: "scratch", path: abs };
    return handoffPlanPath(raw, this.init.handoffDir, this.planOpts) ? { kind: "handoff" } : null;
  }

  private handoffNamedIn(task: string): boolean {
    const dir = this.init.handoffDir?.trim();
    if (!dir || !path.isAbsolute(dir)) return false;
    return [path.join(dir, HANDOFF_PLAN), path.join(realDeep(path.resolve(dir)), HANDOFF_PLAN)].some((p) => task.includes(p));
  }

  /** The scratch plan a task names that passes the guarded read: the tracked one when it is named, else the first. */
  private scratchNamedIn(task: string): Tracked | null {
    const f = fold(this.init.platform);
    const named = planPathsOf(planReviewFiles(task, null), this.init.scratchDir)
      .map((p) => resolveToolPath(p, this.init.cwd, this.init.home))
      .filter((abs): abs is string => !!abs && isPlanPath(abs, this.planOpts) && "plan" in readPlan(abs, this.planOpts));
    const cur = this.tracked?.kind === "scratch" ? this.tracked.path : null;
    const keep = cur && named.find((p) => f(realDeep(p)) === f(realDeep(cur)));
    const pick = keep ?? named[0];
    return pick ? { kind: "scratch", path: pick } : null;
  }

  /** `q = q.then(job).catch(trace)`: a failed job never stalls the chain. */
  private enqueue(op: string, job: () => Promise<void>): void {
    this.q = this.q.then(job).catch((e) => this.init.trace?.({ event: "show_error", kind: op, errorKind: codeOf(e) }));
  }

  private read(t: Tracked): { path: string; bytes: Buffer; hash: string } | null {
    if (t.kind === "handoff") {
      const r = this.init.handoffDir ? readHandoffPlan(this.init.handoffDir, this.init.platform) : null;
      return r && "plan" in r ? r.plan : null;
    }
    const r = readPlan(t.path, this.planOpts);
    return "plan" in r ? { path: r.plan.path, bytes: r.plan.bytes, hash: r.plan.hash } : null;
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
      title: titleOf(cur.bytes),
      v: !prev ? 1 : changed ? prev.v + 1 : prev.v,
      at: changed ? new Date().toISOString() : prev.at,
      hash: cur.hash,
      ruledPath: moved ? null : (prev?.ruledPath ?? null),
      ruledHash: moved ? null : (prev?.ruledHash ?? null),
      prevHash: moved ? null : (prev?.prevHash ?? null),
      fences: [],
    };
    if (roll && (meta.ruledPath === null || meta.ruledHash !== cur.hash)) await this.rollTo(cur, meta);
    else if (!prev || JSON.stringify(prev) !== JSON.stringify(meta)) await this.writeMeta(meta);
  }

  private async rollTo(cur: { path: string; bytes: Buffer; hash: string }, meta: PlanJson): Promise<void> {
    const ruled = path.join(this.dir, PLAN_RULED);
    const tmp = this.tmpName(ruled);
    // prev.md will hold what ruled.md holds now (it can differ from plan.json after a failed step 4); with no ruled.md, prev.md is left as it is.
    const prevHash = ruledHashOnDisk(ruled) ?? meta.ruledHash;
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
