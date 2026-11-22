// The plan's summary section read once for the readers that cannot import ownertext.ts (it imports checkpoint.ts): the fence mask, the owner section of
// plan-body lines and its `**Goal:**` paragraph. Headings are read with pages.ts `headingOf`, the reader of the plan page.
import { headingOf, scanFence } from "./pages.ts";

/** The lines without their indent, so a fence nested in a list item (4+ spaces or a tab, which `blocks` in pages.ts renders) is found by the same scanner. */
export const flat = (lines: readonly string[]): string[] => lines.map((l) => l.trimStart());

/** Per line: whether it belongs to a fenced block, nested ones included (its opening and closing lines included). */
export function fencedMask(lines: readonly string[]): boolean[] {
  const mask: boolean[] = Array.from<boolean>({ length: lines.length }).fill(false);
  const flatLines = flat(lines);
  for (let i = 0; i < lines.length; i++) {
    const f = scanFence(flatLines, i);
    if (!f) continue;
    mask.fill(true, i, f.next);
    i = f.next - 1;
  }
  return mask;
}

/** The heading of a column-0 ATX line (closing `#` run dropped), as the plan page reads it, or null. */
export function topHeading(line: string): { level: number; text: string } | null {
  return line.startsWith("#") ? headingOf(line) : null;
}

export interface OwnerSection {
  /** The body lines, without leading and trailing blank lines. */
  lines: string[];
  /** Whether it is the first `##` section of the plan body. */
  first: boolean;
}

const OWNER_NAMES = ["summary", "for the owner"];

/** The first `Summary` or `For the owner` level-2 section of plan-body lines, or null: a later heading of either name is an ordinary section; the section ends at the next level-1 or level-2 heading (fences skipped). */
export function ownerSectionOf(all: readonly string[]): OwnerSection | null {
  const fenced = fencedMask(all);
  let at = -1;
  let firstLevel2 = -1;
  for (let i = 0; i < all.length; i++) {
    if (fenced[i]) continue;
    const h = topHeading(all[i]);
    if (h?.level !== 2) continue;
    if (firstLevel2 < 0) firstLevel2 = i;
    if (OWNER_NAMES.includes(h.text.toLowerCase())) {
      at = i;
      break;
    }
  }
  if (at < 0) return null;
  const lines: string[] = [];
  for (let i = at + 1; i < all.length; i++) {
    if (!fenced[i] && (topHeading(all[i])?.level ?? 9) <= 2) break;
    lines.push(all[i]);
  }
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return { lines, first: at === firstLevel2 };
}

const GOAL_MARK = /^ {0,3}\*\*Goal:\*\*[ \t]*/i;
const BLOCK_START = /^ {0,3}(?:>|[-*+][ \t]|\d{1,9}[.)][ \t]|(?:`{3,}|~{3,}))/;

/** The `**Goal:**` paragraph that opens a summary section (text after the marker and the lines that follow up to a blank line or block start, at most 4), or null when the first block is not one. */
export function goalParagraph(sectionLines: readonly string[]): string[] | null {
  const first = sectionLines.findIndex((l) => l.trim());
  if (first < 0 || !GOAL_MARK.test(sectionLines[first])) return null;
  const out: string[] = [];
  const head = sectionLines[first].replace(GOAL_MARK, "").trim();
  if (head) out.push(head);
  for (const l of sectionLines.slice(first + 1)) {
    if (!l.trim() || BLOCK_START.test(l) || topHeading(l)) break;
    out.push(l.trim());
    if (out.length === 4) break;
  }
  return out;
}
