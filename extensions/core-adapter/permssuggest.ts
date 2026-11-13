// The rule workshop (`foreman perms suggest|adopt|review`, `/foreman perms ...`): turns the recurring costly decisions of the gate log into
// candidate generic rules, replays each candidate against the logged history, and lets the owner adopt chosen ones into the USER file.
//
// The log keeps shapes, not commands (gatelog.ts): paths are class words, quoted strings are `<v>`. A shape is mapped to neutral words and parsed
// again, so every count here is approximate and the would-allow counts are a lower bound (a rule can match more real calls than a redacted shape
// proves; an opaque, truncated or multi-segment shape never matches). `suggest` writes only a scratch report; `adopt` is the owner's command and
// treats the report as untrusted input.
import * as fs from "node:fs";
import * as path from "node:path";
import { gateLogFile } from "./gatelog.ts";
import { parseShell } from "./shellast.ts";
import type { ShellSegment } from "./shellast.ts";
import { BASH_TOOLS, EXEC_FLAG, matchRules, normaliseSegment, parseRule, proposeRule, ruleCallOf } from "./rules.ts";
import type { RuleEnv } from "./rules.ts";
import { PROSE_MAX, writeUserAllow } from "./permconfig.ts";

/** A rule adopted this long ago with no hit in the log is flagged by `perms review`. */
export const RULE_REVIEW_DAYS = 60;
/** `/retro` names the workshop when this many decisions cost a dialog or a classifier call in the last week. */
export const SUGGEST_AFTER = 10;
export const DEFAULT_SINCE_DAYS = 7;
export const DEFAULT_MIN_HITS = 3;
/** A group must recur in this many sessions. */
export const MIN_SESSIONS = 2;
const DAY_MS = 86_400_000;
const REPORT_VERSION = 1;
const REPORT_FENCE = "json perms-suggest";
const META_FILE = "permissions.meta.json";

export const APPROXIMATION =
  "The log keeps redacted shapes (arguments are `<v>`, paths are class words), so every count is approximate: would-allow counts are a lower bound. " +
  "An opaque, truncated or multi-segment shape never matches a single-segment rule.";

export interface LogRow {
  /** The row's own id, and the id of the row it follows (a read-clear row follows the classifier row of the same call). */
  id?: string;
  follows?: string;
  ts: number;
  session: string;
  tool: string;
  layer: string;
  verdict: string;
  rule: string;
  shape: string;
}

/** The rows of `log.1.jsonl` then `log.jsonl`; a line that is not a JSON object with the string fields is skipped. */
export function readGateLog(agentDir: string): LogRow[] {
  const file = gateLogFile(agentDir);
  const rows: LogRow[] = [];
  for (const f of [path.join(path.dirname(file), "log.1.jsonl"), file]) {
    let text = "";
    try {
      text = fs.readFileSync(f, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line) as Record<string, unknown>;
        const ts = typeof o.ts === "string" ? Date.parse(o.ts) : NaN;
        if (!Number.isFinite(ts) || typeof o.tool !== "string" || typeof o.layer !== "string") continue;
        const s = (v: unknown): string => (typeof v === "string" ? v : "");
        rows.push({ id: s(o.id), follows: s(o.follows), ts, session: s(o.session), tool: o.tool, layer: o.layer, verdict: s(o.verdict), rule: s(o.rule), shape: s(o.shape) });
      } catch {
        // a torn line is skipped
      }
    }
  }
  return rows;
}

/** A decision that cost a dialog, a classifier call, a parent's attention, or ran only because the mode is `allow`. */
export function costly(r: LogRow): boolean {
  if (r.layer === "classifier" || r.layer === "cache" || r.layer === "review" || r.layer === "dialog" || r.layer === "child-ask") return true;
  return r.layer === "mode" && r.verdict === "allow" && r.rule.startsWith("danger-");
}

/** A row of the read question (rule `read-clear` for a clear, `read-clear:<cause>` for a non-clear). */
export const readClearRow = (r: LogRow): boolean => r.rule === "read-clear" || r.rule.startsWith("read-clear:");

/**
 * The decisions that count as costly over `rows`: no read-clear row ever counts, and a first-call row (cause `model` or `no_entries`) does not count when
 * the row that follows it cleared the call. A call the read question did not clear counts exactly as before (its first-call row and its dialog row).
 */
