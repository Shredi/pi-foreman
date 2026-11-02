import { Key, matchesKey, type Component } from "@earendil-works/pi-tui";
import type { ModelChoice, ModelRow } from "../../plan-types.ts";
import { bold, dim, fit, inverse, yellow } from "../style.ts";
import type { ScreenFactory } from "./types.ts";

const LABEL_WIDTH = 22;

const cellText = (c: ModelChoice | undefined): string => (c ? (c.thinking ? `${c.model} (${c.thinking})` : c.model) : "–");

export const createModels: ScreenFactory = (fixture, ctx): Component => {
  const grid = fixture.modelGrid;
  let row = 0;
  let col = 0;

  /** "foreman idle", "explorer strong"; a lone "model" rung is "default" when the role also has other rungs. */
  const label = (r: ModelRow): string => {
    if (r.rung !== "model") return `${r.role} ${r.rung}`;
    return grid.rows.some((o) => o.role === r.role && o.rung !== "model") ? `${r.role} default` : r.role;
  };

  return {
    invalidate() {},
    render(width: number): string[] {
      const n = grid.providers.length;
      const cw = Math.max(6, Math.floor((width - 2 - LABEL_WIDTH - 2 * n) / n));
      const pad = " ".repeat(2 + LABEL_WIDTH);
      const head = bold(pad + grid.providers.map((p) => fit(p, cw)).join("  "));
      const rule = dim(pad + grid.providers.map(() => "─".repeat(cw)).join("  "));
      const reviewer = `Effective reviewer: ${grid.effectiveReviewer.map((e) => `${e.rung} -> ${e.model}`).join(", ")}`;
      const tail = [reviewer, ...grid.warnings.map((w) => yellow(`! ${w}`))];
      const room = Math.max(1, ctx.rows() - 2 - tail.length - 2); // head and rule, blank, footer
      const top = Math.min(Math.max(0, row - room + 1), Math.max(0, grid.rows.length - room));
      const body = grid.rows.slice(top, top + room).map((r, i) => {
        const cells = grid.providers.map((p, j) => {
          const text = fit(cellText(r.values[p]), cw);
          return top + i === row && j === col ? inverse(text) : text;
        });
        return `${top + i === row ? "> " : "  "}${fit(label(r), LABEL_WIDTH)}${cells.join("  ")}`;
      });
      return [head, rule, ...body, "", ...tail, dim("p load preset, Enter edit cell, d show foreman.json diff")];
    },
    handleInput(data: string): void {
      if (matchesKey(data, Key.down)) row = Math.min(grid.rows.length - 1, row + 1);
      else if (matchesKey(data, Key.up)) row = Math.max(0, row - 1);
      else if (matchesKey(data, Key.right)) col = Math.min(grid.providers.length - 1, col + 1);
      else if (matchesKey(data, Key.left)) col = Math.max(0, col - 1);
    },
  };
};
