import { Key, matchesKey, type Component } from "@earendil-works/pi-tui";
import type { Component as Comp } from "../../plan-types.ts";
import { dim } from "../style.ts";
import { renderTable, type Column } from "../widgets/table.ts";
import type { ScreenFactory } from "./types.ts";

const dash = (v: string | undefined): string => v ?? "–";

/** Compare dotted numeric versions: negative, 0 or positive. */
function cmp(a: string, b: string): number {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d;
  }
  return 0;
}

/** True when `v` lies above the pin: an exact pin ("0.17.0") or a range ("1.4.x"). */
function beyondPin(v: string, pin: string): boolean {
  return pin.endsWith(".x") ? !v.startsWith(pin.slice(0, -1)) : cmp(v, pin) > 0;
}

export function updateStatus(c: Comp): string {
  if (!c.installed) return "not installed";
  if (!c.available) return "unknown";
  if (c.pin && beyondPin(c.installed, c.pin)) return "ahead, left alone";
  if (c.pin && beyondPin(c.available, c.pin)) return "pinned, newer exists";
  return cmp(c.installed, c.available) < 0 ? "update available" : "up to date";
}

export const createUpdates: ScreenFactory = (fixture, ctx): Component => {
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
        { title: "Status", width: 20 },
      ];
      const rows = comps.map((c) => [c.name, dash(c.installed), dash(c.available), dash(c.pin), ...(wide ? [c.source] : []), c.managed ? "yes" : "no", updateStatus(c)]);
      const room = Math.max(1, ctx.rows() - 4); // header row, blank, note, footer
      const top = Math.min(Math.max(0, selected - room + 1), Math.max(0, rows.length - room));
      const table = renderTable(columns, rows.slice(top, top + room), width, selected - top);
      const sel = comps[selected];
      const note = sel.managed ? sel.note : "update with the tool's own updater";
      return [...table, "", dim(note ? `${sel.name}: ${note}` : ""), dim("u update selected, U update all (within pins), r refresh")];
    },
    handleInput(data: string): void {
      if (matchesKey(data, Key.down)) selected = Math.min(comps.length - 1, selected + 1);
      else if (matchesKey(data, Key.up)) selected = Math.max(0, selected - 1);
    },
  };
};
