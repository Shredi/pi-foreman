// Project Claude Code config drift (security re-check M2 snapshot part, M4, R2-H1, R2-M1).
//
// claude-bridge turns run Claude Code in the session cwd with its default setting sources, so
// `{cwd}/.claude/settings.json`, `{cwd}/.claude/settings.local.json` and `{cwd}/.mcp.json` can
// run commands (hooks, helpers). A child's allowed `npm test` can write them without naming the
// path. `{cwd}/.pi/claude-bridge.json` is the bridge's own project config (pi-claude-bridge
// 0.9.1 src/config.ts:84-91, merged over `<agentDir>/claude-bridge.json`; the only project-level
// bridge config file): it can name the program the bridge spawns
// (`provider.pathToClaudeCodeExecutable`), and compaction/branch summaries and the review link
// re-read it on every call (src/index.ts:576-596). This keeps content hashes of those four files
// (names and hashes only, never content),
// persisted per workspace (realpath of cwd) in the pi-foreman state dir. A change since the last
// snapshot is an ask; without a UI it blocks. Approve re-snapshots. Checked:
//  - before every model request on claude-bridge (Pi's `context` event), which covers every run
//    start: typed and RPC prompts, runs a child's completion notice starts (`triggerTurn`),
//    follow-ups and steers. A block aborts the run before the request reaches the provider;
//  - on Pi's `input` event (typed and RPC prompts are refused before a run starts at all);
//  - on the switch to claude-bridge (`model_select`; notify only);
//  - cache-warming refreshes of a claude-bridge request are stopped while drift is pending;
//  - before a compaction or branch summary on claude-bridge (`session_before_compact`,
//    `session_before_tree`; a block cancels it). Pi stops at the first cancelling handler in
//    extension load order, so this precedes the bridge's own takeover only when pi-foreman
//    loads first (doctor);
//  - the review link never calls a claude-bridge model while drift is pending (review.ts).
// A true first session on a workspace takes the snapshot with a visible notice; a snapshot that
// is missing (its seen marker exists) or corrupt is drift, never a silent fresh baseline.
//
// Limits: a change between the check and the bridge's own read is not seen; the bridge keeps one
// Claude Code process across the tool calls of a run, so a change made inside a run is checked
// at the next request, but that process loaded its settings earlier.
import * as fs from "node:fs";
import * as path from "node:path";
import type { DriftAskEnv, DriftDecision } from "./gitdrift.ts";
import { loadState, sha, stateFileFor, writeState } from "./gitdrift.ts";

export const CLAUDE_PROJECT_FILES = [".claude/settings.json", ".claude/settings.local.json", ".mcp.json", ".pi/claude-bridge.json"];
/** Files every stored snapshot has; a snapshot from before `.pi/claude-bridge.json` was added lacks it (read as "absent", so an existing file is drift once). */
const REQUIRED_FILES = CLAUDE_PROJECT_FILES.slice(0, 3);

/** File name -> content hash, or "absent". */
export type ClaudeSnapshot = Record<string, string>;

/** Snapshot key of the user-level bridge config `<agentDir>/claude-bridge.json` (merged under the project file). */
export const USER_BRIDGE_FILE = "<agentDir>/claude-bridge.json";

/**
 * Hash of the user bridge config without `startupNoticeShown`, which the bridge itself writes
 * there once (src/config.ts markStartupNoticeShown); unparseable content is hashed as is.
 */
function userBridgeHash(buf: Buffer): string {
  try {
    const o = JSON.parse(buf.toString("utf8")) as unknown;
    if (o && typeof o === "object" && !Array.isArray(o)) {
      delete (o as Record<string, unknown>).startupNoticeShown;
      // only the bridge's own marker: no settings, same as no file
      return Object.keys(o).length ? sha(JSON.stringify(o)) : "absent";
    }
  } catch {
    // hashed raw below
  }
  return sha(buf);
}

