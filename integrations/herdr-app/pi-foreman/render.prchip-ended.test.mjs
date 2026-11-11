import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./stubs-hooks.mjs", import.meta.url);
const stubs = await import("./stubs.mjs");
const { default: Mod } = await import("./main.js");
const { parseRadarDoc, buildTree } = await import("./model.js");
const { sess } = await import("./fixtures.mjs");
const { world } = stubs;

const URL_ = "https://example.org/o/r/pull/7";
const feedPr = { repo: "o/r", number: 7, title: "Fix the thing", url: URL_, state: "open", checks: [], headRefName: "fix-thing", branch: "fix-thing" };
const dot = (over = {}) => ({ n: 7, state: "ok", label: "#7", src: "pr", ...over });
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };
const walk = (el, out = []) => {
  if (!el || typeof el !== "object") return out;
  out.push(el);
  el.kids?.forEach((k) => walk(k, out));
  if (el.contentEl) walk(el.contentEl, out);
  if (el.props?.trigger) walk(el.props.trigger, out);
  return out;
};
const chipOf = (out) => walk(out).filter((e) => e.kind === "HoverCard").find((c) => walk(c.props.trigger).some((e) => (e.kids ?? []).includes("⎇ #7")));

// A live top row (terminal t5) with one child of the given shape, as `foreman radar --json` would carry it.
const mount = (kid, kidKids, feed) => {
  const doc = parseRadarDoc(JSON.stringify({ v: 1, roots: [sess("f", "foreman-x", { hcTerminal: "t5" }, [sess("k", "kid", kid, kidKids)])], openPrs: feed, openPrsAt: new Date().toISOString() }));
  world.agents = [{ address: "t5", pane: "p1", space: 1, space_name: "s", status: "idle", focused: false, program: { name: "pi" } }];
  world.terminals = [{ address: "t5", state: "live", foreground: { pid: 7 } }];
  const m = Object.create(Mod.prototype);
  m.changed = {}; m.feed = []; m.folded = new Set(); m.busy = new Map(); m.recs = new Map(); m.childPi = new Set(); m.poll = () => {};
  m.radar = new Map([["local", { ok: true, tree: buildTree(doc.nodes), nodes: doc.nodes, openPrs: doc.openPrs, openPrsAt: doc.openPrsAt ?? null, tried: Date.now() }]]);
  return m;
};
const clickChip = async (m) => {
  world.execCalls = []; world.notices = []; world.platform = "macos"; world.execFn = () => ({ code: 0, stdout: "" });
  const chip = chipOf(m.render({}));
  assert.ok(chip, "the row draws the chip");
  assert.equal(typeof chip.props.trigger.props.on_click, "function", "the click is bound");
  const tasks = [];
  chip.props.trigger.props.on_click({}, { spawn: (f) => tasks.push(f), notify() {}, stop_propagation() {} });
  for (const t of tasks) await t();
  await settle();
  world.platform = undefined; world.execFn = undefined;
  assert.deepEqual(world.execCalls.map((c) => [c[0], c[1]]), [["open", [URL_]]]);
};

const base = { repo: "o/r", branch: "fix-thing", hcTerminal: "t9" };
const shapes = {
  "a done child": { ...base, state: "done", sym: "done", dots: [dot()] },
  "a lost child": { ...base, state: "lost", sym: "lost", dots: [dot()] },
  "a stale child": { ...base, state: "stale", sym: "waiting", dots: [dot()] },
  "a finished child": { ...base, state: "finished", sym: "done", dots: [dot()] },
  "a closed child": { ...base, state: "closed", sym: "done", dots: [dot()] },
  "a closed child with a PR known only through a wait": { ...base, state: "closed", sym: "done", branch: "other", waits: [{ kind: "pr", note: "pr", age_s: 1, prs: [7] }] },
  "a dot that carries its own url, the feed without the PR": { ...base, state: "closed", sym: "done", dots: [dot({ url: URL_ })] },
};

for (const [name, kid] of Object.entries(shapes)) {
  test(`the chip of ${name} opens the PR page`, async () => {
    const live = [sess("g", "grandkid", { hcTerminal: "t11", state: "working", sym: "working" })];
    // an ended child shows only while it has live children
    const ended = ["closed", "finished", "lost", "stale", "done"].includes(kid.state);
    const feed = name.includes("without the PR") ? [] : [feedPr];
    await clickChip(mount(kid, ended ? live : [], feed));
  });
}
