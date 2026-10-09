// Facts about a builder's diff for the reviewer's launch task (frugal-roles D5). A reviewer that
// reads the builder's own summary has passed a changed exported signature and a loosened test as a
// "justified adaptation"; this scan computes those facts from `git diff` so the reviewer must rule on
// them. It is a LINE-BASED heuristic (no parsers): it reads the first line of a declaration, it does
// not follow multi-line signatures, and it is a floor, not a proof. Languages: Go, Rust, TypeScript
// and JavaScript, Python.
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { headOf } from "./reviews.ts";
import { REVIEW_ROLES } from "./rounds.ts";

export type Lang = "go" | "rust" | "ts" | "py";
export interface DiffFact {
  kind: "signature" | "removed" | "test-modified" | "test-deleted" | "assertion" | "skip";
  text: string;
}

const MAX_FACTS = 20;
const MAX_LINE = 170;
const MAX_NAMES = 12;

export function langOf(file: string): Lang | null {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".go") return "go";
  if (ext === ".rs") return "rust";
  if ([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return "ts";
  if (ext === ".py") return "py";
  return null;
}

/** A test file by name or directory (`_test.go`, `tests/`, `*.test.ts`, `test_*.py`, `conftest.py`). */
export function isTestPath(file: string): boolean {
  const p = file.replace(/\\/g, "/");
  const base = p.slice(p.lastIndexOf("/") + 1);
  return (
    /_test\.go$/.test(base) ||
    /(^|[._-])(test|spec)s?\.[a-z]+$/i.test(base) ||
    /^test_.*\.py$/.test(base) ||
    /_tests?\.(py|rs)$/.test(base) ||
    base === "conftest.py" ||
    /(^|\/)(tests?|__tests__|spec)\//.test(p)
  );
}

interface Decl {
  key: string;
  name: string;
  exported: boolean;
  sig: string;
}

const norm = (s: string): string => s.replace(/\/\/.*$/, "").replace(/\s+/g, " ").replace(/\s*\{\s*$/, "").replace(/:\s*$/, "").trim();

/** The function declaration on one source line, or null. Only `func`/`fn`/`def`/`function` forms. */
export function declOf(lang: Lang, line: string): Decl | null {
  let m: RegExpExecArray | null;
  if (lang === "go") {
    m = /^func\s+(?:\(\s*(?:\w+\s+)?\*?\s*(\w+)(?:\[[^\]]*\])?\s*\)\s*)?(\w+)\s*(\(.*)$/.exec(line);
    if (!m) return null;
    const [, recv, name, rest] = m;
    return { key: `${recv ? `${recv}.` : ""}${name}`, name, exported: /^[A-Z]/.test(name), sig: norm(rest) };
  }
  if (lang === "rust") {
    m = /^\s*(pub(?:\([^)]*\))?\s+)?(?:(?:async|const|unsafe|extern\s+"[^"]*")\s+)*fn\s+(\w+)\s*(.*)$/.exec(line);
    if (!m) return null;
    return { key: m[2], name: m[2], exported: !!m[1], sig: norm(m[3]) };
  }
  if (lang === "ts") {
    m = /^\s*(export\s+(?:default\s+)?)?(?:async\s+)?function\s*\*?\s*(\w+)\s*(.*)$/.exec(line);
    if (m) return { key: m[2], name: m[2], exported: !!m[1], sig: norm(m[3]) };
    m = /^\s*export\s+const\s+(\w+)\s*(?::[^=]+)?=\s*(?:async\s*)?(\(.*)$/.exec(line);
    if (m) return { key: m[1], name: m[1], exported: true, sig: norm(m[2]) };
    return null;
  }
  m = /^(\s*)(?:async\s+)?def\s+(\w+)\s*(\(.*)$/.exec(line);
  if (!m) return null;
  return { key: m[2], name: m[2], exported: m[1] === "" && !m[2].startsWith("_"), sig: norm(m[3]) };
}

const ASSERT = /^\s*(?:require\.|assert\.|assert!|assert_eq!|assert_ne!|debug_assert|assert\s|assert\(|expect\(|expect!|self\.assert|assertThat|t\.(?:Fatal|Error)f?\()/;
const SKIP = /\bt\.Skip(?:f|Now)?\(|#\[ignore|\b(?:it|test|describe)\.skip\b|\b(?:xit|xtest|xdescribe)\(|@unittest\.skip|@pytest\.mark\.skip|pytest\.mark\.skip|pytest\.skip\(|self\.skipTest\(|\bunittest\.skip/;

const clip = (s: string, n = MAX_LINE): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

interface Hunk {
  file: string;
  removed: string[];
  added: string[];
}

/**
 * Facts from a unified diff (`git diff`, any context size). `referencedByTest(name, lang)` returns the
 * path of a test file that mentions the function, or null; it decides whether a changed non-exported
 * function counts (a Go `broadcast` called from the package's test file).
 */
export function scanDiff(diff: string, referencedByTest: (name: string, lang: Lang, file: string) => string | null = () => null): DiffFact[] {
  const facts: DiffFact[] = [];
  const hunks: Hunk[] = [];
  let file = "";
  let oldFile = "";
  let isNew = false;
  let isDeleted = false;
  let cur: Hunk | null = null;
  const touched = new Set<string>();
  const flushFile = (): void => {
    if (file && isTestPath(file) && !isNew) {
      if (isDeleted) facts.push({ kind: "test-deleted", text: `test file deleted: ${oldFile || file}` });
      else if (touched.has(file)) facts.push({ kind: "test-modified", text: `test file modified: ${file}${oldFile && oldFile !== file ? ` (renamed from ${oldFile})` : ""}` });
      else if (oldFile && oldFile !== file) facts.push({ kind: "test-modified", text: `test file renamed: ${oldFile} -> ${file}` });
    }
  };
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      flushFile();
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(raw);
      file = m ? m[2] : "";
      oldFile = m ? m[1] : "";
      isNew = false;
      isDeleted = false;
      cur = null;
      continue;
    }
    if (raw.startsWith("new file mode")) isNew = true;
    else if (raw.startsWith("deleted file mode")) isDeleted = true;
    else if (raw.startsWith("@@")) {
      cur = { file, removed: [], added: [] };
      hunks.push(cur);
      touched.add(file);
    } else if (cur && raw.startsWith("-") && !raw.startsWith("---")) cur.removed.push(raw.slice(1));
    else if (cur && raw.startsWith("+") && !raw.startsWith("+++")) cur.added.push(raw.slice(1));
  }
  flushFile();

  // Signatures: removed vs added declarations by key, per language, over the whole diff.
  const removed = new Map<string, Decl & { file: string; lang: Lang }>();
  const added = new Map<string, Decl & { file: string; lang: Lang }>();
  for (const h of hunks) {
    const lang = langOf(h.file);
    if (!lang || isTestPath(h.file)) continue;
    for (const l of h.removed) {
      const d = declOf(lang, l);
      if (d) removed.set(`${lang}:${d.key}`, { ...d, file: h.file, lang });
    }
    for (const l of h.added) {
      const d = declOf(lang, l);
      if (d) added.set(`${lang}:${d.key}`, { ...d, file: h.file, lang });
    }
  }
  let named = 0;
  for (const [k, r] of removed) {
    const a = added.get(k);
    if (a && a.sig === r.sig) continue;
    const testFile = r.exported ? null : named < MAX_NAMES ? referencedByTest(r.name, r.lang, r.file) : null;
    if (!r.exported && !testFile) continue;
    named++;
    const what = r.exported ? "exported" : `not exported, but referenced by test file ${testFile}`;
    const label = r.lang === "go" ? "func" : r.lang === "rust" ? "fn" : r.lang === "py" ? "def" : "function";
    if (a) facts.push({ kind: "signature", text: `signature changed (${what}): ${r.file}: ${label} ${r.key.split(".").pop()}${clip(r.sig, 70)} -> ${clip(a.sig, 70)}` });
    else facts.push({ kind: "removed", text: `declaration removed or renamed (${what}): ${r.file}: ${label} ${r.key}` });
  }

  // Assertions removed and skip markers added, in test files.
  for (const h of hunks) {
    if (!isTestPath(h.file)) continue;
    const gone = h.removed.filter((l) => ASSERT.test(l));
    if (gone.length > 0) {
      const now = h.added.filter((l) => ASSERT.test(l));
      const shown = gone.slice(0, 3).map((l) => `- ${clip(l, 80)}`).join(" | ");
      const repl = now.length > 0 ? ` replaced by ${now.slice(0, 3).map((l) => `+ ${clip(l, 80)}`).join(" | ")}` : " (no assertion added back in that hunk)";
      facts.push({ kind: "assertion", text: `assertion removed or changed in ${h.file}: ${shown}${repl}` });
    }
    for (const l of h.added) if (SKIP.test(l)) facts.push({ kind: "skip", text: `skip marker added in ${h.file}: ${clip(l, 100)}` });
  }
  return facts;
}

/** The bounded block appended to a reviewer's task; empty string without facts. */
export function factsBlock(facts: readonly DiffFact[], base = "HEAD"): string {
  if (facts.length === 0) return "";
  const seen = new Set<string>();
  const uniq = facts.filter((f) => (seen.has(f.text) ? false : (seen.add(f.text), true)));
  const shown = uniq.slice(0, MAX_FACTS);
  const lines = [
    "",
    "## Facts to rule on",
    `A line-based scan of the builder's diff against ${base.slice(0, 12)} found the points below (not exhaustive). Each one is a FAIL unless the task text explicitly asks for it; rule on every one in your report, and grep the callers of every changed signature.`,
    ...shown.map((f, i) => `${i + 1}. ${f.text}`),
  ];
  if (uniq.length > shown.length) lines.push(`(+${uniq.length - shown.length} more not shown)`);
  return lines.join("\n");
}

// ------------------------------------------------------------------ git side

const GIT_TIMEOUT_MS = 8000;
const MAX_DIFF = 12 * 1024 * 1024;

/** `git <args>` in `cwd`: stdout, or null on any error. */
export function git(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", ["-c", "core.quotepath=off", ...args], { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_DIFF, windowsHide: true, encoding: "utf8" }, (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

/** Facts for `cwd` against `base` (a commit; default HEAD): working tree and index changes included. */
export async function collectFacts(cwd: string, base: string | null): Promise<{ block: string; base: string; count: number }> {
  const r = await diffWithFacts(cwd, base);
  const count = Math.min(new Set(r.facts.map((f) => f.text)).size, MAX_FACTS);
  return { block: factsBlock(r.facts, r.base), base: r.base, count };
}

const dirOf = (f: string): string => {
  const p = f.replace(/\\/g, "/");
  return p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
};
const sharedDirDepth = (a: string, b: string): number => {
  const x = dirOf(a).split("/").filter(Boolean);
  const y = dirOf(b).split("/").filter(Boolean);
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i++;
  return i;
};

/**
 * The test file that calls `name` (call-shaped `name(`, also `.name(`), nearest to `changed` first. An
 * unexported Go symbol is only reachable from its own package, so only test files in the same directory count.
 */
async function callerTest(cwd: string, hits: string[], name: string, goPackageOnly: boolean, changed: string): Promise<string | null> {
  const call = new RegExp(`\\b${name}\\s*\\(`);
  const ok: string[] = [];
  for (const f of hits) {
    if (goPackageOnly && dirOf(f) !== dirOf(changed)) continue;
    try {
      if (call.test(await fs.promises.readFile(path.join(cwd, f), "utf8"))) ok.push(f);
    } catch {
      /* unreadable: no call evidence */
    }
  }
  const rank = (f: string): number => (dirOf(f) === dirOf(changed) ? 1000 : 0) + sharedDirDepth(f, changed);
  ok.sort((a, b) => rank(b) - rank(a));
  return ok[0] ?? null;
}

/** The work diff of `cwd` against `base` (null when git fails) and its facts; the trivial check (trivial.ts) reads both. */
export async function diffWithFacts(cwd: string, base: string | null): Promise<{ diff: string | null; facts: DiffFact[]; base: string }> {
  const ref = base && /^[0-9a-f]{7,64}$/.test(base) ? base : "HEAD";
  const diff = await git(cwd, ["diff", "--no-color", "--no-ext-diff", "--unified=0", "-M", ref, "--"]);
  if (diff === null || !diff.trim()) return { diff, facts: [], base: ref };
  // Non-exported functions count only when a test file mentions them: one `git grep` per candidate.
  const cache = new Map<string, string | null>();
  const names = new Set<string>();
  scanDiff(diff, (name, lang, file) => (names.add(`${lang}\u0000${name}\u0000${file}`), null));
  await Promise.all(
    [...names].slice(0, MAX_NAMES * 2).map(async (n) => {
      const [lang, name, file] = n.split("\u0000");
      if (!/^\w+$/.test(name)) return;
      const out = await git(cwd, ["grep", "--untracked", "-l", "-w", "-F", "-e", name]);
      const hits = (out?.split("\n") ?? []).filter((f) => f && isTestPath(f));
      cache.set(n, await callerTest(cwd, hits, name, lang === "go" && /^[a-z_]/.test(name), file));
    }),
  );
  return { diff, facts: scanDiff(diff, (name, lang, file) => cache.get(`${lang}\u0000${name}\u0000${file}`) ?? null), base: ref };
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);

/** Visit every launch step of a subagent call: the call itself, tasks, chain and chain parallel entries. */
function steps(input: Json): Json[] {
  const out: Json[] = [input];
  const visit = (list: unknown): void => {
    if (!Array.isArray(list)) return;
    for (const s of list) {
      if (!isObj(s)) continue;
      out.push(s);
      visit(s.parallel);
    }
  };
  visit(input.tasks);
  visit(input.chain);
  return out;
}

/**
 * Foreman-side state for the facts: the HEAD at the first builder launch per directory is the base of
 * the later review diff (a builder that commits would otherwise leave `git diff HEAD` empty); without
 * one the base is HEAD. A reviewer launch gets the block appended to its task when the diff yields facts.
 */
export class ReviewFacts {
  private readonly bases = new Map<string, string>();

  /** A new user prompt starts a new piece of work: the next builder launch records a new base. */
  reset(): void {
    this.bases.clear();
  }

  private cwdOf(step: Json, input: Json, fallback: string): string {
    const c = typeof step.cwd === "string" && step.cwd ? step.cwd : typeof input.cwd === "string" && input.cwd ? input.cwd : fallback;
    return path.resolve(fallback, c);
  }

  /** Directories with a recorded builder base, and the base (the trivial check reads them at finish). */
  recorded(): [string, string][] {
    return [...this.bases];
  }

  /** Call before a launch: records the base for each builder step. */
  async noteBuilders(input: Json, cwd: string): Promise<void> {
    for (const s of steps(input)) {
      if (s.agent !== "builder") continue;
      const dir = this.cwdOf(s, input, cwd);
      if (this.bases.has(dir)) continue;
      const head = await headOf(dir);
      if (head) this.bases.set(dir, head);
    }
  }

  /** Call before a launch: appends the facts block to each reviewer step's task; returns the number of facts added (summed over the steps changed). */
  async augment(input: Json, cwd: string): Promise<number> {
    let n = 0;
    for (const s of steps(input)) {
      if (typeof s.agent !== "string" || !REVIEW_ROLES.includes(s.agent) || typeof s.task !== "string") continue;
      const dir = this.cwdOf(s, input, cwd);
      const { block, count } = await collectFacts(dir, this.bases.get(dir) ?? null);
      if (!block) continue;
      s.task = `${s.task}\n${block}`;
      n += count;
    }
    return n;
  }
}
