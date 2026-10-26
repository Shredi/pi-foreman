// The R41 gate's trusted policy: the shipped config/permissions.policy.md, the user's <agentDir>/pi-foreman/policy.md and the overlay's
// safety.policy.files[] merged in that order, plus the project layer (<cwd>/.workflow/policy.md) that is restricted to `deny` and `ask`
// and runs as a separate tighten-only call. Nothing here throws: a layer that cannot be read is skipped and listed in `warnings`.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export const POLICY_SECTIONS = ["allow", "deny", "ask", "context"] as const;
export type PolicySection = (typeof POLICY_SECTIONS)[number];

export interface PolicyEntry {
  id: string;
  section: PolicySection;
  text: string;
  /** The file the entry came from. */
  source: string;
}

export interface PolicyLayer {
  entries: PolicyEntry[];
}

export interface PolicyDeps {
  /** The package root (holds config/permissions.policy.md). */
  pkgRoot: string;
  agentDir: string;
  cwd: string;
  /** `safety.policy.files[]` of the merged config; relative paths resolve against the agent dir. */
  files?: unknown;
}

export interface LoadedPolicy {
  trusted: PolicyLayer;
  project: PolicyLayer | null;
  /** sha256 over the merged trusted text; empty trusted layer = hash of nothing. */
  hash: string;
  warnings: string[];
}

export const shippedPolicyFile = (pkgRoot: string): string => path.join(pkgRoot, "config", "permissions.policy.md");
export const userPolicyFile = (agentDir: string): string => path.join(agentDir, "pi-foreman", "policy.md");
export const projectPolicyFile = (cwd: string): string => path.join(cwd, ".workflow", "policy.md");

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/** Entries of one policy file; problems go to `warnings`. */
export function parsePolicy(text: string, source: string, warnings: string[]): PolicyEntry[] {
  const out: PolicyEntry[] = [];
  let section: PolicySection | null = null;
  let cur: { id: string; lines: string[] } | null = null;
  const flush = (): void => {
    if (cur && section) out.push({ id: cur.id, section, text: cur.lines.join("\n").trim(), source });
    cur = null;
  };
  for (const line of text.split(/\r?\n/)) {
    const h = /^##\s+(\S+)\s*$/.exec(line);
    if (h) {
      flush();
      const name = h[1].toLowerCase();
      section = (POLICY_SECTIONS as readonly string[]).includes(name) ? (name as PolicySection) : null;
      if (!section) warnings.push(`${source}: unknown section "${h[1]}" ignored`);
      continue;
    }
    const item = /^-\s+id:\s*(\S+)\s*$/.exec(line);
    if (item) {
      flush();
      if (!section) continue;
      if (!ID_RE.test(item[1])) {
        warnings.push(`${source}: invalid entry id "${item[1]}" skipped`);
        continue;
      }
      cur = { id: item[1], lines: [] };
      continue;
    }
    if (cur) cur.lines.push(line.replace(/^ {1,4}/, ""));
  }
  flush();
  return out;
}

function readLayer(file: string, warnings: string[]): PolicyEntry[] | null {
  try {
    return parsePolicy(fs.readFileSync(file, "utf8"), file, warnings);
  } catch (e) {
    warnings.push(`${file}: not readable (${e instanceof Error ? e.message : String(e)}), layer skipped`);
    return null;
  }
}

export const policyHash = (entries: PolicyEntry[]): string => {
  const h = createHash("sha256");
  for (const e of entries) h.update(`${e.section}\n${e.id}\n${e.text}\n\n`);
  return h.digest("hex");
};

export function loadPolicy(deps: PolicyDeps): LoadedPolicy {
  const warnings: string[] = [];
  const shipped = readLayer(shippedPolicyFile(deps.pkgRoot), warnings);
  if (!shipped) {
    warnings.push("the shipped permission policy is missing: every review is denied (policy_unavailable)");
    return { trusted: { entries: [] }, project: null, hash: policyHash([]), warnings };
  }
  const files = [userPolicyFile(deps.agentDir), ...(Array.isArray(deps.files) ? deps.files.filter((f): f is string => typeof f === "string" && f.trim() !== "").map((f) => path.resolve(deps.agentDir, f)) : [])];
  const entries: PolicyEntry[] = [];
  const seen = new Set<string>();
  const add = (list: PolicyEntry[]): void => {
    for (const e of list) {
      if (seen.has(e.id)) warnings.push(`${e.source}: duplicate entry id "${e.id}" skipped`);
      else {
        seen.add(e.id);
        entries.push(e);
      }
    }
  };
  add(shipped);
  for (const f of files) {
    if (f === userPolicyFile(deps.agentDir) && !fs.existsSync(f)) continue; // the user file is optional
    const l = readLayer(f, warnings);
    if (l) add(l);
  }
  let project: PolicyLayer | null = null;
  const pf = projectPolicyFile(deps.cwd);
  if (fs.existsSync(pf)) {
    const pw: string[] = [];
    const pe = readLayer(pf, pw);
    warnings.push(...pw);
    if (pe) {
      const kept = pe.filter((e) => {
        const ok = e.section === "deny" || e.section === "ask";
        if (!ok) warnings.push(`${pf}: entry "${e.id}" in section ${e.section} ignored (the project layer may only tighten: deny, ask)`);
        return ok;
      });
      if (kept.length) project = { entries: kept };
    }
  }
  return { trusted: { entries }, project, hash: policyHash(entries), warnings };
}
