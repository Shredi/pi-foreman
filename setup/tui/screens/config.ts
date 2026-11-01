import { Key, matchesKey, type Component } from "@earendil-works/pi-tui";
import { bold, dim, fit, yellow } from "../style.ts";
import { renderDiffLines } from "../widgets/difflines.ts";
import type { ScreenFactory } from "./types.ts";

const WIDE = 100;
const LEFT_WIDTH = 34;
const SEP = dim(" │ ");

export const createConfig: ScreenFactory = (fixture, ctx): Component => {
  const targets = fixture.configTargets;
  let selected = 0;
  let offset = 0;

  const listLines = (width: number): string[] =>
    targets.map((t, i) => {
      const changed = t.diff.length > 0;
      const mark = i === selected ? "> " : "  ";
      return fit(`${mark}${changed ? yellow("●") : dim("○")} ${t.title}  ${dim(changed ? "changed" : "unchanged")}`, width);
    });

  const detail = (width: number, height: number): string[] => {
    const t = targets[selected];
    const body = t.diff;
    const room = Math.max(1, height - 2);
    const start = Math.min(offset, Math.max(0, body.length - room));
    const lines = [bold(fit(t.path, width)), ...(body.length ? renderDiffLines(body, width, start, room) : [dim("no changes")])];
    if (body.length > room) lines.push(dim(`lines ${start + 1}-${Math.min(body.length, start + room)} of ${body.length}, PgUp/PgDn scroll`));
    return lines;
  };

  return {
    invalidate() {},
    render(width: number): string[] {
      const rows = ctx.rows();
      if (width >= WIDE) {
        const left = listLines(LEFT_WIDTH);
        const right = detail(width - LEFT_WIDTH - 3, rows);
        return Array.from({ length: Math.max(left.length, right.length) }, (_, i) => fit(left[i] ?? "", LEFT_WIDTH) + SEP + (right[i] ?? ""));
      }
      const top = listLines(width);
      return [...top, dim("─".repeat(width)), ...detail(width, rows - top.length - 1)];
    },
    handleInput(data: string): void {
      const move = (to: number) => {
        selected = Math.min(targets.length - 1, Math.max(0, to));
        offset = 0;
      };
      if (matchesKey(data, Key.down)) move(selected + 1);
      else if (matchesKey(data, Key.up)) move(selected - 1);
      else if (matchesKey(data, Key.pageDown)) offset += 5;
      else if (matchesKey(data, Key.pageUp)) offset = Math.max(0, offset - 5);
    },
  };
};
