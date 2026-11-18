// Run-end findings (docs/review.md): every completed review child of a run is handed to
// `scripts/foreman_findings.py record` (the verdict record's item numbers and located findings as JSON on stdin, the reviewed files in a
// temp list), which appends the review to the session's findings store. Fail-soft: a failed or slow call records nothing.
// The located findings are the `defect` findings of the reviewer's verdict record that name a file (verdict.ts); they
// feed the `finding` trace (file basename only) and the panel's attributed block (panel.ts PendingPanels).
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { defectsOf } from "./verdict.ts";
import { splitLevel } from "./launchmodel.ts";
import type { PanelFinding } from "./panel.ts";
import type { ReviewLaunch, ReviewResult } from "./occasion.ts";

export interface Finding extends PanelFinding {
  id: string;
}

export const RECORD_TIMEOUT_MS = 10_000;

/** The id of a finding: the triple of scripts/foreman_findings.py `finding_id` (file, line // 5, class), first 12 hex of its sha1. */
export const findingId = (file: string, line: number | null, cls: string): string => crypto.createHash("sha1").update(`${file}\0${line !== null ? Math.floor(line / 5) : ""}\0${cls}`).digest("hex").slice(0, 12);

/** The located findings of a review result: its `defect` findings that name a file (a finding without a file cannot be located). */
export function findingsOfResult(r: Pick<ReviewResult, "findings">): Finding[] {
  return defectsOf(r.findings).flatMap((f) => (f.file ? [{ id: findingId(f.file, f.line ?? null, f.class ?? ""), file: f.file, line: f.line ?? null, class: f.class ?? "", note: f.text }] : []));
}

/** Unified-diff file names (`diff --git a/x b/y`, `+++ b/y`), repo-relative, in order, without repeats. */
export function filesOfDiff(diff: string | null | undefined): string[] {
  const out = new Set<string>();
  for (const line of (diff ?? "").split(/\r?\n/)) {
    const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line) ?? /^\+\+\+ b\/(.+)$/.exec(line);
    if (m) out.add((m[2] ?? m[1]).trim());
  }
  return [...out];
}

/** Changed lines (added + removed) of a unified diff, file headers left out. */
export function diffLinesOf(diff: string | null | undefined): number {
  return (diff ?? "").split(/\r?\n/).filter((l) => /^[+-]/.test(l) && !/^(?:\+\+\+|---) (?:[ab]\/|\/dev\/null)/.test(l)).length;
}

/** `plan-*.md` and `plan-*.html` paths a plan-review task names, then the ledger: the files a plan review covers. */
export function planReviewFiles(task: string, ledger: string | null): string[] {
  const plans = [...task.matchAll(/[^\s`'"()<>\[\]]*plan-[\w.-]+\.(?:md|html)/g)].map((m) => m[0]);
  return [...new Set([...plans, ...(ledger ? [ledger] : [])])];
}

/** A finding's file for the trace: its base name only (either separator). */
export const traceFile = (file: string): string => file.split(/[\\/]/).pop() ?? "";

export interface RecordContext {
  session: string;
  agentDir: string;
  runId: string;
  /** Workspace the review ran in (the result's cwd, else the session's). */
  cwd: string;
  head: string | null;
  /** The live reviewer rung, for a result that names no model. */
  live: string | null;
  now: number;
}

/** The `record` arguments of one review result (without --files-from). */
export function recordArgs(r: ReviewResult, launch: ReviewLaunch | null | undefined, c: RecordContext): string[] {
  const model = r.model ?? c.live ?? "unknown";
  const args = ["record", "--session", c.session, "--gate", r.occasion, "--model", model, "--rung", String(r.rung), "--primary", r.primary ? "1" : "0", "--role", r.role, "--run-id", c.runId, "--source", r.primary ? "live" : "panel", "--cwd", c.cwd, "--agent-dir", c.agentDir];
  if (c.head) args.push("--head", c.head);
  if (r.verdict) args.push("--verdict", r.verdict.toUpperCase());
  if (launch) args.push("--secs", ((c.now - launch.started) / 1000).toFixed(1), "--started-ts", new Date(launch.started).toISOString());
  return args;
}

/** The JSON on stdin of a `record` call: the numbered items the reviewer gave a result (not `open`) and its located findings. */
export function recordInput(r: Pick<ReviewResult, "items" | "findings">): string {
  const items = r.items.flatMap((i) => (typeof i.id === "number" && i.result !== "open" ? [i.id] : []));
  const findings = findingsOfResult(r).map((f) => ({ file: f.file, line: f.line, class: f.class || undefined, note: f.note }));
  return JSON.stringify({ items, findings });
}

/** Runs one `foreman_findings.py` call: args, stdin text; never throws in practice (runScript). */
export type RecordRunner = (args: string[], input: string) => Promise<{ text: string; ok: boolean }>;

/** Record one review result in the findings store (fail-soft); its located findings come from the verdict record. The temp file list lives in `tmpDir` and is removed after. */
export async function recordReview(r: ReviewResult, launch: ReviewLaunch | null | undefined, c: RecordContext, tmpDir: string, run: RecordRunner): Promise<Finding[]> {
  const list = path.join(tmpDir, `findings-files-${process.pid}-${Date.now()}-${r.index}-${Math.random().toString(36).slice(2, 8)}.txt`);
  try {
    fs.writeFileSync(list, (launch?.files ?? []).join("\n") + "\n", "utf8");
    await run([...recordArgs(r, launch, c), "--files-from", list], recordInput(r));
    return findingsOfResult(r);
  } catch {
    return findingsOfResult(r);
  } finally {
    try {
      fs.unlinkSync(list);
    } catch {
      // never written, or already gone
    }
  }
}

export interface RunEndFindings {
  /** Trace records: `finding` per located finding. */
  traces: Record<string, unknown>[];
  byResult: { result: ReviewResult; findings: Finding[] }[];
}

export interface RunEndInput {
  results: ReviewResult[];
  launch: ReviewLaunch | null | undefined;
  context: RecordContext;
  tmpDir: string;
}

/**
 * Record every review result of a run end (awaited one after the other) and trace its findings.
 */
export async function onReviewRunEnd(o: RunEndInput, run: RecordRunner): Promise<RunEndFindings> {
  const out: RunEndFindings = { traces: [], byResult: [] };
  for (const r of o.results) {
    const findings = await recordReview(r, o.launch, o.context, o.tmpDir, run);
    out.byResult.push({ result: r, findings });
    const model = r.model ?? o.context.live ?? "unknown";
    for (const f of findings) out.traces.push({ event: "finding", role: r.role, findingId: f.id, model: splitLevel(model).base, gate: r.occasion, class: f.class, file: traceFile(f.file), line: f.line, primary: r.primary });
  }
  return out;
}
