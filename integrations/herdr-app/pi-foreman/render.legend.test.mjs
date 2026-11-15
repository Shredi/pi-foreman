import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";

register("./stubs-hooks.mjs", import.meta.url);
const stubs = await import("./stubs.mjs");
const { default: Mod } = await import("./main.js");
const { ROWS } = await import("./sample.mjs");
const { world } = stubs;

// The keys of the legend table in docs/herdr.md: the first column of the table under "Legend of the sidebar markers".
const DOC = readFileSync(new URL("../../../docs/herdr.md", import.meta.url), "utf8");
const section = DOC.slice(DOC.indexOf("### Legend of the sidebar markers"));
const keys = section.slice(0, section.indexOf("\n### ", 4)).split("\n").map((l) => /^\| `([a-z-]+)` \|/.exec(l)?.[1]).filter(Boolean);

let spawned = 0;
const cx = { timer: { every() {} }, spawn() { spawned++; }, notify() {} };

function view(sample) {
  world.props = sample ? { sample: true } : undefined;
  world.execCalls = [];
  world.agentOrder = [];
  spawned = 0;
  const mod = Object.create(Mod.prototype);
  mod.init({}, cx);
  return mod;
}

// Every element with the chain of its ancestors, to climb from a label to its row.
const walk = (el, up = [], out = []) => {
  if (!el || typeof el !== "object") return out;
  out.push({ el, up });
  const next = [...up, el];
  el.kids?.forEach((k) => walk(k, next, out));
  if (el.contentEl) walk(el.contentEl, next, out);
  if (el.props?.trigger) walk(el.props.trigger, next, out);
  return out;
};
const els = (root) => walk(root).map((x) => x.el);
const hasText = (el, text) => (el.kids ?? []).includes(text);

// The header row of an agent or session whose name reads `label`, and the mark at its right end.
function rowOf(root, label) {
  const hit = walk(root).find((x) => hasText(x.el, label));
  assert.ok(hit, `${label} is drawn`);
  const row = [...hit.up, hit.el].reverse().find((e) => /^(row|agent):/.test(String(e.props.id ?? "")));
  assert.ok(row, `${label} has a row`);
  return { row, name: hit.el, mark: row.kids[row.kids.length - 1] };
}

// What a status mark is, from the stubs' recording of the glyph calls.
function markOf(el) {
  if (el.kind === "svg" && el.props.spin !== undefined) return { shape: "spinner", tone: el.props.text_color };
  if (hasText(els(el).find((e) => hasText(e, "Needs you")) ?? {}, "Needs you")) return { shape: "pill", tone: el.props.text_color };
  if (el.props.size === 7) return { shape: "square", tone: el.props.bg };
  if (el.props.size === 8) return el.props.border ? { shape: "ring", tone: el.props.border_color } : { shape: "dot", tone: el.props.bg };
  return { shape: "other" };
}

// The chip of PR `n` and its disc.
function chipOf(root, n) {
  const chip = els(root).filter((e) => e.kind === "HoverCard").find((c) => els(c.props.trigger).some((e) => hasText(e, `⎇ #${n}`)));
  assert.ok(chip, `#${n} is drawn`);
  const parts = els(chip.props.trigger);
  return { disc: parts.find((e) => e.props.size === 6), parts };
}

test("the docs table and the sample list the same keys", () => {
  assert.ok(keys.length >= 17, `parsed ${keys.length} keys`);
  assert.deepEqual([...keys].sort(), ROWS.map((r) => r.key).sort());
  assert.equal(new Set(keys).size, keys.length, "no key twice");
});

test("the sample draws the marker of every agent and session key", () => {
  const root = view(true).render({});
  const by = Object.fromEntries(ROWS.filter((r) => r.label).map((r) => [r.key, rowOf(root, r.label)]));
  const mark = (k) => markOf(by[k].mark);
  assert.deepEqual(mark("agent-working"), { shape: "spinner", tone: "#working" });
  assert.equal(mark("agent-needs-you").shape, "pill");
  assert.deepEqual(mark("agent-own-agents"), { shape: "spinner", tone: "#working" });
  assert.deepEqual(mark("agent-done"), { shape: "dot", tone: "#done" });
  assert.deepEqual(mark("agent-background"), { shape: "square", tone: "#working" });
  assert.deepEqual(mark("agent-waiting"), { shape: "ring", tone: "#muted" });
  assert.deepEqual(mark("agent-idle"), { shape: "ring", tone: "#idle" });
  assert.deepEqual(mark("session-ended"), { shape: "ring", tone: "#idle" });
  assert.equal(by["session-ended"].name.props.text_color, "#dim", "the ended name is dimmed");
  assert.equal(by["session-remote"].mark.kind, "svg", "the remote session shows its own status mark");
  assert.ok(els(by["session-remote"].row).some((e) => hasText(e, "box1")), "machine tag");
  assert.ok(els(root).some((e) => hasText(e, "⚙ npm test · 1m")), "background line");
  assert.ok(els(root).some((e) => hasText(e, "⏳ 1 pr watch · 1m")), "wait line");
});

