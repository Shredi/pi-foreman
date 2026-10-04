// Project Claude Code config drift (security re-check M2 snapshot part, M4).
//
// claude-bridge turns run Claude Code in the session cwd with its default setting sources, so
// `{cwd}/.claude/settings.json`, `{cwd}/.claude/settings.local.json` and `{cwd}/.mcp.json` can
// run commands (hooks, helpers). A child's allowed `npm test` can write them without naming the
// path. This keeps content hashes of those three files (names and hashes only, never content),
// persisted per workspace (realpath of cwd) in the pi-foreman state dir. Before the foreman's
// next prompt runs on claude-bridge (Pi's `input` event) and when the model switches to
// claude-bridge, a change since the last snapshot is an ask; without a UI the prompt is blocked.
// Approve re-snapshots. With no stored snapshot (first session on a workspace) the current
// state is taken silently.
//
// Limits: checked once per prompt, not before every LLM call inside one agent run; a change
// between the check and the bridge's own read is not seen.
import * as fs from "node:fs";
import * as path from "node:path";
import type { DriftAskEnv, DriftDecision } from "./gitdrift.ts";
import { readState, sha, stateFileFor, writeState } from "./gitdrift.ts";

export const CLAUDE_PROJECT_FILES = [".claude/settings.json", ".claude/settings.local.json", ".mcp.json"];

/** File name -> content hash, or "absent". */
export type ClaudeSnapshot = Record<string, string>;

export function takeClaudeSnapshot(cwd: string): ClaudeSnapshot {
  const out: ClaudeSnapshot = {};
  for (const name of CLAUDE_PROJECT_FILES) {
    try {
      out[name] = sha(fs.readFileSync(path.join(cwd, ...name.split("/"))));
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
  for (const name of CLAUDE_PROJECT_FILES) {
    const a = before[name] ?? "absent";
    const b = after[name];
    if (a === b) continue;
    out.push(`${name}: ${a === "absent" ? "created" : b === "absent" ? "removed" : "changed"}`);
  }
  return out;
}

export class ClaudeConfigWatch {
  snap: ClaudeSnapshot | null = null;
  private stateFile: string | null = null;

  private set(s: ClaudeSnapshot): void {
    this.snap = s;
    writeState(this.stateFile, { v: 1, files: s });
  }

  /** Foreman session start: load the stored snapshot (or take one silently); returns the drift since. */
  bind(stateDir: string, cwd: string): string[] {
    this.stateFile = stateFileFor(stateDir, "claudecfg", cwd);
    const stored = readState(this.stateFile) as { v?: number; files?: unknown } | null;
    const files = stored && stored.v === 1 && stored.files && typeof stored.files === "object" ? (stored.files as ClaudeSnapshot) : null;
    if (!files) {
      this.set(takeClaudeSnapshot(cwd));
      return [];
    }
    this.snap = files;
    return diffClaudeSnapshots(files, takeClaudeSnapshot(cwd));
  }

  /** Before a claude-bridge prompt / on the switch to claude-bridge. Undefined = go on. */
  async check(cwd: string, what: string, ask: DriftAskEnv, trace: (r: Record<string, unknown>) => void): Promise<{ block: true; reason: string } | undefined> {
    if (!this.snap) return undefined;
    const now = takeClaudeSnapshot(cwd);
    const lines = diffClaudeSnapshots(this.snap, now);
    if (!lines.length) return undefined;
    const summary = lines.join("\n");
    let decision: DriftDecision = "no-ui";
    if ((ask.mode === "tui" || ask.mode === "rpc") && ask.hasUI && ask.confirm) {
      const msg = `Project Claude Code config changed since pi-foreman last checked it (a child may have written it; claude-bridge turns load it and it can run commands; content is not shown):\n${summary}\nRun ${what} anyway? Inspect the files first.`;
      let ok = false;
      try {
        ok = await ask.confirm("pi-foreman: project Claude Code config changed", msg);
      } catch {
        ok = false;
      }
      decision = ok ? "approved" : "denied";
    }
    trace({ event: "claude_config_drift", decision });
    if (decision === "approved") {
      this.set(takeClaudeSnapshot(cwd));
      return undefined;
    }
    if (decision === "denied") return { block: true, reason: `Denied by the user. pi-foreman: project Claude Code config drift.\n${summary}` };
    return { block: true, reason: `pi-foreman: project Claude Code config changed since pi-foreman last checked it, and there is no UI to approve ${what} (mode: ${ask.mode}); it is blocked. Inspect the files, then start a session with a UI to approve.\n${summary}` };
  }
}
