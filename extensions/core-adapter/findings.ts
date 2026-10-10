// Run-end findings (docs/ladder.md): every completed review child of a run is handed to
// `scripts/foreman_findings.py record` (report text on stdin, the reviewed files in a temp list),
// which appends the review and its located findings to the session's findings store and prints
// them. Fail-soft: a failed, slow or unparsable call counts as zero findings and traces nothing.
// The located findings feed the on-find climb (primary item and pre-pr reviews only), the `finding`
// trace (file basename only) and the panel's attributed block (panel.ts).
import * as fs from "node:fs";
import * as path from "node:path";
import { verdictItemsOf } from "./reviewmarks.ts";
import { splitLevel } from "./launchmodel.ts";
import type { OnFindClimb } from "./reviewerclimb.ts";
import { composePanelBlock, type PanelFinding } from "./panel.ts";
import type { ReviewLaunch, ReviewResult } from "./occasion.ts";

export interface Finding extends PanelFinding {
  id: string;
}

export const RECORD_TIMEOUT_MS = 10_000;

/** The `findings` of the record call's stdout JSON; [] for anything else. */
export function parseRecordOutput(text: string): Finding[] {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return [];
  }
  const list = j && typeof j === "object" ? (j as { findings?: unknown }).findings : undefined;
  if (!Array.isArray(list)) return [];
  const out: Finding[] = [];
  for (const f of list) {
    if (!f || typeof f !== "object") continue;
    const r = f as Record<string, unknown>;
    if (typeof r.file !== "string" || !r.file) continue;
    out.push({ id: typeof r.id === "string" ? r.id : "", file: r.file, line: typeof r.line === "number" && Number.isFinite(r.line) ? r.line : null, class: typeof r.class === "string" ? r.class : "", note: typeof r.note === "string" ? r.note : "" });
  }
  return out;
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

/** `plan-*.md` paths a plan-review task names, then the ledger: the files a plan review covers. */
export function planReviewFiles(task: string, ledger: string | null): string[] {
  const plans = [...task.matchAll(/[^\s`'"()<>\[\]]*plan-[\w.-]+\.md/g)].map((m) => m[0]);
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
  /** On-find rungs (OnFindClimb.rungs); the model's index there is the recorded rung, else 0. */
  rungs: string[];
  /** The live reviewer rung, for a result that names no model. */
  live: string | null;
  now: number;
}

/** The `record` arguments of one review result (without --files-from). */
export function recordArgs(r: ReviewResult, launch: ReviewLaunch | null | undefined, c: RecordContext): string[] {
  const model = r.model ?? c.live ?? "unknown";
  const rung = Math.max(0, c.rungs.findIndex((m) => splitLevel(m).base === splitLevel(model).base));
  const args = ["record", "--session", c.session, "--gate", r.occasion, "--model", model, "--rung", String(rung), "--primary", r.primary ? "1" : "0", "--role", r.role, "--run-id", c.runId, "--source", r.primary ? "live" : "panel", "--cwd", c.cwd, "--agent-dir", c.agentDir];
  if (c.head) args.push("--head", c.head);
  if (r.verdict) args.push("--verdict", r.verdict.toUpperCase());
  if (launch) args.push("--secs", ((c.now - launch.started) / 1000).toFixed(1), "--started-ts", new Date(launch.started).toISOString());
  return args;
}

/** Runs one `foreman_findings.py` call: args, stdin text; never throws in practice (runScript). */
export type RecordRunner = (args: string[], input: string) => Promise<{ text: string; ok: boolean }>;

/** Record one review result; its located findings ([] on any failure). The temp file list lives in `tmpDir` and is removed after. */
export async function recordReview(r: ReviewResult, launch: ReviewLaunch | null | undefined, c: RecordContext, tmpDir: string, run: RecordRunner): Promise<Finding[]> {
  const list = path.join(tmpDir, `findings-files-${process.pid}-${Date.now()}-${r.index}-${Math.random().toString(36).slice(2, 8)}.txt`);
  try {
    fs.writeFileSync(list, (launch?.files ?? []).join("\n") + "\n", "utf8");
    const res = await run([...recordArgs(r, launch, c), "--files-from", list], r.text);
    return res.ok ? parseRecordOutput(res.text) : [];
  } catch {
    return [];
  } finally {
    try {
      fs.unlinkSync(list);
    } catch {
      // never written, or already gone
    }
  }
}

export interface RunEndFindings {
  /** Trace records: `finding` per located finding, then the on-find climb's records. */
  traces: Record<string, unknown>[];
  /** The panel's attributed block ("" when the launch was no panel or nothing was located). */
  block: string;
  byResult: { result: ReviewResult; findings: Finding[] }[];
}

export interface RunEndInput {
  results: ReviewResult[];
  launch: ReviewLaunch | null | undefined;
  context: RecordContext;
  tmpDir: string;
  /** The on-find climb, when ladder.reviewerClimb is enabled in mode on-find. */
  climb?: OnFindClimb;
  ledger: string | null;
  /** ladder.reviewPanel.visible. */
  visible: boolean;
}

/**
 * Record every review result of a run end (awaited one after the other), trace its findings, feed
 * the on-find climb with the counting `reviewer` results (located = the PASS report located a
 * finding; a FAIL climbs regardless) and compose the panel block.
 */
export async function onReviewRunEnd(o: RunEndInput, run: RecordRunner): Promise<RunEndFindings> {
  const out: RunEndFindings = { traces: [], block: "", byResult: [] };
  for (const r of o.results) {
    const findings = await recordReview(r, o.launch, o.context, o.tmpDir, run);
    out.byResult.push({ result: r, findings });
    const model = r.model ?? o.context.live ?? "unknown";
    for (const f of findings) out.traces.push({ event: "finding", role: r.role, findingId: f.id, model: splitLevel(model).base, gate: r.occasion, class: f.class, file: traceFile(f.file), line: f.line, primary: r.primary });
    if (o.climb && r.counts && r.role === "reviewer") {
      const located = findings.length > 0;
      out.traces.push(...o.climb.onVerdict(o.context.runId, verdictItemsOf(r.text, "FAIL"), "fail", located, model, o.ledger), ...o.climb.onVerdict(o.context.runId, verdictItemsOf(r.text, "PASS"), "pass", located, model, o.ledger));
    }
  }
  if (o.launch?.panel) {
    const name = (x: { result: ReviewResult }): string => splitLevel(x.result.model ?? x.result.shadow ?? o.context.live ?? "primary").base;
    const primary = out.byResult.find((x) => x.result.primary && x.result.role === "reviewer");
    const shadows = out.byResult.filter((x) => !x.result.primary).map((x) => ({ model: name(x), findings: x.findings }));
    out.block = composePanelBlock({ model: primary ? name(primary) : o.launch.panel.primary, findings: primary?.findings ?? [] }, shadows, o.visible);
  }
  return out;
}
