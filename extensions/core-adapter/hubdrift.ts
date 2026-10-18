// `paths.hubWorkflow` against the live permission-system config (ledger item R11-2). A plain session's read of `<hub>/.workflow/LEDGER-*.md` is
// allowed by the rendered `external_directory_read` keys only (scripts/permissions_gen.py hub_read_patterns); a config rendered while
// paths.hubWorkflow was unset carries none, so the read falls to the catch-all `external_directory["*"] = "ask"`. The doctor and
// `/foreman setup` name that drift; nothing here changes a rule or sets the key.
import * as fs from "node:fs";
import * as path from "node:path";
import { psGlobalConfigPath } from "./permsys.ts";
import { hubWorkflowDirs } from "./roundsurface.ts";

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * WARN when paths.hubWorkflow is set but the live rendered config lacks a hub's `<hub>/.workflow` or `<hub>/.workflow/*` read key (no line when the
 * file is missing or unreadable: the permission-file check already fails then). INFO hint when paths.hubWorkflow is unset while a `.workflow/` dir
 * holding a LEDGER-*.md file exists one level above the main checkout of one of `checkouts` (a round worktree `<repo>.worktrees/<round>` stands for
 * its main checkout `<repo>`, derived as mainWorkflowReadable does; any other dir is a main checkout itself); the key is never set automatically.
 */
export function hubWorkflowDriftLines(i: { agentDir: string; hubWorkflow: unknown; checkouts: string[]; platform?: string }): string[] {
  const doubled = (typeof i.hubWorkflow === "string" ? [i.hubWorkflow] : Array.isArray(i.hubWorkflow) ? i.hubWorkflow : [])
    .filter((v): v is string => typeof v === "string" && v.split(/[\\/]+/).filter(Boolean).pop() === ".workflow")
    .map((v) => `WARN paths.hubWorkflow ${v} ends in .workflow: ${HUB_ROOT_FIX}.`);
  return [...doubled, ...driftLines(i)];
}

export const HUB_ROOT_FIX = "hub ROOT, the renderer appends .workflow";

function driftLines(i: { agentDir: string; hubWorkflow: unknown; checkouts: string[]; platform?: string }): string[] {
  const platform = i.platform ?? process.platform;
  const dirs = hubWorkflowDirs(i.hubWorkflow, platform);
  if (dirs.length) {
    let live: unknown;
    try {
      live = JSON.parse(fs.readFileSync(psGlobalConfigPath(i.agentDir), "utf8").replace(/^\uFEFF/, ""));
    } catch {
      return [];
    }
    const perm = isObj(live) ? live.permission : undefined;
    const read = isObj(perm) && isObj(perm.external_directory_read) ? perm.external_directory_read : {};
    // Both normalised spellings count: the resolved form (hubWorkflowDirs, `/a/./hub` -> `/a/hub`) and the typed one with only a trailing `/`
    // stripped (what permissions_gen.hub_read_patterns keeps when its pathlib form leaves a spelling as typed), so neither causes a false WARN.
    const slash = (s: string): string => s.split("\\").join("/");
    const has = (d: string): boolean => read[d] === "allow" && read[`${d}/*`] === "allow";
    const missing = new Set<string>();
    for (const v of typeof i.hubWorkflow === "string" ? [i.hubWorkflow] : Array.isArray(i.hubWorkflow) ? i.hubWorkflow : []) {
      const [d] = hubWorkflowDirs(v, platform);
      if (!d) continue;
      const resolved = slash(d);
      if (!has(resolved) && !has(`${slash(v as string).replace(/\/+$/, "")}/.workflow`)) missing.add(resolved);
    }
    if (!missing.size) return [];
    return [`WARN paths.hubWorkflow is set but the permission-system config ${psGlobalConfigPath(i.agentDir)} lacks the hub read keys for ${[...missing].join(", ")}: a ledger read there asks (external_directory catch-all) — fix: re-run foreman setup to re-render it (docs/permissions.md, Hub ledger read).`];
  }
  const x = platform === "win32" ? path.win32 : path.posix;
  const found = new Set<string>();
  for (const c of i.checkouts) {
    if (!x.isAbsolute(c)) continue;
    const dir = x.resolve(c);
    const home = x.basename(x.dirname(dir));
    const main = home.endsWith(".worktrees") && home !== ".worktrees" ? x.join(x.dirname(x.dirname(dir)), home.slice(0, -".worktrees".length)) : dir;
    const above = x.dirname(main);
    if (above === main) continue;
    try {
      if (fs.readdirSync(x.join(above, ".workflow")).some((f) => /^LEDGER-.*\.md$/.test(f))) found.add(above);
    } catch {
      // no ledger dir there
    }
  }
  return [...found].map((d) => `INFO ${x.join(d, ".workflow")} holds a ledger one level above the main checkout but paths.hubWorkflow is unset, so its ledger reads ask: if it is your hub, set paths.hubWorkflow to ${d} in your user foreman.json and re-run foreman setup (not set automatically).`);
}
