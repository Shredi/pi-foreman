// Recording stand-ins for gpui-kit, gpui-base and herdr, so main.js can be rendered under node.
// An element records its kind, every chained call as a prop, and its children; `when` applies its callback when the flag holds.
class El {
  constructor(kind) { this.kind = kind; this.props = {}; this.kids = []; }
  when(flag, fn) { return flag ? fn(this) : this; }
  child(c) { if (c !== undefined && c !== null) this.kids.push(c); return this; }
  children(list) { for (const c of list ?? []) this.child(c); return this; }
  content(c) { this.contentEl = c; return this; }
}
const element = (kind) => new Proxy(new El(kind), {
  get(t, k, r) {
    if (k in t || typeof k === "symbol") return Reflect.get(t, k, r);
    return (...args) => { t.props[k] = args.length > 1 ? args : args[0] ?? true; return r; };
  },
});
export const make = (kind) => element(kind);

export class View {}
export const div = () => element("div");
export const svg = (src) => { const e = element("svg"); e.src = src; return e; };
export const image = (src) => { const e = element("image"); e.src = src; return e; };
export const h_flex = () => element("h_flex");
export const v_flex = () => element("v_flex");
export const Collapsible = { new: () => element("Collapsible") };
export const HoverCard = { new: (id) => { const e = element("HoverCard"); e.cardId = id; return e; } };

export const world = { agents: [], terminals: [] };
const palette = new Proxy({}, { get: (_t, k) => (typeof k === "string" ? `#${k}` : undefined) });
export const agents = () => world.agents;
export const terminals = () => world.terminals;
export const focused = () => null;
export const spaces = () => [];
export const run = () => {};
export const theme = () => palette;
export const setAgentOrder = () => {};
export const exec = async () => ({ code: 1, stdout: "" });
export const props = () => ({});
export const window = {};
