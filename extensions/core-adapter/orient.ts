// Orientation packet (foreman only): a small, deterministic, repo-relative picture of the project,
// appended once per session to the foreman's cached system section. Pure builder + one git call.
// Nothing here prints an absolute path, a timestamp or anything else that changes between turns.
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const GIT_TIMEOUT_MS = 5000;
const TREE_CAP = 80;
const DOC_LINES = 30;
const DOC_LINE_CHARS = 200;
const ROOT_FILES_CAP = 20;
const MAX_DOC_BYTES = 64 * 1024;

export interface OrientInput {
  /** Tracked file paths relative to the repo root, any order. */
  files: string[];
  agentsMd: string | null;
  readmeMd: string | null;
  /** Raw package.json text, if tracked. */
  packageJson: string | null;
  reads: { warn: number; deny: number };
  maxLines: number;
}

const byteOrder = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function treeLines(files: string[]): string[] {
  const top = new Map<string, number>();
  const sub = new Map<string, number>();
  const root: string[] = [];
  for (const f of files) {
    const parts = f.split("/");
    if (parts.length === 1) {
      root.push(f);
      continue;
    }
    top.set(parts[0], (top.get(parts[0]) ?? 0) + 1);
    if (parts.length > 2) sub.set(`${parts[0]}/${parts[1]}`, (sub.get(`${parts[0]}/${parts[1]}`) ?? 0) + 1);
  }
  const lines: string[] = [];
  for (const d of [...top.keys()].sort(byteOrder)) {
    lines.push(`${d}/ (${top.get(d)})`);
    for (const s of [...sub.keys()].filter((k) => k.startsWith(`${d}/`)).sort(byteOrder)) lines.push(`  ${s}/ (${sub.get(s)})`);
  }
  root.sort(byteOrder);
  if (root.length) lines.push(`root files: ${root.slice(0, ROOT_FILES_CAP).join(", ")}${root.length > ROOT_FILES_CAP ? `, +${root.length - ROOT_FILES_CAP} more` : ""}`);
  if (lines.length <= TREE_CAP) return lines;
  return [...lines.slice(0, TREE_CAP - 1), `… +${lines.length - (TREE_CAP - 1)} more`];
}

function toolchainLines(files: string[], packageJson: string | null): string[] {
  const has = (n: string): boolean => files.includes(n);
  const out: string[] = [];
  if (has("Cargo.toml")) out.push("Cargo.toml: `cargo build` / `cargo test`");
  if (has("go.mod")) out.push("go.mod: `go build ./...` / `go test ./...`");
  if (has("package.json")) {
    let scripts: Record<string, unknown> = {};
    try {
      const o = JSON.parse(packageJson ?? "{}") as { scripts?: Record<string, unknown> };
      if (o.scripts && typeof o.scripts === "object") scripts = o.scripts;
    } catch {
      // unreadable package.json: keep the plain hint
    }
    const named = ["test", "build"].filter((k) => typeof scripts[k] === "string").map((k) => `scripts.${k}`);
    out.push(`package.json: \`npm test\`${named.length ? ` (${named.join(", ")} defined)` : ""}`);
  }
  if (has("pyproject.toml")) out.push("pyproject.toml: `python -m pytest`");
  return out;
}

/** The packet text, or "" when there is nothing to say. Same input set -> same string. */
export function buildOrientation(inp: OrientInput): string {
  if (!inp.files.length) return "";
  const files = [...new Set(inp.files)].sort(byteOrder);
  const doc = inp.agentsMd !== null ? { name: "AGENTS.md", text: inp.agentsMd } : inp.readmeMd !== null ? { name: "README.md", text: inp.readmeMd } : null;
  const head = ["# Orientation (not a tool call; it does not count against your read budget)", "", "## Tracked files (dir, count; depth 2)"];
  const tool = toolchainLines(files, inp.packageJson);
  const tail = [...(tool.length ? ["", "## Toolchain", ...tool.map((t) => `- ${t}`)] : []), "", `Deeper exploration: launch the explorer. Your read budget before the first launch is ${inp.reads.warn}/${inp.reads.deny} (warn/deny).`];
  const tree = treeLines(files);
  let docBlock: string[] = [];
  if (doc) {
    const room = inp.maxLines - head.length - tree.length - tail.length - 2;
    const lines = doc.text.replace(/\r\n?/g, "\n").split("\n").slice(0, Math.max(0, Math.min(DOC_LINES, room))).map((l) => (l.length > DOC_LINE_CHARS ? l.slice(0, DOC_LINE_CHARS) : l.trimEnd()));
    if (lines.length > 0) docBlock = ["", `## ${doc.name} (first ${lines.length} lines)`, ...lines];
  }
  return [...head, ...tree, ...docBlock, ...tail].slice(0, Math.max(1, inp.maxLines)).join("\n");
}

function git(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

function readHead(cwd: string, name: string): string | null {
  try {
    const fd = fs.openSync(path.join(cwd, name), "r");
    try {
      const buf = Buffer.alloc(MAX_DOC_BYTES);
      return buf.subarray(0, fs.readSync(fd, buf, 0, MAX_DOC_BYTES, 0)).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/** Collect from `cwd` (the repo root is expected); "" when not a git repo or git is missing. */
export async function collectOrientation(cwd: string, opts: { reads: { warn: number; deny: number }; maxLines: number }): Promise<string> {
  const out = await git(cwd, ["ls-files", "-z"]);
  if (out === null) return "";
  const files = out.split("\0").filter(Boolean);
  const tracked = new Set(files);
  const rd = (n: string): string | null => (tracked.has(n) ? readHead(cwd, n) : null);
  return buildOrientation({ files, agentsMd: rd("AGENTS.md"), readmeMd: rd("README.md"), packageJson: rd("package.json"), ...opts });
}
