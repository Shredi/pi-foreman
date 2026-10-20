// The skill paths a child's role names (roles.<role>.skills), resolved the way pi-subagents resolves them, as realpaths.
// permoverlay.ts (MatchCtx.skillDirs) lets a read-only shell word below one of them skip the childDeny `.agents` rules.
// Fail-closed: any error gives an empty list.
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

/** Same rule as the schema's roles.<id>.skills items: one plain path segment. */
const NAME = /^(?!\.\.?$)[^/\\:*?[\]{}]+$/;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** The skill names of a role (`config.roles.<role>.skills`) that are one plain path segment. */
export function roleSkillNames(configRoles: unknown, role: string | null | undefined): string[] {
  if (!role || !isObj(configRoles)) return [];
  const r = configRoles[role];
  const list = isObj(r) && Array.isArray(r.skills) ? r.skills : [];
  return list.filter((x): x is string => typeof x === "string" && NAME.test(x));
}

type ResolveSkills = (names: string[], cwd: string) => { resolved: { path: string }[] };

/** pi-subagents' resolveSkills: the exports map hides the deep path, so import it by file URL from the package root. */
async function loadResolveSkills(): Promise<ResolveSkills> {
  const root = path.dirname(createRequire(import.meta.url).resolve("pi-subagents"));
  const mod = (await import(pathToFileURL(path.join(root, "src", "agents", "skills.js")).href)) as { resolveSkills: ResolveSkills };
  return mod.resolveSkills;
}

/** True when `dir` is `p` or an ancestor of it. */
const isAncestorOrSame = (dir: string, p: string): boolean => {
  const rel = path.relative(dir, p);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel));
};

/**
 * Realpaths of the skills the role names: a `SKILL.md` gives its parent dir, any other skill file gives that file only.
 * Home, a filesystem root and any ancestor of home are dropped.
 */
export async function childSkillDirs(configRoles: unknown, role: string | null | undefined, cwd: string, home: string, resolveSkills?: ResolveSkills): Promise<string[]> {
  try {
    const names = roleSkillNames(configRoles, role);
    if (!names.length) return [];
    const resolve = resolveSkills ?? (await loadResolveSkills());
    const homes = [home, fs.realpathSync(home)];
    const out = new Set<string>();
    for (const s of resolve(names, cwd).resolved) {
      const target = path.basename(s.path) === "SKILL.md" ? path.dirname(s.path) : s.path;
      const real = fs.realpathSync(target);
      if (path.parse(real).root === real || homes.some((h) => isAncestorOrSame(real, h))) continue;
      out.add(real);
    }
    return [...out];
  } catch {
    return [];
  }
}
