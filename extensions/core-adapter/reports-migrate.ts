// `foreman reports migrate` (docs/retro.md#migrating-the-old-backlog): moves the repeated groups of the retired retro backlog into the report store.
// The old store is markdown with one fenced `retro-entry` block per entry (key: value lines). Nothing here deletes a file; `--archive` renames the old directory.
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { wildMatch } from "./glob.ts";
import { KINDS, cleanText, CAPS } from "./reports.ts";

const DAY_MS = 86_400_000;
const FENCE = "```";

export interface OldEntry {
  id: string;
  kind: string;
  candidate: string;
  evidence: string;
  workspace: string;
  firstSeen: string | null;
  lastSeen: string | null;
  count: number;
  status: string;
  /** The file the block came from. */
  file: string;
}

export interface ParsedFile {
  entries: OldEntry[];
  /** Blocks without id, kind or candidate, or without a closing fence. */
  damaged: number;
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const ID = /^[A-Za-z0-9._-]{1,64}$/;

/** The blocks of one old store text. A block that cannot be used is counted as damaged, never thrown. */
export function parseOldStore(text: string, file: string, fallbackWorkspace: string): ParsedFile {
  const entries: OldEntry[] = [];
  let damaged = 0;
  let cur: Record<string, string> | null = null;
  const finish = (closed: boolean): void => {
    const b = cur;
    cur = null;
    if (!b) return;
    const count = Number(String(b.count ?? "1").trim());
    if (!closed || !ID.test(b.id ?? "") || !b.kind || !b.candidate?.trim()) {
      damaged++;
      return;
    }
    entries.push({
      id: b.id,
      kind: b.kind,
      candidate: b.candidate,
      evidence: b.evidence ?? "",
      workspace: b.workspace?.trim() || fallbackWorkspace,
      firstSeen: ISO.test(b.first_seen ?? "") ? b.first_seen : null,
      lastSeen: ISO.test(b.last_seen ?? "") ? b.last_seen : null,
      count: Number.isInteger(count) && count >= 1 ? count : 1,
      status: b.status ?? "open",
      file,
    });
  };
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (cur === null) {
      if (s.startsWith(FENCE) && s.replace(/^`+/, "").trim() === "retro-entry") cur = {};
      continue;
    }
    if (s.startsWith(FENCE)) {
      finish(true);
      continue;
    }
    const i = line.indexOf(":");
    if (i > 0 && line.slice(0, i).trim()) cur[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  finish(false);
  return { entries, damaged };
}

/** The `.md` files below `dir`, sorted; a missing dir is an empty list. */
function mdFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    let names: fs.Dirent[];
    try {
      names = fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
    } catch {
      return;
    }
    for (const n of names) {
      const p = path.join(d, n.name);
      if (n.isDirectory()) walk(p);
      else if (n.isFile() && n.name.endsWith(".md")) out.push(p);
    }
  };
  walk(dir);
  return out;
}

export interface Plan {
  from: string;
  fromExists: boolean;
  repoFile: string | null;
  files: number;
  damaged: number;
  /** Per old workspace: entries read, entries that match the keep rule, entries to import (selected and not yet in the store). */
  workspaces: { name: string; entries: number; match: number; selected: boolean; toImport: number }[];
  reviewModelLeft: number;
  alreadyImported: number;
  rows: Record<string, unknown>[];
}

export interface Options {
  from: string;
  /** This repository's old `.workflow/retro-backlog.md`, read when present and left in place. */
  repoFile: string;
  workspace: string[];
  all: boolean;
  exclude: string[];
  minCount: number;
  withinDays: number;
  now: number;
  /** `owner/name` of this repository, stored on the rows. */
  repo: string | null;
  /** Ids already in the store or its archive. */
  have: ReadonlySet<string>;
}

const KIND_MAP: Record<string, string> = { "flagged-ask": "permission" };

/** The migrated row of an old entry: a `report` row with `source: "migrated"`, the old id as key, `count`, the old dates, `ts` = now, text masked and scrubbed like a new report. */
export function migratedRow(e: OldEntry, now: number, repo: string | null): Record<string, unknown> | null {
  const kind = KIND_MAP[e.kind] ?? e.kind;
  if (!(KINDS as readonly string[]).includes(kind)) return null;
  const subject = cleanText(e.candidate, CAPS.subject);
  const what = cleanText(e.evidence ? `${e.candidate} (${e.evidence})` : e.candidate, CAPS.what);
  if (!subject || !what) return null;
  const id = crypto.createHash("sha1").update(`${e.workspace}\n${e.id}`, "utf8").digest("hex").slice(0, 10);
  return {
    row: "report", id, key: e.id, kind, subject, what, effect: "note", suggest: null, repo, workspace: e.workspace, branch: null, role: null, session: null, runId: null, version: null,
    ts: new Date(now).toISOString(), source: "migrated", count: e.count, firstSeen: e.firstSeen, lastSeen: e.lastSeen,
  };
}

/** Reads the old stores and decides what would be imported. Pure over the files; nothing is written. */
export function planMigration(o: Options): Plan {
  const files = mdFiles(o.from);
  const repoFile = fs.existsSync(o.repoFile) ? o.repoFile : null;
  const all: OldEntry[] = [];
  let damaged = 0;
  for (const f of [...files, ...(repoFile ? [repoFile] : [])]) {
    let text: string;
    try {
      text = fs.readFileSync(f, "utf8");
    } catch {
      continue;
    }
    const base = f === repoFile ? "(repository file)" : path.relative(o.from, f).replace(/\\/g, "/").replace(/\.md$/, "");
    const p = parseOldStore(text, f, base);
    damaged += p.damaged;
    all.push(...p.entries);
  }
  const selectedBy = (w: string): boolean => (o.all || o.workspace.some((g) => wildMatch(g, w))) && !o.exclude.some((g) => wildMatch(g, w));
  const byWs = new Map<string, Plan["workspaces"][number]>();
  const seen = new Set<string>();
  const rows: Record<string, unknown>[] = [];
  let reviewModelLeft = 0;
  let alreadyImported = 0;
  for (const e of all) {
    const w = byWs.get(e.workspace) ?? { name: e.workspace, entries: 0, match: 0, selected: selectedBy(e.workspace), toImport: 0 };
    byWs.set(e.workspace, w);
    w.entries++;
    if (e.kind === "review-model") {
      reviewModelLeft++;
      continue;
    }
    const last = e.lastSeen ? Date.parse(e.lastSeen) : NaN;
    const live = e.status === "open" || e.status === "planned";
    const matches = live && (e.count >= o.minCount || e.kind === "harness-bug") && !Number.isNaN(last) && o.now - last <= o.withinDays * DAY_MS;
    if (!matches) continue;
    w.match++;
    if (!w.selected) continue;
    const row = migratedRow(e, o.now, o.repo);
    if (!row) continue;
    const id = row.id as string;
    if (seen.has(id)) continue;
    seen.add(id);
    if (o.have.has(id)) {
      alreadyImported++;
      continue;
    }
    w.toImport++;
    rows.push(row);
  }
  return { from: o.from, fromExists: fs.existsSync(o.from), repoFile, files: files.length, damaged, workspaces: [...byWs.values()].sort((a, b) => (a.name < b.name ? -1 : 1)), reviewModelLeft, alreadyImported, rows };
}

/** The dry-run text of a plan. */
export function renderPlan(p: Plan, o: Pick<Options, "minCount" | "withinDays">, selection: boolean): string {
  const total = p.workspaces.reduce((n, w) => n + w.entries, 0);
  const lines = [`old store ${p.from}${p.fromExists ? "" : " (not found)"}: ${total} entries in ${p.files} file${p.files === 1 ? "" : "s"}`];
  lines.push(p.repoFile ? `repository file ${p.repoFile} is read and left in place` : "no repository file");
  lines.push(`rule: open or planned, count >= ${o.minCount} or kind harness-bug, last seen within ${o.withinDays} days`);
  if (p.workspaces.length) lines.push("workspace  entries  match  selected  to import");
  for (const w of p.workspaces) lines.push(`${w.name}  ${w.entries}  ${w.match}  ${w.selected ? "yes" : "no"}  ${w.toImport}`);
  const rest = [p.alreadyImported ? `${p.alreadyImported} already imported` : "", p.damaged ? `${p.damaged} damaged block${p.damaged === 1 ? "" : "s"} skipped` : "", p.reviewModelLeft ? `${p.reviewModelLeft} review-model entr${p.reviewModelLeft === 1 ? "y" : "ies"} left` : ""].filter(Boolean);
  lines.push(`${p.rows.length} to import${rest.length ? ` (${rest.join(", ")})` : ""}`);
  if (!selection) lines.push("no workspace selected: nothing is imported. Name old workspaces with --workspace GLOB (repeatable) or take all with --all; --exclude GLOB leaves some out.");
  return lines.join("\n");
}

/** Renames `dir` to `backlog-archive-<date>` beside it (a numeric suffix when taken); returns the new path. Nothing is deleted. */
export function archiveDir(dir: string, now: number): string {
  const base = path.join(path.dirname(dir), `backlog-archive-${new Date(now).toISOString().slice(0, 10)}`);
  let dest = base;
  for (let i = 2; fs.existsSync(dest); i++) dest = `${base}-${i}`;
  fs.renameSync(dir, dest);
  return dest;
}
