// Tool usage line (token-diet, retro): what a session declared, hid and listed, and what it used, found and read.
// Names only. One `tool-usage` line is written into the session's own usage file on the first turn and again at the
// end of a turn whenever `used`, `found` or `skillsRead` changed, so a session that is never closed still counts.
// `foreman retro` takes the last line per session (scripts/foreman_retro.py); every cost reader skips the kind (usage.ts isCostLine).
import * as path from "node:path";
import type { ToolUsageLine } from "./usage.ts";

export interface ToolUsageInit {
  declared: string[];
  hidden: string[];
  skillsListed: string[];
  skillsHidden: string[];
  /** Skill name -> its SKILL.md path, to tell a read of the file from any other read. */
  skillFiles: Record<string, string>;
  sources: Record<string, string>;
}

/** The package a tool comes from (Pi's `sourceInfo`: `source` like `npm:name@1.0`, else the path), "unknown" when neither says. */
export function packageOf(info: { source?: unknown; path?: unknown } | null | undefined): string {
  const source = typeof info?.source === "string" ? info.source : "";
  const npm = /^npm:((?:@[^/@]+\/)?[^/@]+)/.exec(source);
  if (npm) return npm[1];
  const p = typeof info?.path === "string" ? info.path.replace(/\\/g, "/") : "";
  if (p.startsWith("builtin:")) return "builtin";
  const nm = p.lastIndexOf("/node_modules/");
  if (nm >= 0) {
    const parts = p.slice(nm + "/node_modules/".length).split("/");
    return parts[0].startsWith("@") && parts[1] ? `${parts[0]}/${parts[1]}` : parts[0] || "unknown";
  }
  if (p.includes("/extensions/core-adapter/")) return "pi-foreman";
  return "unknown";
}

const sorted = (s: Iterable<string>): string[] => [...s].sort();

export class ToolUsageTracker {
  private init: ToolUsageInit | null = null;
  private used = new Set<string>();
  private found = new Set<string>();
  private skillsRead = new Set<string>();
  private written = "";

  get started(): boolean {
    return this.init !== null;
  }

  start(init: ToolUsageInit): void {
    this.init = init;
  }

  noteFound(name: string): void {
    this.found.add(name);
  }

  /** The tool calls of one assistant message (a `read` of a skill's SKILL.md counts as a skill read). */
  noteMessage(message: unknown): void {
    const content = (message as { content?: unknown } | null)?.content;
    if (!Array.isArray(content)) return;
    for (const b of content as { type?: unknown; name?: unknown; arguments?: unknown }[]) {
      if (!b || b.type !== "toolCall" || typeof b.name !== "string") continue;
      this.used.add(b.name);
      const args = b.arguments as { path?: unknown } | undefined;
      if (b.name === "read" && typeof args?.path === "string") this.noteRead(args.path);
    }
  }

  private noteRead(file: string): void {
    if (!this.init) return;
    const norm = path.normalize(file);
    for (const [name, f] of Object.entries(this.init.skillFiles)) if (path.normalize(f) === norm) this.skillsRead.add(name);
    if (path.basename(norm) === "SKILL.md") {
      const dir = path.basename(path.dirname(norm));
      if (this.init.skillsListed.includes(dir) || this.init.skillsHidden.includes(dir)) this.skillsRead.add(dir);
    }
  }

  /** The line to write now: the first one, or one whose used/found/skillsRead differ from the last written; else null. */
  take(ctx: { session: string; role: string; workspace?: string; foremanSession?: string }, now: Date = new Date()): ToolUsageLine | null {
    if (!this.init) return null;
    const used = sorted(this.used);
    const found = sorted(this.found);
    const skillsRead = sorted(this.skillsRead);
    const sig = JSON.stringify([used, found, skillsRead]);
    if (sig === this.written) return null;
    this.written = sig;
    const i = this.init;
    return { ts: now.toISOString(), kind: "tool-usage", session: ctx.session, ...(ctx.workspace ? { workspace: ctx.workspace } : {}), ...(ctx.foremanSession ? { foremanSession: ctx.foremanSession } : {}), role: ctx.role, declared: sorted(i.declared), hidden: sorted(i.hidden), used, found, skillsListed: sorted(i.skillsListed), skillsHidden: sorted(i.skillsHidden), skillsRead, sources: i.sources };
  }
}
