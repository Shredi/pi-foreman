import { matchesKey, Key, type Component } from "@earendil-works/pi-tui";
import type { Component as Comp } from "../../plan-types.ts";
import { bold, dim } from "../style.ts";
import { renderTable, type Column } from "../widgets/table.ts";
import type { ScreenFactory } from "./types.ts";

const dash = (v: string | undefined): string => v ?? "–";

/** "N up to date, M updates available, K not installed". */
export function statusLine(components: Comp[]): string {
  const missing = components.filter((c) => !c.installed).length;
  const updates = components.filter((c) => c.installed && c.available && c.installed !== c.available).length;
  const current = components.length - missing - updates;
  return `${current} up to date, ${updates} updates available, ${missing} not installed`;
}

export const createHome: ScreenFactory = (fixture, ctx): Component => {
  const comps = fixture.components;
  let selected = 0;
  return {
    invalidate() {},
    render(width: number): string[] {
      const wide = width >= 100;
      const columns: Column[] = [
        { title: "Name" },
        { title: "Installed", width: 9 },
        { title: "Available", width: 9 },
        { title: "Pin", width: 7 },
        ...(wide ? [{ title: "Source", width: 26 }] : []),
        { title: "Managed", width: 7 },
      ];
      const rows = comps.map((c) => [c.name, dash(c.installed), dash(c.available), dash(c.pin), ...(wide ? [c.source] : []), c.managed ? "yes" : "no"]);
      const room = Math.max(1, ctx.rows() - 4); // header row, blank, status line, selected note
      const top = Math.min(Math.max(0, selected - room + 1), Math.max(0, rows.length - room));
      const table = renderTable(columns, rows.slice(top, top + room), width, selected - top);
      const sel = comps[selected];
      return [...table, "", bold(statusLine(comps)), dim(sel.note ? `${sel.name}: ${sel.note}` : "")];
    },
    handleInput(data: string): void {
      if (matchesKey(data, Key.down)) selected = Math.min(comps.length - 1, selected + 1);
      else if (matchesKey(data, Key.up)) selected = Math.max(0, selected - 1);
    },
  };
};
