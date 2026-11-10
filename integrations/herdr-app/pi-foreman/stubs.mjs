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

export const EditorState = { new: (options) => ({ options }) };
export const Editor = { new: (state) => { const e = element("Editor"); e.state = state; return e; } };
export const TextView = { markdown: (id, text) => { const e = element("TextView"); e.mdId = id; e.md = text; return e; } };

// `files`: path -> text for readTextFile; `shared`: the shared store; `focus` / `panes`: what focused() and panes() answer.
export const world = { agents: [], terminals: [], execCalls: [], files: new Map(), writes: [], shared: {}, focus: null, panes: [], reads: [], runCalls: [], spaces: [] };
const palette = new Proxy({}, { get: (_t, k) => (typeof k === "string" ? `#${k}` : undefined) });
export const agents = () => world.agents;
export const terminals = () => world.terminals;
export const focused = () => world.focus;
export const panes = () => world.panes;
export const shared = (key) => world.shared[key];
export const setShared = (key, value) => { world.shared[key] = value; return null; };
export const readTextFile = async (path, options) => { world.reads.push([path, options?.on ?? null]); return world.files.get(path) ?? null; };
export const writeTextFile = async (path, text) => { world.writes.push([path, text]); world.files.set(path, text); return null; };
export const watchFolder = () => new Promise(() => {});
export const spaces = () => world.spaces;
export const run = (...call) => { world.runCalls.push(call); return null; };
export const theme = () => palette;
export const setAgentOrder = () => {};
// `world.execFn`, when set, answers an exec call (it may throw or return a rejecting promise); default: exit code 1.
export const exec = async (...call) => { world.execCalls.push(call); return world.execFn ? world.execFn(...call) : { code: 1, stdout: "" }; };
export const props = () => ({});
export const appHome = () => "/app";
export const settings = () => ({ font_family: "Mono" });
export const layout = () => world.layout ?? null;
export const notify = (n) => { (world.notices ??= []).push(n); return "n1"; };
// `world.platform` ("macos" | "linux" | "windows") is what window() reports; unset, window() throws like a host without it.
export const window = () => { if (!world.platform) throw new Error("no window"); return { platform: world.platform }; };
