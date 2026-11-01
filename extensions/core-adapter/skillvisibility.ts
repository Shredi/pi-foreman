// Skill visibility (token diet): rarely used skills leave the default skill list and are found through `tool_search`.
// Three inputs, in precedence: config `skills.visible` (globs; when non-empty everything else is searchable), config `skills.hidden`
// (globs), then the skill's own frontmatter `metadata.visibility: search` (anything else or absent = always on). Pure functions plus
// one frontmatter reader; no YAML library (top-level keys and one nested `metadata:` map are enough).
import * as fs from "node:fs";
import { matchesPattern } from "./deferred.ts";

/** Session section name of the hint. */
export const SKILLS_SECTION = "pi-foreman-skills";

export interface SkillRef {
  name: string;
  description: string;
  filePath: string;
}

export interface SkillRules {
  visible: readonly string[];
  hidden: readonly string[];
}

export interface Frontmatter {
  name?: string;
  description?: string;
  /** Top-level keys that hold a nested map (only `metadata` is read), each as key to string value. */
  metadata: Record<string, string>;
}

const unquote = (v: string): string => {
  const t = v.trim();
  return t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) ? t.slice(1, -1) : t;
};

/** The frontmatter of a SKILL.md text: `name`, `description` and the `metadata:` map. A text without frontmatter gives an empty result. */
export function parseFrontmatter(text: string): Frontmatter {
  const out: Frontmatter = { metadata: {} };
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return out;
  let block: string | null = null;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "---") break;
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const nested = /^\s+/.test(line);
    const m = /^\s*([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, key, raw] = m;
    if (nested) {
      if (block === "metadata") out.metadata[key] = unquote(raw);
      continue;
    }
    block = raw.trim() === "" ? key : null;
    if (key === "name") out.name = unquote(raw);
    else if (key === "description") out.description = unquote(raw);
  }
  return out;
}

/** `metadata.visibility` of the skill file, `undefined` when unreadable or absent. */
export function readVisibility(filePath: string): string | undefined {
  try {
    return parseFrontmatter(fs.readFileSync(filePath, "utf8")).metadata.visibility;
  } catch {
    return undefined;
  }
}

/** Is the skill searchable (hidden from the default list)? `visibility` is the frontmatter value. */
export function isHiddenSkill(name: string, rules: SkillRules, visibility: string | undefined): boolean {
  if (rules.visible.length > 0) return !rules.visible.some((p) => matchesPattern(p, name));
  if (rules.hidden.some((p) => matchesPattern(p, name))) return true;
  return visibility?.trim().toLowerCase() === "search";
}

/** Split `skills` into the visible and hidden ones, in order. `visibilityOf` reads the frontmatter (called only when the config does not decide). */
export function splitSkills<T extends SkillRef>(skills: readonly T[], rules: SkillRules, visibilityOf: (s: T) => string | undefined = (s) => readVisibility(s.filePath)): { visible: T[]; hidden: T[] } {
  const visible: T[] = [];
  const hidden: T[] = [];
  for (const s of skills) {
    const byConfig = rules.visible.length > 0 || rules.hidden.some((p) => matchesPattern(p, s.name));
    (isHiddenSkill(s.name, rules, byConfig ? undefined : visibilityOf(s)) ? hidden : visible).push(s);
  }
  return { visible, hidden };
}

/** The system-prompt hint: names only. */
export function skillsHint(hidden: readonly { name: string }[]): string {
  return `Searchable skills, find one with \`tool_search <words>\` and read its file: ${hidden.map((s) => s.name).join(", ")}`;
}

/** `skills.visible` / `skills.hidden` of a config as string lists. */
export function skillRulesOf(config: unknown): SkillRules {
  const skills = config && typeof config === "object" ? (config as { skills?: unknown }).skills : undefined;
  const list = (key: string): string[] => {
    const v = skills && typeof skills === "object" ? (skills as Record<string, unknown>)[key] : undefined;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  };
  return { visible: list("visible"), hidden: list("hidden") };
}
