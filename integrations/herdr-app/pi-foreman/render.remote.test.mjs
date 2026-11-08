import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./stubs-hooks.mjs", import.meta.url);
const stubs = await import("./stubs.mjs");
const { default: Mod } = await import("./main.js");
const { attachName } = await import("./model.js");
const { sess, treeOf } = await import("./fixtures.mjs");

const walk = (el, out = []) => {
  if (!el || typeof el !== "object") return out;
  out.push(el);
  el.kids?.forEach((k) => walk(k, out));
  if (el.contentEl) walk(el.contentEl, out);
  return out;
};
const byId = (root, prefix) => walk(root).filter((e) => String(e.props.id ?? "").startsWith(prefix));
const texts = (el) => walk(el).flatMap((e) => (e.kids ?? []).filter((k) => typeof k === "string"));

const remoteKid = sess("r", "fix@m", { hcTerminal: "t7", machine: "m", state: "working", sym: "working" });
const radarRoot = () => treeOf(sess("f", "foreman-x", { pid: 7, hcTerminal: "t5" }, [remoteKid]));
const hcAttach = (address, target, over = {}) => ({ address, state: "live", argv: ["hc", "attach", target], ...over });

// Local agent t5 (space 1, joined to the radar root) plus `agents` / `terminals` on top; machine "m" has no radar of its own.
function render({ agents = [], terminals = [], spaces = [], noRemote = false }) {
  stubs.world.agents = [{ address: "t5", pane: "p1", space: 1, space_name: "s", status: "idle", program: { name: "pi" } }, ...agents];
  stubs.world.terminals = [{ address: "t5", state: "live", foreground: { pid: 7 } }, ...terminals];
  stubs.world.spaces = spaces;
  stubs.world.execCalls = [];
  stubs.world.runCalls = [];
  const mod = Object.create(Mod.prototype);
  mod.changed = {}; mod.feed = []; mod.folded = new Set();
  mod.radar = new Map([["local", { ok: true, tree: [noRemote ? treeOf(sess("f", "foreman-x", { pid: 7, hcTerminal: "t5" })) : radarRoot()], openPrs: [], tried: Date.now() }], ["m", { ok: false, tried: Date.now() }]]);
  mod.busy = new Map(); mod.recs = new Map(); mod.childPi = new Set(); mod.failed = new Set();
  mod.poll = () => {};
  return { mod, root: mod.render({}) };
}

function click(root) {
  const name = byId(root, "name:").find((e) => texts(e).includes("fix@m"));
  assert.ok(name, "the remote card's name element");
  assert.ok(typeof name.props.on_click === "function", "it is clickable");
  name.props.on_click({}, { spawn: (fn) => fn() });
  return new Promise((r) => setTimeout(r, 10));
}

test("a click on the remote card focuses an existing local attach terminal (pane agent: pane.focus)", async () => {
  const { root } = render({
    agents: [{ address: "t9", pane: "p9", space: 1, space_name: "s", status: "idle", program: { name: "hc" } }],
    terminals: [hcAttach("t9", "m/t7")],
  });
  await click(root);
  assert.deepEqual(stubs.world.runCalls, [["pane.focus", { pane: "p9" }]]);
  assert.equal(stubs.world.execCalls.length, 0);
});

test("a click focuses a pane-less attach terminal via terminal.peek", async () => {
  const { root } = render({ terminals: [hcAttach("t8", "m/t7")] });
  await click(root);
  assert.deepEqual(stubs.world.runCalls, [["terminal.peek", { terminal: "t8" }]]);
  assert.equal(stubs.world.execCalls.length, 0);
});

test("a click without an attach terminal runs exactly one hc run of the attach", async () => {
  const { root } = render({ terminals: [hcAttach("t8", "m/t9"), hcAttach("t6", "m/t7", { state: "gone" })] });
  await click(root);
  assert.deepEqual(stubs.world.runCalls, []);
  assert.equal(stubs.world.execCalls.length, 1);
  const [bin, argv] = stubs.world.execCalls[0];
  assert.equal(bin, "hc");
  assert.deepEqual(argv, ["run", "--json", "--bg", "--no-notify", "--rm", "--name", attachName("m", "r"), "--", "hc", "attach", "m/t7"]);
});

const mSpace = [{ id: 1, machine: null }, { id: 2, machine: "m" }];
const listed = (address) => ({ address, pane: "p2", space: 2, space_name: "mspace", status: "idle", program: { name: "hc" } });

test("a listed attach of a drawn remote session is no group of its own, and no foreman-radar hint", () => {
  const { root } = render({ agents: [listed("m/t9")], terminals: [hcAttach("m/t9", "m/t7")], spaces: mSpace });
  assert.equal(byId(root, "sp-2").length, 0, "no space header");
  assert.ok(!byId(root, "agent:m/t9").length, "no row of its own");
  assert.ok(!texts(root).some((x) => /No foreman radar on m/.test(x)));
  assert.ok(byId(root, "name:").some((e) => texts(e).includes("fix@m")), "the remote card still renders");
});

const plain = { address: "m/p1", pane: "p2", space: 2, space_name: "mspace", status: "idle", program: { name: "pi" } };

test("no radar record for m, but the local radar shows a session on m: the group header stays, no hint", () => {
  const { root } = render({ agents: [plain], spaces: mSpace });
  assert.equal(byId(root, "sp-2").length, 1, "its space header");
  assert.ok(!texts(root).some((x) => /No foreman radar on m/.test(x)));
});

test("control: no radar record for m and no session on m in the local radar: the hint is shown", () => {
  const { root } = render({ agents: [plain], spaces: mSpace, noRemote: true });
  assert.equal(byId(root, "sp-2").length, 1, "its space header");
  assert.ok(texts(root).some((x) => /No foreman radar on m \(set props\.foreman\)/.test(x)));
});

test("control: an attach of an unknown target keeps its group and row", () => {
  const { root } = render({ agents: [listed("m/t9")], terminals: [hcAttach("m/t9", "m/t99")], spaces: mSpace });
  assert.equal(byId(root, "sp-2").length, 1, "its space header");
  assert.ok(byId(root, "agent:m/t9").length > 0, "its row");
  assert.ok(byId(root, "name:").some((e) => texts(e).includes("fix@m")));
});