export function costlyIn(rows: LogRow[]): (r: LogRow) => boolean {
  const cleared = new Set(rows.filter((r) => r.rule === "read-clear" && r.verdict === "allow" && r.follows).map((r) => r.follows as string));
  return (r) => costly(r) && !readClearRow(r) && !(r.id && cleared.has(r.id));
}

/** An owner or a parent said no to this shape. */
const humanDenied = (r: LogRow): boolean => (r.layer === "dialog" || r.layer === "child-ask") && r.verdict === "deny";

/** Marks a word that was a redaction placeholder in the log: never part of a proposed rule or sentence. */
const PH = "__ph_";

/** The shape with its redaction placeholders replaced by neutral words (`__ph_value`, `__ph_rel`, `/__ph_abs`), so it parses as a command line. */
export function neutralShape(shape: string): string {
  return shape
    .replace(/\/\.\.\./g, "/x")
    .replace(/<abs>/g, `/${PH}abs`)
    .replace(/<([a-z]+)>/g, `${PH}$1`);
}

const segmentsOf = (shape: string): ShellSegment[] => parseShell(neutralShape(shape), { cwd: "/w", platform: "linux" });

const RULE_ENV: RuleEnv = { cwd: "/w", home: "/h", platform: "linux", checkout: "/w" };

export interface Candidate {
  n: number;
  /** The proposed `Bash(<program> <sub> *)` rule, or null when none is safe. */
  rule: string | null;
  /** The classifier sentence for the same request type. */
  sentence: string;
  hits: number;
  sessions: number;
  /** Distinct logged segment texts the rule matches (its breadth); null without a rule. */
  shapes: number | null;
  /** Logged lines (any layer) the rule alone would have allowed; null without a rule. */
  wouldAllow: number | null;
  /** Of those, lines that cost a dialog, a classifier call or an `allow` mode. */
  wouldAllowCostly: number | null;
  /** Lines an owner or parent denied that the rule would allow. */
  conflicts: number | null;
  review: boolean;
  safety: string[];
}

export interface SuggestReport {
  version: number;
  generated: string;
  sinceDays: number;
  minHits: number;
  rows: number;
  costly: number;
  approximation: string;
  candidates: Candidate[];
}

interface Group {
  key: string;
  seg: ShellSegment;
  rule: string | null;
  danger: string;
  hits: number;
  sessions: Set<string>;
}

const execFlagged = (s: ShellSegment): boolean => s.argv.some((w, i) => EXEC_FLAG.test(w) || (w === "-o" && /^ProxyCommand/i.test(s.argv[i + 1] ?? "")));

