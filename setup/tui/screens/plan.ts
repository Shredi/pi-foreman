import { Key, matchesKey, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import type { Step } from "../../plan-types.ts";
import { bold, dim, fit } from "../style.ts";
import { renderDiffLines } from "../widgets/difflines.ts";
import { statusGlyph, versionText } from "../widgets/progress.ts";
import type { ScreenFactory } from "./types.ts";

const WIDE = 100;
const LEFT_WIDTH = 42;
const SEP = dim(" │ ");

/** Body lines of the detail pane: the diffs of a write step, the permission summary, or the package facts. */
function detailBody(step: Step, width: number): string[] {
  if (step.writes?.length) {
    return step.writes.flatMap((w) => [bold(w.path), ...renderDiffLines(w.diff, width), ""]).slice(0, -1);
  }
  if (step.permission) {
    const p = step.permission;
    return [`Before: ${p.before}`, `After:  ${p.after}`, "", ...wrapTextWithAnsi(p.summary, width)];
  }
  const facts = [
    step.package && `Package: ${step.package}`,
    step.version && `Version: ${versionText(step)}`,
    step.source && `Source:  ${step.source}`,
    `Status:  ${step.status}`,
  ];
  return facts.filter((f): f is string => !!f);
}

export const createPlan: ScreenFactory = (fixture, ctx): Component => {
  const steps = fixture.steps;
  let selected = 0;
  let offset = 0;

  const stepLines = (width: number, wide: boolean): string[] =>
    steps.flatMap((s, i) => {
      const mark = i === selected ? "> " : "  ";
      const ver = versionText(s);
      if (!wide) return [fit(`${mark}${statusGlyph(s.status)} ${s.title}${ver ? `  ${ver}` : ""}${s.source ? `  ${dim(s.source)}` : ""}`, width)];
      const second = [ver, s.source && dim(s.source)].filter(Boolean).join("  ");
      return [fit(`${mark}${statusGlyph(s.status)} ${s.title}`, width), fit(`    ${second}`, width)];
    });

  const detail = (width: number, height: number): string[] => {
    const step = steps[selected];
    const body = detailBody(step, width);
    const room = Math.max(1, height - 2);
    const start = Math.min(offset, Math.max(0, body.length - room));
    const lines = [bold(fit(step.title, width)), ...body.slice(start, start + room)];
    if (body.length > room) lines.push(dim(`lines ${start + 1}-${Math.min(body.length, start + room)} of ${body.length}, PgUp/PgDn scroll`));
    return lines;
  };

  return {
    invalidate() {},
    render(width: number): string[] {
      const rows = ctx.rows();
      if (width >= WIDE) {
        const left = stepLines(LEFT_WIDTH, true);
        const right = detail(width - LEFT_WIDTH - 3, rows);
        return Array.from({ length: Math.max(left.length, right.length) }, (_, i) => fit(left[i] ?? "", LEFT_WIDTH) + SEP + (right[i] ?? ""));
      }
      const top = stepLines(width, false);
      return [...top, dim("─".repeat(width)), ...detail(width, rows - top.length - 1)];
    },
    handleInput(data: string): void {
      const move = (to: number) => {
        selected = Math.min(steps.length - 1, Math.max(0, to));
        offset = 0;
      };
      if (matchesKey(data, Key.down)) move(selected + 1);
      else if (matchesKey(data, Key.up)) move(selected - 1);
      else if (matchesKey(data, Key.pageDown)) offset += 5;
      else if (matchesKey(data, Key.pageUp)) offset = Math.max(0, offset - 5);
    },
  };
};