test("the sample draws the marker of every PR key; the pulsing discs loop, the check mark does not", () => {
  const root = view(true).render({});
  const pr = Object.fromEntries(ROWS.filter((r) => r.pr).map((r) => [r.key, chipOf(root, r.pr)]));
  const look = (k) => [pr[k].disc.props.bg, pr[k].disc.props.loop !== undefined];
  assert.deepEqual(look("pr-draft"), ["#ansi5", false]);
  assert.deepEqual(look("pr-draft-running"), ["#ansi5", true]);
  assert.deepEqual(look("pr-running"), ["#ansi3", true]);
  assert.deepEqual(look("pr-failed"), ["#blocked", false]);
  assert.deepEqual(look("pr-not-reviewed"), ["#ansi4", false]);
  assert.deepEqual(look("pr-ci-passing"), ["#ansi2", false]);
  assert.equal(pr["pr-ready"].disc, undefined, "ready draws no disc");
  assert.equal(pr["pr-ready"].parts.find((e) => hasText(e, "✓")).props.text_color, "#ansi2", "ready: green check mark");
  assert.deepEqual(look("pr-conflict")[1], false);
  assert.deepEqual(look("pr-no-checks"), ["#dim", false]);
  assert.deepEqual(look("pr-draft-failed"), ["#blocked", false]);
  assert.deepEqual(look("pr-merge-blocked"), ["#ansi3", false]);
  assert.equal(pr["pr-draft-failed"].parts[0].props.border_color, "#blocked");
  assert.ok(pr["pr-not-reviewed"].parts.some((e) => hasText(e, "unreviewed head")));
  assert.ok(pr["pr-conflict"].parts.some((e) => hasText(e, "!")));
  assert.equal(pr["pr-failed"].parts[0].props.border_color, "#blocked");
  // the two pulsing PR discs, and the two of the sample's "Owner's choice" section (amber and green pulse)
  assert.equal(els(root).filter((e) => e.props?.loop !== undefined).length, 4);
  assert.equal(els(root).filter((e) => e.props?.loop !== undefined && e.props.bg === "#ansi2").length, 1, "only the choice's green pulse is green");
  for (const k of Object.keys(pr)) assert.equal(pr[k].parts.filter((e) => e.kind === "svg").length, 0, `${k}: no spinner in a chip`);
});

test("the sample's Owner's choice draws the amber and the green pulse, and no check mark", () => {
  const root = view(true).render({});
  assert.ok(els(root).some((e) => hasText(e, "Owner's choice: checks running, none failed")), "the section is drawn");
  // the label's row holds the dot's box, and the box the disc
  const disc = (label) => els(root).find((e) => hasText(e, label)).kids[0].kids[0];
  assert.deepEqual([disc("amber pulse (today)").props.bg, disc("green pulse").props.bg], ["#ansi3", "#ansi2"]);
  assert.ok(disc("amber pulse (today)").props.loop && disc("green pulse").props.loop, "both pulse");
  assert.equal(els(root).filter((e) => hasText(e, "✓")).length, 1, "only the ready PR has a check mark");
});

test("the sample starts no exec and no task, and leaves the Agents order alone", async () => {
  const mod = view(true);
  mod.render({});
  mod.poll(cx);
  mod.pollPrs(cx, Date.now());
  assert.deepEqual(await mod.execT("foreman", ["radar", "--json"], {}, 1000), { code: 1, stdout: "" });
  assert.equal(world.execCalls.length, 0);
  assert.equal(spawned, 0);
  assert.deepEqual(world.agentOrder, [], "no order call");
});

test("without the prop the host lists are drawn as before", () => {
  world.agents = [{ address: "t1", pane: "p1", space: 1, space_name: "mine", tab_name: "my agent", status: "idle", program: { name: "pi" } }];
  world.terminals = [];
  world.spaces = [];
  const mod = view(false);
  assert.ok(spawned > 0, "the poll starts its tasks");
  assert.equal(mod.sample, false);
  assert.equal(mod.radar.size, 0, "the radar starts empty");
  const root = mod.render({});
  assert.deepEqual(world.agentOrder, [["t1"]], "the Agents order is set to the listed agents");
  assert.ok(els(root).some((e) => hasText(e, "my agent")));
  assert.ok(!els(root).some((e) => hasText(e, "sample working")));
});
