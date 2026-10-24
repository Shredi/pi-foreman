// Idle model downshift (docs/ladder.md, docs/cache.md): a notice turn (child, wake, intercom, other) that starts on a cold
// cache runs on the foreman's cheaper `idle` rung; the owner's next input, an owner answer to ask_user_question or
// foreman_checkpoint, and every session start put the base model back. The base is remembered in memory and in a
// persisted "foreman-idle-model" entry so a resume or reload can close an open downshift. One instance per extension
// load: the state must survive a `new` session.
import type { Timers } from "./prwatch.ts";

export const IDLE_ENTRY = "foreman-idle-model";

export interface ModelRef {
  provider: string;
  id: string;
}
export interface Base extends ModelRef {
  thinking: string | null;
}
export interface IdleEntry {
  base: Base;
  idle: ModelRef;
  open: boolean;
}
export type CacheGlyph = "keepalive" | "cold" | "downshift";

export interface IdleModelDeps {
  now(): number;
  timers?: Timers;
  enabled(): boolean;
  causes(): string[];
  /** providers.<p>.roles.foreman.idle of the session; null = no rung. */
  rung(): { model: string; thinking: string | null } | null;
  current(): ModelRef | null;
  thinking(): string;
  /** A rung spec (<provider>/<id>, provider defaulting to the current one) in the registry. */
  find(spec: string): (ModelRef & object) | undefined;
  findRef(ref: ModelRef): object | undefined;
  /** Guarded pi.setModel (+ thinking when set); false when it failed. */
  switchTo(model: object, thinking: string | null): Promise<boolean>;
  /** Epoch ms the cache of the current model is cold from: 0 = cold now (no touch), Infinity = unknown. */
  coldAt(): number;
  persist(entry: IdleEntry): void;
  trace(r: Record<string, unknown>): void;
  glyph(g: CacheGlyph | null): void;
}

const realTimers: Timers = {
  set: (fn, ms) => {
    const t = setTimeout(fn, ms);
    (t as { unref?: () => void }).unref?.();
    return t;
  },
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

const spec = (r: ModelRef): string => `${r.provider}/${r.id}`;

/** The newest "foreman-idle-model" entry of a branch, or null. */
export function latestIdleEntry(entries: unknown[]): IdleEntry | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i] as { type?: unknown; customType?: unknown; data?: unknown } | null;
    if (!e || e.type !== "custom" || e.customType !== IDLE_ENTRY) continue;
    const d = e.data as Partial<IdleEntry> | undefined;
    if (d && d.base && d.idle && typeof d.base.provider === "string" && typeof d.base.id === "string" && typeof d.idle.provider === "string" && typeof d.idle.id === "string") {
      return { base: { provider: d.base.provider, id: d.base.id, thinking: typeof d.base.thinking === "string" ? d.base.thinking : null }, idle: { provider: d.idle.provider, id: d.idle.id }, open: d.open === true };
    }
    return null;
  }
  return null;
}

/** Whether a tool result carries an owner answer: ask_user_question "answered", foreman_checkpoint approve (with an approver), revise or reject. */
export function ownerAnswered(toolName: string, details: unknown): boolean {
  const d = (details ?? {}) as { decision?: unknown; by?: unknown };
  if (toolName === "ask_user_question") return d.decision === "answered";
  if (toolName === "foreman_checkpoint") return d.decision === "revise" || d.decision === "reject" || (d.decision === "approve" && d.by !== null && d.by !== undefined);
  return false;
}

export class IdleModel {
  private d: IdleModelDeps;
  private timers: Timers;
  private timer: unknown = null;
  private base: Base | null = null;
  private idle: ModelRef | null = null;
  private unavailableTraced = false;
  private warming = false;
  private running = false;

  constructor(deps: IdleModelDeps) {
    this.d = deps;
    this.timers = deps.timers ?? realTimers;
  }

  downshifted(): boolean {
    return this.base !== null;
  }

