// State glyphs (config/symbols.json, switch `ui.symbols`: "unicode" | "nerd"; unknown -> unicode) and a
// terminal cell-width helper for the glyphs that take two cells.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type SymbolKey = "working" | "waiting" | "asking" | "blocked" | "done" | "lost";
export type SymbolSet = Record<SymbolKey, string>;

const FALLBACK: Record<"unicode" | "nerd", SymbolSet> = {
  unicode: { working: "⏳", waiting: "⏸", asking: "?", blocked: "✋", done: "✓", lost: "✗" },
  nerd: { working: "", waiting: "", asking: "", blocked: "", done: "", lost: "" },
};

const FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "config", "symbols.json");
let cache: Record<string, Partial<SymbolSet>> | null = null;

function table(): Record<string, Partial<SymbolSet>> {
  if (cache) return cache;
  try {
    const data = JSON.parse(fs.readFileSync(FILE, "utf8"));
    if (data && typeof data === "object") return (cache = data);
  } catch {
    // inline fallback
  }
  return (cache = FALLBACK);
}

/** The glyph set for a `ui.symbols` value; a missing glyph falls back to the built-in one. */
export function symbolSet(name: unknown): SymbolSet {
  const which = name === "nerd" ? "nerd" : "unicode";
  return { ...FALLBACK[which], ...(table()[which] ?? {}) };
}

/** Run state (childwidget RunState) -> symbol key. */
export const runSymbol = (state: "working" | "ask" | "done"): SymbolKey => (state === "ask" ? "asking" : state);

// East Asian Wide/Fullwidth (and emoji-presentation) ranges, enough for the glyphs above and CJK text.
const WIDE: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], [0x231a, 0x231b], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3], [0x25fd, 0x25fe],
  [0x2614, 0x2615], [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1], [0x26aa, 0x26ab],
  [0x26bd, 0x26be], [0x26c4, 0x26c5], [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea], [0x26f2, 0x26f3],
  [0x26f5, 0x26f5], [0x26fa, 0x26fa], [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b], [0x2728, 0x2728],
  [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797], [0x27b0, 0x27b0],
  [0x27bf, 0x27bf], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55], [0x2e80, 0xa4cf], [0xac00, 0xd7a3],
  [0xf900, 0xfaff], [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x1f300, 0x1f64f], [0x1f900, 0x1f9ff],
  [0x20000, 0x3fffd],
];

/** Terminal cells of one code point: 2 for East Asian wide/fullwidth, else 1. */
export function cellWidth(cp: number): number {
  for (const [lo, hi] of WIDE) if (cp >= lo && cp <= hi) return 2;
  return 1;
}