/** A whitelist sentence for the request type: program, subcommand and option words only (the shape's arguments are redacted, so none is named). */
function sentenceOf(seg: ShellSegment, danger: string): string {
  const sub = seg.argv[0] && /^[A-Za-z][\w-]*$/.test(seg.argv[0]) ? ` ${seg.argv[0]}` : "";
  const opts = [...new Set(seg.argv.filter((w) => w.startsWith("-") && !w.includes(PH)).map((w) => w.split("=")[0]))].sort();
  const clean = `${seg.program}${sub}${opts.length ? ` ${opts.join(" ")}` : ""}`.replace(/[\u0000-\u001f\u007f-\u009f"]/g, " ").slice(0, 80);
  return `Run "${clean}"${seg.opaque !== null ? ", also in a form the shell parser cannot read exactly" : ""}${danger ? ` (the ${danger.replace(/^danger-/, "")} class)` : ""}`;
}

/** Group, propose and replay. `now` is epoch ms. */
export function suggest(rows: LogRow[], opts: { now: number; sinceDays?: number; minHits?: number }): SuggestReport {
  const sinceDays = opts.sinceDays ?? DEFAULT_SINCE_DAYS;
  const minHits = opts.minHits ?? DEFAULT_MIN_HITS;
  const from = opts.now - sinceDays * DAY_MS;
  const isCostly = costlyIn(rows);
  const period = rows.filter((r) => r.ts >= from && r.ts <= opts.now);
  const shellRows = period.filter((r) => BASH_TOOLS.has(r.tool) && r.tool !== "powershell" && r.shape.trim() !== "" && !readClearRow(r));

  // one parse per distinct shape; counts per shape
  const shapes = new Map<string, { segs: ShellSegment[]; count: number; costly: number; denied: number }>();
  for (const r of shellRows) {
    let e = shapes.get(r.shape);
    if (!e) shapes.set(r.shape, (e = { segs: segmentsOf(r.shape), count: 0, costly: 0, denied: 0 }));
    e.count++;
    if (isCostly(r)) e.costly++;
    if (humanDenied(r)) e.denied++;
  }

  const groups = new Map<string, Group>();
  for (const r of shellRows) {
    if (!isCostly(r)) continue;
    const seenKeys = new Set<string>();
    for (const seg of shapes.get(r.shape)!.segs) {
      if (seg.program === "") continue;
      const rule = seg.opaque === null && !(seg.argv[0] ?? "").includes(PH) ? (proposeRule([seg])?.[0] ?? null) : null;
      // a rule-able segment groups by its rule; the rest by program, subcommand and option words (the sentence names exactly those)
      const danger = r.rule.startsWith("danger-") ? r.rule : seg.opaque !== null ? "danger-opaque" : "";
      const key = rule ?? `~${sentenceOf(seg, danger)}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { key, seg, rule, danger, hits: 0, sessions: new Set() }));
      g.hits++;
      g.sessions.add(r.session);
    }
  }

  const execByProgram = new Map<string, number>();
  for (const e of shapes.values()) for (const s of e.segs) if (execFlagged(s)) execByProgram.set(s.program, (execByProgram.get(s.program) ?? 0) + e.count);

  const kept = [...groups.values()].filter((g) => g.hits >= minHits && g.sessions.size >= MIN_SESSIONS).sort((a, b) => b.hits - a.hits || a.key.localeCompare(b.key));
  const candidates: Candidate[] = kept.map((g, i) => {
    const sentence = sentenceOf(g.seg, g.danger);
    if (g.rule === null) {
      const why = g.seg.opaque !== null ? "an opaque segment" : execFlagged(g.seg) ? "an exec flag (-e, -c, -exec ...)" : (g.seg.argv[0] ?? "").includes(PH) ? "a redacted first argument (the log keeps no value to build a rule on)" : "a glob character or a flag in first position";
      return { n: i + 1, rule: null, sentence, hits: g.hits, sessions: g.sessions.size, shapes: null, wouldAllow: null, wouldAllowCostly: null, conflicts: null, review: false, safety: [`no pattern rule: the segment has ${why}; the sentence goes to the classifier, which still judges each call`] };
    }
    const parsed = parseRule(g.rule);
    if ("error" in parsed) throw new Error(`proposeRule made an invalid rule: ${parsed.error}`);
    let wouldAllow = 0;
    let wouldAllowCostly = 0;
    let conflicts = 0;
    const texts = new Set<string>();
    for (const [shape, e] of shapes) {
      const call = ruleCallOf("bash", { command: shape }, { cwd: RULE_ENV.cwd, home: RULE_ENV.home, platform: RULE_ENV.platform, segments: e.segs });
      if (matchRules({ deny: [], ask: [], allow: [parsed.rule] }, call, RULE_ENV).verdict !== "allow") continue;
      wouldAllow += e.count;
      wouldAllowCostly += e.costly;
      conflicts += e.denied;
      for (const s of e.segs) texts.add(normaliseSegment(s, "linux"));
    }
    const prog = g.seg.program;
    const bare = g.seg.argv.length === 0 || g.seg.argv[0].startsWith("-");
    const safety = [
      (execByProgram.get(prog) ?? 0) > 0
        ? `exec-flag exposure: the rule ends in a wildcard, so an exec flag after it passes; ${execByProgram.get(prog)} logged lines of ${prog} carried one`
        : `exec-flag exposure: no logged line of ${prog} carried an exec flag, but the wildcard would let one pass`,
      `wildcard breadth: matches ${texts.size} distinct logged segments${bare ? `, and covers every use of ${prog}` : ""}`,
      conflicts > 0 ? `denied history: also allows ${conflicts} logged lines an owner or parent denied (review)` : "denied history: allows no logged line an owner or parent denied",
      "also allows this segment inside other lines and from other directories",
    ];
    return { n: i + 1, rule: g.rule, sentence, hits: g.hits, sessions: g.sessions.size, shapes: texts.size, wouldAllow, wouldAllowCostly, conflicts, review: conflicts > 0, safety };
  });
  return { version: REPORT_VERSION, generated: new Date(opts.now).toISOString(), sinceDays, minHits, rows: period.length, costly: period.filter(isCostly).length, approximation: APPROXIMATION, candidates };
}

const num = (v: number | null): string => (v === null ? "-" : String(v));

export function renderTable(rep: SuggestReport): string {
  const lines = [
    `perms suggest: ${rep.costly} costly decisions of ${rep.rows} logged in the last ${rep.sinceDays} days; groups with at least ${rep.minHits} hits over ${MIN_SESSIONS} sessions`,
    rep.approximation,
  ];
  if (rep.candidates.length === 0) return [...lines, "no candidates"].join("\n");
  lines.push("n  hits  sess  would-allow  conflicts  candidate");
  for (const c of rep.candidates) lines.push(`${c.n}  ${c.hits}  ${c.sessions}  ${num(c.wouldAllow)}  ${num(c.conflicts)}${c.review ? " review" : ""}  ${c.rule ?? c.sentence}`);
  return lines.join("\n");
}

/** The scratch report: readable text plus the candidate block `adopt` reads (and re-validates). */
export function renderMarkdown(rep: SuggestReport): string {
  const out = [`# perms suggest ${rep.generated.slice(0, 10)}`, "", rep.approximation, "", "```text", renderTable(rep), "```", ""];
  for (const c of rep.candidates) {
    out.push(`## ${c.n}. ${c.rule ?? c.sentence}${c.review ? " (review)" : ""}`, "", `- hits ${c.hits} over ${c.sessions} sessions; would allow ${num(c.wouldAllow)} logged lines (${num(c.wouldAllowCostly)} of the costly ones); conflicts: ${num(c.conflicts)}`);
    if (c.rule) out.push(`- sentence instead: ${c.sentence}`);
    for (const s of c.safety) out.push(`- ${s}`);
    out.push("");
  }
  out.push("Adopt with `foreman perms adopt <this file> <n>...` in your own terminal.", "", `\`\`\`${REPORT_FENCE}`, JSON.stringify(rep, null, 2), "```", "");
  return out.join("\n");
}

/** `foreman perms suggest [--since <days>] [--min <n>] [--json]`: writes the scratch report, returns the stdout text. */
export function runSuggest(agentDir: string, cwd: string, args: string[], now: number = Date.now()): { ok: true; text: string; file: string } | { ok: false; error: string } {
  let sinceDays = DEFAULT_SINCE_DAYS;
  let minHits = DEFAULT_MIN_HITS;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") json = true;
    else if (a === "--since" || a === "--min") {
      const v = Number(args[++i]);
      if (!Number.isInteger(v) || v < 1) return { ok: false, error: `${a} needs a whole number of at least 1` };
      if (a === "--since") sinceDays = v;
      else minHits = v;
    } else return { ok: false, error: `unknown argument '${a}'` };
  }
  const rep = suggest(readGateLog(agentDir), { now, sinceDays, minHits });
  const file = path.join(cwd, ".workflow", "scratch", `perms-suggest-${rep.generated.slice(0, 10)}.md`);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, renderMarkdown(rep), "utf8");
  } catch (e) {
    return { ok: false, error: `could not write ${file}: ${(e as Error).message}` };
  }
  return { ok: true, text: json ? JSON.stringify(rep, null, 2) : `${renderTable(rep)}\nreport: ${file}`, file };
}

// ------------------------------------------------------------------ adopt

export type AdoptPick = { n: number; as: "rule" | "sentence" };

/** `3` adopts candidate 3's rule (its sentence when it has none), `3:s` its sentence. */
export function parsePicks(args: string[]): AdoptPick[] | string {
  const out: AdoptPick[] = [];
  for (const a of args) {
    const m = /^([1-9]\d{0,3})(:s)?$/.exec(a);
    if (!m) return `'${a.slice(0, 40)}' is not a candidate number (use 3 or 3:s for the sentence)`;
    out.push({ n: Number(m[1]), as: m[2] ? "sentence" : "rule" });
  }
  return out.length ? out : "name at least one candidate number";
}

const CTRL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/** Re-validation of a rule from an untrusted report: a `Bash(<program> [<arg>] *)` rule of the shape `proposeRule` makes. Null when fine, else the reason. */
export function ruleProblem(rule: unknown): string | null {
  if (typeof rule !== "string" || rule.length > 200 || CTRL.test(rule)) return "the rule is not a short single-line string";
  const p = parseRule(rule);
  if ("error" in p) return p.error;
  if (p.rule.text !== rule || p.rule.tool !== "Bash" || p.rule.pattern === null) return "only Bash(<program> ... *) rules are adopted";
  if (!p.rule.pattern.endsWith(" *")) return "the rule must end in ' *'";
  const words = p.rule.pattern.slice(0, -2).split(" ");
  if (words.some((w) => w === "" || /[*?()\n]/.test(w))) return "the rule carries a glob character or empty words before the final wildcard";
  if (words.some((w, i) => EXEC_FLAG.test(w) || (w === "-o" && /^ProxyCommand/i.test(words[i + 1] ?? "")))) return "the rule carries an exec flag";
  if (words.length > 2 || (words[1] ?? "x").startsWith("-")) return "the rule is not of the form <program> [<subcommand>] *";
  return null;
}

/** Re-validation of a sentence from an untrusted report. */
export function sentenceProblem(s: unknown): string | null {
  if (typeof s !== "string" || s.trim() === "") return "the sentence is empty";
  if (s.length > PROSE_MAX) return `the sentence is longer than ${PROSE_MAX} characters`;
  if (CTRL.test(s)) return "the sentence carries control characters";
  return null;
}

export interface Entry {
  kind: "rule" | "sentence";
  text: string;
  shapes: number;
}

/** The chosen entries of an untrusted report text, each re-validated; the first problem refuses the whole adoption. */
export function entriesFromReport(text: string, picks: AdoptPick[]): { ok: true; entries: Entry[] } | { ok: false; error: string } {
  const m = new RegExp(`\`\`\`${REPORT_FENCE}\\r?\\n([\\s\\S]*?)\\r?\\n\`\`\``).exec(text);
  if (!m) return { ok: false, error: "the file has no perms-suggest block" };
  let cands: unknown;
  try {
    cands = (JSON.parse(m[1]) as { candidates?: unknown }).candidates;
  } catch {
    return { ok: false, error: "the perms-suggest block is not valid JSON" };
  }
  if (!Array.isArray(cands)) return { ok: false, error: "the perms-suggest block has no candidate list" };
  const entries: Entry[] = [];
  for (const p of picks) {
    const c = cands.find((x) => x && typeof x === "object" && (x as { n?: unknown }).n === p.n) as { rule?: unknown; sentence?: unknown; shapes?: unknown; hits?: unknown } | undefined;
    if (!c) return { ok: false, error: `candidate ${p.n} is not in the report` };
    const shapes = typeof c.shapes === "number" && Number.isFinite(c.shapes) ? c.shapes : typeof c.hits === "number" && Number.isFinite(c.hits) ? c.hits : 0;
    if (p.as === "rule" && c.rule !== null && c.rule !== undefined) {
      const why = ruleProblem(c.rule);
      if (why) return { ok: false, error: `candidate ${p.n} refused: ${why}` };
      entries.push({ kind: "rule", text: c.rule as string, shapes });
    } else {
      const why = sentenceProblem(c.sentence);
      if (why) return { ok: false, error: `candidate ${p.n} refused: ${why}` };
      entries.push({ kind: "sentence", text: (c.sentence as string).trim(), shapes });
    }
  }
  return { ok: true, entries };
}

export const metaFile = (agentDir: string): string => path.join(agentDir, "pi-foreman", META_FILE);

export interface MetaEntry {
  added: string;
  source: "suggest";
  shapes: number;
}

function readMeta(agentDir: string): Record<string, MetaEntry> | null {
  try {
    const v = JSON.parse(fs.readFileSync(metaFile(agentDir), "utf8")) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, MetaEntry>) : null;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? {} : null;
  }
}