export function takeClaudeSnapshot(cwd: string, agentDir?: string): ClaudeSnapshot {
  const out: ClaudeSnapshot = {};
  const files: Array<[string, string, (b: Buffer) => string]> = CLAUDE_PROJECT_FILES.map((name) => [name, path.join(cwd, ...name.split("/")), sha]);
  if (agentDir) files.push([USER_BRIDGE_FILE, path.join(agentDir, "claude-bridge.json"), userBridgeHash]);
  for (const [name, file, hash] of files) {
    try {
      out[name] = hash(fs.readFileSync(file));
    } catch (err) {
      out[name] = (err as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unreadable";
    }
  }
  return out;
}

/** Lines naming the changed files (never content). Empty = no drift. */
export function diffClaudeSnapshots(before: ClaudeSnapshot | null, after: ClaudeSnapshot): string[] {
  if (!before) return [];
  const out: string[] = [];
  for (const name of Object.keys(after)) {
    const a = before[name] ?? "absent";
    const b = after[name];
    if (a === b) continue;
    out.push(`${name}: ${a === "absent" ? "created" : b === "absent" ? "removed" : "changed"}`);
  }
  return out;
}

export class ClaudeConfigWatch {
  snap: ClaudeSnapshot | null = null;
  /** True when bind found no snapshot and no seen marker and took the baseline (shown to the user). */
  firstBaseline = false;
  /** Set when the stored snapshot was missing or corrupt for a workspace that had one; asks until approved. */
  tamper: string | null = null;
  private stateFile: string | null = null;
  /** Agent dir for the user-level bridge config (bind); undefined = not tracked. */
  private agentDir: string | undefined;

  private set(s: ClaudeSnapshot): void {
    this.snap = s;
    writeState(this.stateFile, { v: 1, files: s });
  }

  /** Foreman session start: load the stored snapshot (or take the first one); returns the drift since. */
  bind(stateDir: string, cwd: string, agentDir?: string): string[] {
    this.agentDir = agentDir;
    this.stateFile = stateFileFor(stateDir, "claudecfg", cwd);
    const st = loadState(this.stateFile, "Claude Code config", (o) => {
      const r = o as { v?: number; files?: unknown } | null;
      const files = r && r.v === 1 && r.files && typeof r.files === "object" && !Array.isArray(r.files) ? (r.files as Record<string, unknown>) : null;
      return files && REQUIRED_FILES.every((n) => typeof files[n] === "string") && Object.values(files).every((v) => typeof v === "string") ? (files as ClaudeSnapshot) : null;
    });
    if (st.kind !== "stored") {
      this.firstBaseline = st.kind === "first";
      this.tamper = st.kind === "tampered" ? st.line : null;
      if (st.kind === "first") this.set(takeClaudeSnapshot(cwd, this.agentDir));
      else this.snap = takeClaudeSnapshot(cwd, this.agentDir);
      return this.tamper ? [this.tamper] : [];
    }
    this.snap = st.data;
    return diffClaudeSnapshots(st.data, takeClaudeSnapshot(cwd, this.agentDir));
  }

  /** Drift lines now, without asking (empty = none). */
  pending(cwd: string): string[] {
    if (!this.snap) return [];
    return [...(this.tamper ? [this.tamper] : []), ...diffClaudeSnapshots(this.snap, takeClaudeSnapshot(cwd, this.agentDir))];
  }

  /** Before a claude-bridge prompt or model request / on the switch to claude-bridge. Undefined = go on. */
  async check(cwd: string, what: string, ask: DriftAskEnv, trace: (r: Record<string, unknown>) => void): Promise<{ block: true; reason: string } | undefined> {
    const lines = this.pending(cwd);
    if (!lines.length) return undefined;
    const summary = lines.join("\n");
    let decision: DriftDecision = "no-ui";
    if ((ask.mode === "tui" || ask.mode === "rpc") && ask.hasUI && ask.confirm) {
      const msg = `Project Claude Code or claude-bridge config changed since pi-foreman last checked it (a child may have written it; claude-bridge turns and summaries load it and it can run commands or name the program the bridge starts; content is not shown):\n${summary}\nRun ${what} anyway? Inspect the files first.`;
      let ok = false;
      try {
        ok = await ask.confirm("pi-foreman: project Claude Code or claude-bridge config changed", msg);
      } catch {
        ok = false;
      }
      decision = ok ? "approved" : "denied";
    }
    trace({ event: "claude_config_drift", decision });
    if (decision === "approved") {
      this.tamper = null;
      this.set(takeClaudeSnapshot(cwd, this.agentDir));
      return undefined;
    }
    if (decision === "denied") return { block: true, reason: `Denied by the user. pi-foreman: project Claude Code or claude-bridge config drift.\n${summary}` };
    return { block: true, reason: `pi-foreman: project Claude Code or claude-bridge config changed since pi-foreman last checked it, and there is no UI to approve ${what} (mode: ${ask.mode}); it is blocked. Inspect the files, then start a session with a UI to approve.\n${summary}` };
  }
}
