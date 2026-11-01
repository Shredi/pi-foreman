import { bold, fit } from "../style.ts";

export interface Column {
  title: string;
  /** Fixed width in columns; omit for one flexible column that takes the rest. */
  width?: number;
  align?: "left" | "right";
}

const SEP = "  ";

/** Cell text for one column: right-aligned numbers pad on the left. */
function cell(text: string, width: number, align: "left" | "right" | undefined): string {
  const cut = fit(text, width);
  if (align !== "right") return cut;
  const t = cut.trimEnd();
  return " ".repeat(width - t.length) + t;
}

/** Header plus rows, each exactly `width` columns; the flexible column absorbs the remaining width. */
export function renderTable(columns: Column[], rows: string[][], width: number, selected = -1): string[] {
  const fixed = columns.reduce((n, c) => n + (c.width ?? 0), 0) + SEP.length * (columns.length - 1) + 2;
  const flex = Math.max(4, width - fixed);
  const widths = columns.map((c) => c.width ?? flex);
  const line = (cells: string[]) => cells.map((t, i) => cell(t, widths[i], columns[i].align)).join(SEP);
  const out = [bold(fit("  " + line(columns.map((c) => c.title)), width))];
  rows.forEach((r, i) => out.push(fit((i === selected ? "> " : "  ") + line(r), width)));
  return out;
}