/**
 * Adopt the chosen candidates of a report into the user file. `confirm` is asked once per entry with the exact text; the caller supplies it (a TTY
 * prompt, or the slash command's select). Returns the lines to print.
 */
export async function adopt(
  agentDir: string,
  reportText: string,
  picks: AdoptPick[],
  confirm: (e: Entry, file: string) => Promise<boolean>,
  now: number = Date.now(),
): Promise<{ ok: boolean; lines: string[] }> {
  const v = entriesFromReport(reportText, picks);
  if (v.ok === false) return { ok: false, lines: [`pi-foreman: nothing adopted: ${v.error}`] };
  const file = path.join(agentDir, "pi-foreman", "permissions.json");
  const yes: Entry[] = [];
  const lines: string[] = [];
  for (const e of v.entries) {
    if (await confirm(e, file)) yes.push(e);
    else lines.push(`skipped ${e.kind}: ${e.text}`);
  }
  if (yes.length === 0) return { ok: true, lines: [...lines, "nothing adopted"] };
  const w = writeUserAllow(agentDir, { rules: yes.filter((e) => e.kind === "rule").map((e) => e.text), sentences: yes.filter((e) => e.kind === "sentence").map((e) => e.text) });
  if (w.ok === false) return { ok: false, lines: [...lines, `pi-foreman: nothing adopted: ${w.reason}`] };
  for (const t of w.added) lines.push(`adopted ${t}`);
  for (const e of yes) if (!w.added.includes(e.text)) lines.push(`already in the file: ${e.text}`);
  const meta = readMeta(agentDir);
  if (meta === null) lines.push(`warning: ${metaFile(agentDir)} is not valid JSON; the age of the new entries is not recorded`);
  else {
    for (const e of yes) if (w.added.includes(e.text)) meta[e.text] = { added: new Date(now).toISOString(), source: "suggest", shapes: e.shapes };
    try {
      const tmp = `${metaFile(agentDir)}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(tmp, metaFile(agentDir));
    } catch (e) {
      lines.push(`warning: could not write ${metaFile(agentDir)}: ${(e as Error).message}`);
    }
  }
  lines.push(`written to ${w.file}; a running session picks it up with /foreman perms reload`);
  return { ok: true, lines };
}

// ------------------------------------------------------------------ review and the retro line

/** `foreman perms review`: adopted entries with age and hits since adoption (layer `rule` names the pattern); flags old rules with no hit. Writes nothing. */
export function review(agentDir: string, now: number = Date.now()): string {
  const meta = readMeta(agentDir);
  if (meta === null) return `${metaFile(agentDir)} is not valid JSON`;
  const names = Object.keys(meta);
  if (names.length === 0) return "no adopted entries (foreman perms adopt records them)";
  const rows = readGateLog(agentDir).filter((r) => r.layer === "rule");
  const lines = [`adopted entries (a rule older than ${RULE_REVIEW_DAYS} days with no hit is flagged):`];
  for (const text of names) {
    const m = meta[text];
    const added = Date.parse(m?.added ?? "");
    const age = Number.isFinite(added) ? Math.floor((now - added) / DAY_MS) : null;
    const isRule = text.startsWith("Bash(");
    const hits = isRule && Number.isFinite(added) ? rows.filter((r) => r.ts >= added && r.rule.split("+").includes(text)).length : null;
    const flag = isRule && age !== null && age > RULE_REVIEW_DAYS && hits === 0 ? "  REVIEW: no hit since adoption" : "";
    lines.push(`${text}  age ${age === null ? "?" : `${age}d`}  hits ${hits === null ? "n/a (sentence)" : hits}${flag}`);
  }
  return lines.join("\n");
}

/** The `/retro` line, or null below SUGGEST_AFTER. */
export function suggestHint(agentDir: string, now: number = Date.now()): string | null {
  const from = now - DEFAULT_SINCE_DAYS * DAY_MS;
  const rows = readGateLog(agentDir);
  const isCostly = costlyIn(rows);
  const n = rows.filter((r) => r.ts >= from && r.ts <= now && isCostly(r)).length;
  return n >= SUGGEST_AFTER ? `${n} decisions cost a dialog or a classifier call in the last ${DEFAULT_SINCE_DAYS} days; run foreman perms suggest` : null;
}

/** The `/retro` line that counts the lines the read question cleared in the last week (rule `read-clear` in the decision log), or null when none. */
export function readClearHint(agentDir: string, now: number = Date.now()): string | null {
  const from = now - DEFAULT_SINCE_DAYS * DAY_MS;
  const n = readGateLog(agentDir).filter((r) => r.ts >= from && r.ts <= now && r.rule === "read-clear" && r.verdict === "allow").length;
  return n > 0 ? `${n} shell lines the gate could not read were cleared by the read judge (a model) in the last ${DEFAULT_SINCE_DAYS} days (rule read-clear in the decision log); gate.readClear false switches it off` : null;
}
