import { truncateToWidth } from "@earendil-works/pi-tui";
import { cyan, dim, green, red } from "../style.ts";

/** Colour one unified-diff line: `+` green, `-` red, `@@` cyan, file headers dim. */
export function colorDiffLine(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---")) return dim(line);
  if (line.startsWith("@@")) return cyan(line);
  if (line.startsWith("+")) return green(line);
  if (line.startsWith("-")) return red(line);
  return line;
}

/** Render `diff` as at most `height` coloured lines starting at `offset`, each cut to `width`. */
export function renderDiffLines(diff: string[], width: number, offset = 0, height = diff.length): string[] {
  return diff.slice(offset, offset + height).map((l) => truncateToWidth(colorDiffLine(l), width, "…"));
}