  /** `<provider>/<id>` of the model the foreman's gates judge: the base while downshifted, else the current model. */
  baseModel(current: ModelRef | null | undefined): string | null {
    if (this.base) return spec(this.base);
    return current ? spec(current) : null;
  }

  /** `before_agent_start`: an owner turn restores the base; a notice turn on a cold cache may downshift. */
  async beforeTurn(cause: string | null): Promise<void> {
    if (cause === "user") {
      await this.restore("owner");
      return;
    }
    const d = this.d;
    if (this.base || !cause || !d.enabled() || !d.causes().includes(cause)) return;
    const rung = d.rung();
    const cur = d.current();
    if (!rung || !cur || d.now() < d.coldAt()) return;
    const target = d.find(rung.model);
    if (!target) return this.unavailable(rung.model);
    if (target.provider === cur.provider && target.id === cur.id) return;
    const base: Base = { provider: cur.provider, id: cur.id, thinking: d.thinking() };
    if (!(await d.switchTo(target, rung.thinking))) return this.unavailable(rung.model);
    this.base = base;
    this.idle = { provider: target.provider, id: target.id };
    d.persist({ base, idle: this.idle, open: true });
    d.trace({ event: "foreman_model", from: spec(base), to: spec(this.idle), reason: "idle_cold", cause });
    this.refresh();
  }

  /** An owner answer to ask_user_question / foreman_checkpoint (tool_execution_end). */
  async onAnswer(): Promise<void> {
    await this.restore("answer");
  }

  /** The user picked a model with /model while downshifted: the pick is the base, the entry closes. */
  onUserPick(): void {
    if (!this.base || !this.idle) return;
    this.d.persist({ base: this.base, idle: this.idle, open: false });
    this.base = null;
    this.idle = null;
    this.refresh();
  }

  /** `session_start`, any reason: close a downshift left open (in memory, else on the branch when the model is still the idle rung). */
  async onSessionStart(entries: unknown[]): Promise<void> {
    if (!this.base) {
      const e = latestIdleEntry(entries);
      const cur = this.d.current();
      if (!e || !e.open || !cur || cur.provider !== e.idle.provider || cur.id !== e.idle.id) return;
      this.base = e.base;
      this.idle = e.idle;
    }
    await this.restore("session_start");
  }

  setWarming(on: boolean): void {
    this.warming = on;
    this.refresh();
  }

  /** A turn is running (agent_start .. agent_settled): the cache is in use, so no cold glyph. */
  setRunning(on: boolean): void {
    this.running = on;
    this.refresh();
  }

  /** Recompute the footer glyph and arm a timer for the moment the cache turns cold. */
  refresh(): void {
    this.timers.clear(this.timer);
    this.timer = null;
    const at = this.d.coldAt();
    const now = this.d.now();
    const cold = !this.running && at !== Infinity && now >= at;
    this.d.glyph(this.base ? "downshift" : this.warming ? "keepalive" : cold ? "cold" : null);
    if (!this.running && !this.base && Number.isFinite(at) && at > now) this.timer = this.timers.set(() => this.refresh(), at - now + 1000);
  }

  stop(): void {
    this.timers.clear(this.timer);
    this.timer = null;
  }

  private unavailable(rung: string): void {
    if (this.unavailableTraced) return;
    this.unavailableTraced = true;
    this.d.trace({ event: "foreman_model", outcome: "unavailable", to: rung });
  }

  private async restore(reason: "owner" | "answer" | "session_start"): Promise<void> {
    const base = this.base;
    const idle = this.idle;
    if (!base || !idle) return;
    this.base = null;
    this.idle = null;
    const m = this.d.findRef(base);
    const ok = m ? await this.d.switchTo(m, base.thinking) : false;
    this.d.persist({ base, idle, open: false });
    this.d.trace({ event: "foreman_model", from: spec(idle), to: spec(base), reason, ...(ok ? {} : { outcome: "unavailable" }) });
    this.refresh();
  }
}
