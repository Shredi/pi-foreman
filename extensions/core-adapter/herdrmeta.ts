// Herdr group tag (display-only pane metadata, source `user:pi-foreman`). An opened child session shows
// "<parent-slug> › <child-slug>" in Herdr's agent cell; a parent with open children shows
// "<own-slug> · <n> child(ren)" plus the token children=<n>. Reported with a 180 s TTL and refreshed
// every 60 s while Pi runs (sessions.json is re-read on that interval only, no fs watchers); cleared on
// session_shutdown. Only with HERDR_ENV=1, HERDR_PANE_ID, mode tui and herdr.groupTag !== false.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { piAgentDir } from "./env.ts";
import { openerIntercomId, readRegistry, type Registry } from "./session.ts";

export const META_SOURCE = "user:pi-foreman";
export const META_TTL_MS = 180_000;
export const META_REFRESH_MS = 60_000;
const LIVE = new Set(["pending", "open", "closing"]);

type Env = Record<string, string | undefined>;

/** Same rule as foreman_session.py slug_of. */
export function slugOf(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "session";
}

/** Slug of a handoff dir `<YYYYmmdd-HHMMSS>-<slug>[-<6hex>]`; the suffix is the last 6 chars of the child id. */
export function handoffSlug(handoffDir: string, childId = ""): string {
  let name = (handoffDir.split(/[\\/]+/).filter(Boolean).pop() ?? "").replace(/^\d{8}-\d{6}-/, "");
  const tail = childId.trim().slice(-6);
  if (/^[0-9a-f]{6}$/.test(tail) && name.endsWith(`-${tail}`)) name = name.slice(0, -7);
  return slugOf(name);
}

/** Slug of the git top level of `cwd` (nearest dir with a `.git` entry), else of `cwd`. */
export function repoSlug(cwd: string): string {
  let dir = path.resolve(cwd);
  for (;;) {
    if (fs.existsSync(path.join(dir, ".git"))) return slugOf(path.basename(dir));
    const up = path.dirname(dir);
    if (up === dir) return slugOf(path.basename(path.resolve(cwd)));
    dir = up;
  }
}

/** A session's own slug: its handoff label when it is an opened child, else its repo. */
export function ownSlug(env: Env, cwd: string): string {
  const h = env.PI_FOREMAN_HANDOFF_DIR?.trim();
  return h ? handoffSlug(h, env.PI_INTERCOM_STABLE_ID ?? "") : repoSlug(cwd);
}

export function countChildren(reg: Registry, ownId: string): number {
  return reg.sessions.filter((e) => e && e.parent === ownId && typeof e.status === "string" && LIVE.has(e.status)).length;
}

/** The text and token to report, or null to clear. `parentSlug` is set for an opened child. */
export function metaText(own: string, parentSlug: string | null, n: number): string | null {
  const kids = n > 0 ? `${n} ${n === 1 ? "child" : "children"}` : "";
  if (parentSlug) return kids ? `${parentSlug} › ${own} · ${kids}` : `${parentSlug} › ${own}`;
  return kids ? `${own} · ${kids}` : null;
}

export function reportArgv(pane: string, text: string, n: number): string[] {
  const token = n > 0 ? ["--token", `children=${n}`] : ["--clear-token", "children"];
  return ["pane", "report-metadata", pane, "--source", META_SOURCE, "--display-agent", text, ...token, "--ttl-ms", String(META_TTL_MS)];
}

export function clearArgv(pane: string): string[] {
  return ["pane", "report-metadata", pane, "--source", META_SOURCE, "--clear-display-agent", "--clear-token", "children"];
}

export interface MetaDeps {
  env: Env;
  run: (argv: string[]) => void;
  registry: () => Registry;
  ownId: () => string;
  cwd: string;
}

/** One session's tag state; `tick` reports on every call while there is something to show, clears once when it goes away. */
export class HerdrMeta {
  private reported = false;
  private readonly d: MetaDeps;
  constructor(d: MetaDeps) {
    this.d = d;
  }

  private get pane(): string {
    return this.d.env.HERDR_PANE_ID?.trim() ?? "";
  }

  private parentSlug(): string | null {
    const e = this.d.env;
    if (!e.PI_FOREMAN_HANDOFF_DIR?.trim() || !e.PI_FOREMAN_PARENT_INTERCOM?.trim()) return null;
    const p = e.PI_FOREMAN_PARENT_LABEL?.trim();
    return p ? slugOf(p) : null;
  }

  tick(): void {
    let n = 0;
    try {
      n = countChildren(this.d.registry(), this.d.ownId());
    } catch {
      n = 0;
    }
    const text = metaText(ownSlug(this.d.env, this.d.cwd), this.parentSlug(), n);
    if (text) {
      this.d.run(reportArgv(this.pane, text, n));
      this.reported = true;
    } else if (this.reported) {
      this.d.run(clearArgv(this.pane));
      this.reported = false;
    }
  }

  stop(): void {
    if (this.reported) this.d.run(clearArgv(this.pane));
    this.reported = false;
  }
}

export function metaGate(env: Env, mode: string | undefined, groupTag: boolean): boolean {
  return env.HERDR_ENV === "1" && !!env.HERDR_PANE_ID?.trim() && mode === "tui" && groupTag;
}

const runHerdr = (bin: string) => (argv: string[]): void => {
  try {
    execFile(bin, argv, { timeout: 5000, windowsHide: true }, () => {
      // best effort: errors are ignored
    });
  } catch {
    // no herdr
  }
};

/**
 * Wire the group tag into `pi` (clears on session_shutdown). The caller runs `start(ctx, groupTag)` at the end
 * of its session_start handler, once the session's config (`herdr.groupTag`) is loaded.
 */
export function installHerdrMeta(pi: Pick<ExtensionAPI, "on">, opts: { env?: Env; run?: (argv: string[]) => void } = {}): { start: (ctx: ExtensionContext, groupTag: boolean) => void } {
  const env = opts.env ?? process.env;
  let meta: HerdrMeta | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  const stop = (): void => {
    if (timer) clearInterval(timer);
    timer = null;
    meta?.stop();
    meta = null;
  };
  pi.on("session_shutdown", async () => stop());
  const start = (ctx: ExtensionContext, groupTag: boolean): void => {
    stop();
    if (!metaGate(env, ctx.mode, groupTag)) return;
    const agentDir = piAgentDir(env, os.homedir());
    const sid = ctx.sessionManager.getSessionId();
    meta = new HerdrMeta({ env, cwd: ctx.cwd, run: opts.run ?? runHerdr(env.HERDR_BIN?.trim() || "herdr"), registry: () => readRegistry(agentDir), ownId: () => openerIntercomId(env, agentDir, sid) });
    meta.tick();
    timer = setInterval(() => meta?.tick(), META_REFRESH_MS);
    timer.unref?.();
  };
  return { start };
}
