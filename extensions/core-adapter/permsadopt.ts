// `/foreman perms adopt <shape-id>` (R41 item 9, Addendum C): the owner's one way to turn a candidate shape of the gate decision log into an entry of the
// user policy layer's `## allow` section. It runs only in the owner pane, behind a confirm dialog that no model verdict ever answers (same treatment
// as bridgetrust.ts); there is no CLI subcommand, and the user policy file stays a floor for every tool and shell write: this module writes in-process.
import * as fs from "node:fs";
import * as path from "node:path";
import { findCandidates, readLog } from "../../scripts/foreman_perms.mjs";
import { gateLogFile } from "./gatelog.ts";
import type { GateKind } from "./gatelog.ts";
import { parsePolicy, userPolicyFile } from "./policy.ts";

export interface AdoptUi {
  hasUI: boolean;
  mode: string;
  confirm(title: string, message: string): Promise<boolean>;
}

interface Candidate {
  id: string;
  tool: string;
  shape: string;
  count: number;
  source: string;
  last: string;
  example: string;
}

/** The candidates of the agent dir's gate log (the rotated file first), as `foreman perms candidates` lists them. */
export function logCandidates(agentDir: string, min = 5): Candidate[] {
  const file = gateLogFile(agentDir);
  return findCandidates([...readLog(file.replace(/log\.jsonl$/, "log.1.jsonl")), ...readLog(file)], min) as Candidate[];
}

/** The policy entry (id and text) of a candidate. The text is the shape, so the review model matches later calls of that shape against it. */
export function entryFor(c: Candidate): { id: string; text: string } {
  const tool = c.tool.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "tool";
  const shape = c.shape.replace(/\s+/g, " ").trim();
  return { id: `${tool}-${c.id}`, text: `Allow \`${c.tool}\` calls of this shape: \`${shape}\` (<n> a number, <h> a commit id, <branch> a branch name, <worktree>/... a path inside the worktree). Adopted by the owner from the gate decision log after ${c.count} ${c.source === "dialog" ? "approvals in dialogs" : "review allows"} and no deny.` };
}

/** Append the entry to the `## allow` section of the file text, creating the section when missing. */
export function withAllowEntry(text: string, entry: { id: string; text: string }): string {
  const block = `- id: ${entry.id}\n  ${entry.text}\n`;
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^##\s+allow\s*$/i.test(l));
  if (start < 0) return `${text}${text === "" || text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n"}## allow\n\n${block}`;
  const next = lines.findIndex((l, i) => i > start && /^##\s/.test(l));
  const rest = next < 0 ? [] : lines.slice(next);
  let end = next < 0 ? lines.length : next;
  while (end > start + 1 && lines[end - 1].trim() === "") end--;
  return [...lines.slice(0, end), ...block.trimEnd().split("\n"), "", ...rest].join("\n").replace(/\n*$/, "\n");
}

/**
 * Run `/foreman perms adopt <id>`. `kind` is the session's gate kind; only `owner` may adopt. Returns the text to show.
 * The user policy file is written only after the owner confirms.
 */
export async function adoptPerms(agentDir: string, shapeId: string, kind: GateKind | string, ui: AdoptUi): Promise<string> {
  if (kind !== "owner") return `pi-foreman: /foreman perms adopt works only in the owner pane (this is a ${kind} session); nothing was written.`;
  if (!/^[0-9a-f]{8}$/.test(shapeId)) return "pi-foreman: usage: /foreman perms adopt <shape-id> (the id column of `foreman perms candidates`); nothing was written.";
  const c = logCandidates(agentDir).find((x) => x.id === shapeId);
  if (!c) return `pi-foreman: no candidate with id ${shapeId} (see \`foreman perms candidates\`); nothing was written.`;
  const entry = entryFor(c);
  const file = userPolicyFile(agentDir);
  let current = "";
  try {
    current = fs.readFileSync(file, "utf8");
  } catch {
    // no user policy yet: the section is created
  }
  if (parsePolicy(current, file, []).some((e) => e.id === entry.id)) return `pi-foreman: ${entry.id} is already in ${file}; nothing was written.`;
  if (!ui.hasUI || (ui.mode !== "tui" && ui.mode !== "rpc")) return "pi-foreman: /foreman perms adopt needs an interactive session (a confirm dialog); nothing was written.";
  let ok = false;
  try {
    ok = await ui.confirm("pi-foreman: add this entry to your policy's allow section?", `${file}\n\n## allow\n- id: ${entry.id}\n  ${entry.text}\n\nExample seen: ${c.example}\nLast seen: ${c.last}`);
  } catch {
    ok = false;
  }
  if (!ok) return "pi-foreman: not adopted; nothing was written.";
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, withAllowEntry(current, entry));
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // best effort
    }
    return `pi-foreman: could not write ${file} (${e instanceof Error ? e.message : String(e)}); nothing was adopted.`;
  }
  return `pi-foreman: added ${entry.id} to the allow section of ${file}. It applies to new reviews at once.`;
}
