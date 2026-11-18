// Shared by the test rigs (_r46world, _r11rig, _hsrig, _loopstop): a fake reviewer run ends with a verdict record, the way the child's `review_verdict`
// tool leaves it (verdict.ts), not with report text. A launch's binding (`extensionBindings["pi-foreman/1"]`, set in place by the tool_call hook)
// names the record folder (`verdictDir`), the launch id and the launch's items.
//
// `legacySpec` turns the old report shape ("Overall verdict: PASS", "1. FAIL src/x.ts:1 broken") into a record call, so a test that passes a verdict word or
// a report string keeps its call; it is test code only, the harness reads no text. A numbered FAIL line whose item the launch does not accept
// becomes a located `defect` finding (file `legacy/item-<N>`, line N), so two such reports with the same numbers still give the same loop key.
import { BINDING_NS } from "../usage.ts";
import { reviewResultsOfRunEnd, type ReviewResult } from "../occasion.ts";
import { itemIdOf, recordOf, writeRecord, type ItemId, type VerdictFinding, type VerdictItem, type VerdictRecord, type VerdictValue } from "../verdict.ts";

type Json = Record<string, unknown>;

/** A record call: what the reviewer hands `review_verdict`. */
export interface RecSpec {
  verdict: VerdictValue;
  items?: VerdictItem[];
  findings?: VerdictFinding[];
  reason?: string;
}

/** The launch binding a hook set on the input of a single launch, or null. */
export function bindingOf(input: unknown): { launchId: string; verdictDir?: string; items?: ItemId[]; role?: string } | null {
  const b = (input as { extensionBindings?: Record<string, unknown> } | null | undefined)?.extensionBindings?.[BINDING_NS];
  return b && typeof b === "object" ? (b as { launchId: string; verdictDir?: string; items?: ItemId[]; role?: string }) : null;
}

/** The record call of a legacy report string; null = the text names no verdict (the run leaves no record). */
export function legacySpec(output: unknown, allowed: readonly ItemId[] = []): RecSpec | null {
  if (typeof output !== "string") return null;
  const words = [...output.matchAll(/\bverdict\s*\**\s*:\s*\**\s*(pass|fail|approve|block)\b/gi)].map((m) => m[1].toLowerCase());
  if (words.length === 0) return null;
  const verdict: VerdictValue = words.some((w) => w === "fail" || w === "block") ? "fail" : "pass";
  const items: VerdictItem[] = [];
  const findings: VerdictFinding[] = [];
  const seen = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const m = /^\s*(?:[-*]\s+)?(\d+)[.)]\s*(PASS|FAIL)\b(.*)$/.exec(line);
    if (!m || seen.has(m[1])) continue;
    seen.add(m[1]);
    const id = itemIdOf(Number(m[1]));
    const rest = m[3].replace(/\s+/g, " ").trim();
    const ok = id !== null && allowed.includes(id);
    if (m[2] === "PASS") {
      if (ok) items.push({ id: id as ItemId, result: "pass" });
    } else if (verdict === "fail") {
      const at = /(\S+\.\w+):(\d+)/.exec(rest);
      const text = (rest.replace(/^[:\s-]+/, "") || `item ${m[1]} fails`).slice(0, 290);
      if (ok) items.push({ id: id as ItemId, result: "fail" });
      if (at) findings.push({ kind: "defect", text, file: at[1], line: Number(at[2]) });
      else if (!ok) findings.push({ kind: "defect", text, file: `legacy/item-${m[1]}`, line: Number(m[1]) });
    }
  }
  if (verdict === "fail" && !items.some((i) => i.result === "fail") && !findings.length) findings.push({ kind: "defect", text: "the review failed" });
  return verdict === "pass" ? { verdict, items, findings: [] } : { verdict, items, findings };
}

/** Writes the record of `spec` into the launch folder of `input`; false when the launch has no folder (not a review launch) or `spec` is null. */
export function writeSpec(input: unknown, spec: RecSpec | null): boolean {
  const b = bindingOf(input);
  if (!b?.verdictDir || !spec) return false;
  writeRecord(b.verdictDir, recordOf(b.launchId, { verdict: spec.verdict, items: spec.items ?? [], findings: spec.findings ?? [], ...(spec.reason ? { reason: spec.reason } : {}) }));
  return true;
}

/** The record a run end leaves for report text `output` (legacy shape): see `legacySpec`. */
export function writeFromReport(input: unknown, output: unknown): boolean {
  const b = bindingOf(input);
  return writeSpec(input, legacySpec(output, b?.items ?? []));
}

/** The text a run end carries first among `results`' outputs that names a verdict (the data shape of a run-end event). */
export function reportOf(data: Json): string {
  const results = Array.isArray(data.results) ? (data.results as Json[]) : [];
  const withVerdict = [...results.map((r) => r.output), data.summary, data.output].find((o) => legacySpec(o, [Number.MAX_SAFE_INTEGER]) !== null);
  return typeof withVerdict === "string" ? withVerdict : typeof results[0]?.output === "string" ? (results[0].output as string) : typeof data.summary === "string" ? data.summary : typeof data.output === "string" ? data.output : "";
}

/** A passing record call (no items given). */
export const PASS_SPEC: RecSpec = { verdict: "pass" };
/** A failing record call with one located defect finding. */
export const FAIL_SPEC: RecSpec = { verdict: "fail", findings: [{ kind: "defect", text: "the guard is missing", file: "src/guard.ts", line: 1 }] };

/** The record of `spec` as a parent reads it (no file): for the unit tests of the consumers. */
export const recordFrom = (spec: RecSpec, launchId = "L"): VerdictRecord => recordOf(launchId, { verdict: spec.verdict, items: spec.items ?? [], findings: spec.findings ?? [], ...(spec.reason ? { reason: spec.reason } : {}) });

/** The review results of a run-end event whose reviewer left `spec` (null = no record): `reviewResultsOfRunEnd` without launch bookkeeping. */
export const resultsOf = (data: unknown, spec: RecSpec | null): ReviewResult[] => reviewResultsOfRunEnd(data, null, spec ? recordFrom(spec) : null);
