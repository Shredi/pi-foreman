import { Key, matchesKey, type Component } from "@earendil-works/pi-tui";
import { bold, dim, fit } from "../style.ts";
import { ProgressList } from "../widgets/progress.ts";
import type { ScreenFactory } from "./types.ts";

export const createApply: ScreenFactory = (fixture, ctx): Component & { dispose(): void } => {
  const { steps, log } = fixture.apply;
  const progress = new ProgressList(steps, ctx.ui);
  let offset = 0;

  return {
    invalidate() {},
    dispose: () => progress.dispose(),
    render(width: number): string[] {
      const done = steps.filter((s) => s.status === "done").length;
      const list = progress.render(width);
      const room = Math.max(1, ctx.rows() - list.length - 5); // blank, summary, log title, footer, scroll hint
      const start = Math.min(offset, Math.max(0, log.length - room));
      const lines = log.slice(start, start + room).map((l) => dim(fit(l, width)));
      const hint = log.length > room ? [dim(`log lines ${start + 1}-${Math.min(log.length, start + room)} of ${log.length}, PgUp/PgDn scroll`)] : [];
      return [...list, "", bold(`${done} of ${steps.length} steps done`), dim("Log"), ...lines, ...hint, dim("Esc back")];
    },
    handleInput(data: string): void {
      if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.down)) offset += 1;
      else if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.up)) offset = Math.max(0, offset - 1);
    },
  };
};
