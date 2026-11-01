import { Key, matchesKey, type Component } from "@earendil-works/pi-tui";
import { bold, dim, fit } from "../style.ts";
import { renderDiffLines } from "../widgets/difflines.ts";
import type { ScreenFactory } from "./types.ts";

const editsPhrase = (mode: string): string => (mode === "ask" ? "edits ask" : mode === "deny" ? "edits are denied" : `edits use ${mode}`);

export const createWorkFolders: ScreenFactory = (fixture, ctx): Component => {
  const folders = fixture.workFolders;
  const target = fixture.configTargets.find((t) => t.id === "permissions-json");
  let selected = 0;

  return {
    invalidate() {},
    render(width: number): string[] {
      const list = folders.map((f, i) => fit(`${i === selected ? "> " : "  "}${f.path}  ${dim(`mode ${f.mode}`)}`, width));
      const plain = folders.map((f) => dim(`inside ${f.path} reads are allowed, ${editsPhrase(f.mode)}`));
      const head = [...list, "", ...plain, dim("Child sessions keep their own rules."), ""];
      const foot = dim("a add folder, m change mode, x remove");
      const room = Math.max(1, ctx.rows() - head.length - 2); // diff title, footer
      const diff = target?.diff.length ? renderDiffLines(target.diff, width, 0, room) : [dim("no changes")];
      return [...head, bold(target?.path ?? "permissions.json"), ...diff, foot];
    },
    handleInput(data: string): void {
      if (matchesKey(data, Key.down)) selected = Math.min(folders.length - 1, selected + 1);
      else if (matchesKey(data, Key.up)) selected = Math.max(0, selected - 1);
    },
  };
};
