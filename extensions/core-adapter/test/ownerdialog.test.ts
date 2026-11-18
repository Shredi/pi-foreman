// The shared owner-dialog shape (ownerdialog.ts): rendering with and without colour and link support, cleaning, the link rule,
// and the select/confirm wrappers (custom in the TUI, the plain Pi calls elsewhere).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { cleanDialogText, dialogStyle, fileUrl, ownerDialog, shapedConfirm, shapedSelect } from "../ownerdialog.ts";
import type { DialogSpec, DialogStyle } from "../ownerdialog.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";
import { initTheme } from "@earendil-works/pi-coding-agent";

initTheme("dark");

const theme = { fg: (tok: string, s: string) => `<${tok}:${s}>`, underline: (s: string) => `_${s}_` };
const OSC8 = /\x1b\]8;;([^\x1b]*)\x1b\\/;
const ESC = /\x1b/;
const cp = (...c: number[]): string => String.fromCodePoint(...c);

function spec(over: Partial<DialogSpec> = {}): DialogSpec {
  return {
    ask: "Approve the plan for demo?",
    summary: "Builders start only after you approve.",
    facts: [["Plan", "Demo"], ["Version", "1a2b3c4d"]],
    links: [{ label: "Plan page", path: "/tmp/pages/demo/plan.html", text: "open the plan page", kind: "page" }],
    detail: ["a dim line"],
    answers: "revise: you say what to change   approve: builders start",
    ...over,
  };
}

test("ownerDialog: the question is the ask, the body has one token per part, the answers line is last", () => {
  const { ask, body } = ownerDialog(spec(), { theme, links: true });
  assert.equal(ask, "Approve the plan for demo?");
  const lines = body.split("\n");
  assert.equal(lines[0], "<text:Builders start only after you approve.>");
  assert.ok(lines.some((l) => l === "  <muted:Plan:   >  <text:Demo>"));
  assert.ok(lines.some((l) => l.startsWith("  <muted:Plan page:>  <mdLink:_")));
  assert.ok(lines.includes("  <dim:a dim line>"));
  assert.equal(lines.at(-1), `<warning:${cp(0x25b8)} revise: you say what to change   approve: builders start>`);
});

test("ownerDialog: links on put OSC 8 around the label text and show the url dim on its own line", () => {
  const { body } = ownerDialog(spec(), { theme, links: true }, false);
  const m = OSC8.exec(body);
  assert.ok(m, "an OSC 8 link");
  assert.equal(m[1], "file:///tmp/pages/demo/plan.html");
  assert.match(body, /\x1b\]8;;[^\x1b]*\x1b\\open the plan page\x1b\]8;;\x1b\\/);
  assert.ok(body.split("\n").includes("  <dim:file:///tmp/pages/demo/plan.html>"));
});

test("ownerDialog: links off draw no OSC 8 and still show the url line", () => {
  const { body } = ownerDialog(spec(), { theme, links: false }, false);
  assert.doesNotMatch(body, ESC);
  assert.doesNotMatch(body, /open the plan page/);
  assert.ok(body.includes("file:///tmp/pages/demo/plan.html"));
});

test("ownerDialog: no style draws plain text without any escape byte", () => {
  const { ask, body } = ownerDialog(spec(), null, false);
  assert.doesNotMatch(ask + body, ESC);
  assert.doesNotMatch(body, /<(text|muted|dim|warning|mdLink):/);
  assert.match(body, /Plan: +Demo/);
  assert.equal(body.split("\n").at(-1), `${String.fromCodePoint(0x25b8)} revise: you say what to change   approve: builders start`);
});

test("cleanDialogText: escape sequences, controls, bidi and format characters are removed; ordinary spacing stays", () => {
  const dirty = "a\x1b[31mred\x1b[0m\x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\\x07b\u0085c\u202ed\u2066e\u200ef\u200f\nrow\tend";
  const out = cleanDialogText(dirty);
  assert.doesNotMatch(out, ESC);
  assert.doesNotMatch(out, /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/);
  assert.equal(out.replace(/ +/g, " "), "aredlink b c d e f row end");
  assert.equal(cleanDialogText("one   two"), "one   two");
});

test("ownerDialog: every provided string is cleaned before styling", () => {
  const s = spec({ ask: "Q\x1b[1m?", summary: "S\x1b]8;;u\x07x", facts: [["L\x07", "V\x1b[2m"]], detail: ["D\u202e"], answers: "A\x1b[0m" });
  const { ask, body } = ownerDialog(s, { theme, links: true }, false);
  assert.doesNotMatch(ask, ESC);
  assert.equal(ask, "Q?");
  assert.ok(!body.replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, "").match(ESC));
});

test("fileUrl: spaces and non-ASCII are percent-encoded; a Windows path is a file URL on any runner", () => {
  assert.equal(fileUrl("/tmp/a b/é.md", false), "file:///tmp/a%20b/%C3%A9.md");
  assert.equal(fileUrl("C:\\x\\b.md", true), "file:///C:/x/b.md");
});

function briefDir(t: import("node:test").TestContext): string {
  const d = fs.realpathSync(mkTestTmp("pf-ownerdialog-"));
  t.after(() => rmTestTmp(d));
  return d;
}

const brief = (file: string, kind: "text" | "page" = "text"): DialogSpec => ({ ask: "Q?", links: [{ label: "Brief", path: file, text: "open the brief", kind }] });
const styled: DialogStyle = { theme, links: true };

test("link rule: a plan page links; a brief links only when its real path is .md or .txt", (t) => {
  const d = briefDir(t);
  for (const n of ["b.md", "b.txt"]) {
    fs.writeFileSync(path.join(d, n), "x");
    assert.match(ownerDialog(brief(path.join(d, n)), styled).body, OSC8, n);
  }
  for (const n of ["b.sh", "b.command", "b", "b.terminal"]) {
    fs.writeFileSync(path.join(d, n), "x");
    const body = ownerDialog(brief(path.join(d, n)), styled).body;
    assert.doesNotMatch(body, /\x1b\]8/, n);
    assert.ok(body.includes(path.join(d, n)), "the plain path is shown");
  }
  assert.match(ownerDialog(brief(path.join(d, "plan.html"), "page"), styled).body, OSC8);
});

test("link rule: a brief.md that is a symlink to a .command file is not linked", { skip: process.platform === "win32" }, (t) => {
  const d = briefDir(t);
  fs.writeFileSync(path.join(d, "run.command"), "#!/bin/sh\n");
  fs.symlinkSync(path.join(d, "run.command"), path.join(d, "brief.md"));
  const body = ownerDialog(brief(path.join(d, "brief.md")), styled).body;
  assert.doesNotMatch(body, /\x1b\]8/);
  assert.ok(body.includes(path.join(d, "brief.md")));
});

test("cleanDialogText: zero-width, Arabic letter mark, BOM and line/paragraph separators are removed", () => {
  const cps = [0x061c, 0x200b, 0x200c, 0x200d, 0xfeff, 0x2028, 0x2029];
  const out = cleanDialogText(cps.map((c, i) => `${String.fromCharCode(97 + i)}${String.fromCharCode(c)}`).join("") + "z");
  assert.equal(out.replace(/ +/g, " "), "a b c d e f g z");
  assert.ok(![...out].some((ch) => cps.includes(ch.charCodeAt(0))));
});

test("link rule: a text link through a symlink names the resolved real file in the url", { skip: process.platform === "win32" }, (t) => {
  const d = briefDir(t);
  fs.writeFileSync(path.join(d, "real.md"), "# x\n");
  fs.symlinkSync(path.join(d, "real.md"), path.join(d, "brief.md"));
  const body = ownerDialog(brief(path.join(d, "brief.md")), styled).body;
  const m = OSC8.exec(body);
  assert.ok(m);
  assert.ok(m[1].endsWith("/real.md"));
  assert.ok(!m[1].includes("brief.md"));
});

test("link rule: a missing brief file is not linked", (t) => {
  const d = briefDir(t);
  assert.doesNotMatch(ownerDialog(brief(path.join(d, "none.md")), styled).body, /\x1b\]8/);
});

type Call = { fn: string; args: unknown[] };
function fakeUi(over: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const ui: Record<string, unknown> = {
    theme,
    select: async (...args: unknown[]) => (calls.push({ fn: "select", args }), "revise"),
    confirm: async (...args: unknown[]) => (calls.push({ fn: "confirm", args }), true),
    custom: async (factory: (...a: unknown[]) => unknown, options: unknown) => {
      calls.push({ fn: "custom", args: [factory, options] });
      return undefined;
    },
    ...over,
  };
  return { ui: ui as never, calls };
}

test("dialogStyle: only the TUI with a theme and a custom function is styled; links follow the capability probe", () => {
  assert.equal(dialogStyle(fakeUi().ui, "rpc"), null);
  assert.equal(dialogStyle(fakeUi({ theme: undefined }).ui, "tui"), null);
  assert.equal(dialogStyle(fakeUi({ custom: undefined }).ui, "tui"), null);
  assert.deepEqual(dialogStyle(fakeUi().ui, "tui", () => false), { theme, links: false });
  assert.deepEqual(dialogStyle(fakeUi().ui, "tui", () => true), { theme, links: true });
  assert.equal(dialogStyle(fakeUi().ui, "tui", () => { throw new Error("probe"); })?.links, false);
});

test("shapedSelect: rpc and a tui without theme or custom call the plain select with question and plain body", async () => {
  for (const [mode, over] of [["rpc", {}], ["tui", { theme: undefined }], ["tui", { custom: undefined }]] as const) {
    const { ui, calls } = fakeUi(over);
    const answer = await shapedSelect(ui, mode, spec(), ["revise", "approve"]);
    assert.equal(answer, "revise");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].fn, "select");
    const title = String(calls[0].args[0]);
    assert.match(title, /^Approve the plan for demo\?\n\nBuilders start/);
    assert.doesNotMatch(title, ESC);
    assert.deepEqual(calls[0].args[1], ["revise", "approve"]);
    assert.equal(calls[0].args.length, 2, "no options object without a signal");
  }
  const sig = new AbortController().signal;
  const { ui, calls } = fakeUi();
  await shapedSelect(ui, "rpc", spec(), ["a"], { signal: sig });
  assert.deepEqual(calls[0].args[2], { signal: sig });
});

test("shapedSelect: the TUI goes through custom with the plain question as the blocked message", async () => {
  const { ui, calls } = fakeUi();
  const opts = ["revise", "reject", "approve"];
  const answer = await shapedSelect(ui, "tui", spec(), opts, { style: { theme, links: false } });
  assert.equal(answer, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].fn, "custom");
  assert.deepEqual((calls[0].args[1] as { blocked: unknown }).blocked, { kind: "question", message: "Approve the plan for demo?" });
});

test("shapedSelect and shapedConfirm: the real selector component gets the options in order, the body as description, and answers pass through", async () => {
  let comp: { handleInput(k: string): void; render(w: number): string[] } | undefined;
  const asked: unknown[] = [];
  const ui = fakeUi({
    custom: (factory: (...a: unknown[]) => never, options: unknown) =>
      new Promise((resolve) => {
        asked.push(options);
        comp = factory({ requestRender: () => undefined }, theme, {}, resolve) as never;
      }),
  }).ui;
  const style: DialogStyle = { theme, links: false };
  // down, down, enter on [revise, reject, approve] = approve
  const p = shapedSelect(ui, "tui", spec(), ["revise", "reject", "approve"], { style });
  const plain = comp!.render(100).join("\n");
  assert.match(plain, /Approve the plan for demo\?/);
  assert.match(plain, /Builders start only after you approve/);
  assert.ok(plain.indexOf("revise") < plain.indexOf("reject") && plain.indexOf("reject") < plain.lastIndexOf("approve"));
  comp!.handleInput("\x1b[B");
  comp!.handleInput("\x1b[B");
  comp!.handleInput("\r");
  assert.equal(await p, "approve");
  // confirm: enter on the preselected Yes is true; down, enter is No = false
  const yes = shapedConfirm(ui, "tui", spec(), { style });
  comp!.handleInput("\r");
  assert.equal(await yes, true);
  assert.deepEqual(asked.at(-1), { blocked: { kind: "permission", message: "Approve the plan for demo?" } });
  const no = shapedConfirm(ui, "tui", spec(), { style });
  comp!.handleInput("\x1b[B");
  comp!.handleInput("\r");
  assert.equal(await no, false);
  // cancel (escape) is not Yes
  const cancelled = shapedConfirm(ui, "tui", spec(), { style });
  comp!.handleInput("\x1b");
  assert.equal(await cancelled, false);
});

test("shapedSelect and shapedConfirm: an abort answers undefined / false, also when it came before the dialog", async () => {
  const ac = new AbortController();
  let done: ((v: unknown) => void) | undefined;
  const ui = fakeUi({
    custom: (factory: (...a: unknown[]) => never, _o: unknown) =>
      new Promise((resolve) => {
        done = resolve;
        factory({ requestRender: () => undefined }, theme, {}, resolve);
      }),
  }).ui;
  const style: DialogStyle = { theme, links: false };
  const p = shapedSelect(ui, "tui", spec(), ["a", "b"], { style, signal: ac.signal });
  ac.abort();
  assert.equal(await p, undefined);
  assert.ok(done);
  assert.equal(await shapedSelect(ui, "tui", spec(), ["a"], { style, signal: ac.signal }), undefined);
  assert.equal(await shapedConfirm(ui, "tui", spec(), { style, signal: ac.signal }), false);
});

test("shapedConfirm: plain mode calls confirm with the question and the plain body; only true counts", async () => {
  const { ui, calls } = fakeUi();
  assert.equal(await shapedConfirm(ui, "rpc", spec()), true);
  assert.equal(calls[0].fn, "confirm");
  assert.equal(calls[0].args[0], "Approve the plan for demo?");
  assert.doesNotMatch(String(calls[0].args[1]), ESC);
  assert.equal(calls[0].args.length, 2);
  const odd = fakeUi({ confirm: async () => 1 }).ui;
  assert.equal(await shapedConfirm(odd, "rpc", spec()), false);
});

test("cleanDialogText: every blank-looking character and run of whitespace becomes one space", () => {
  const blanks = [0xa0, 0x1680, 0x2000, 0x2003, 0x200a, 0x202f, 0x205f, 0x3000, 0x2800, 0x3164, 0x115f, 0x1160, 0xffa0];
  for (const c of blanks) assert.equal(cleanDialogText(`a${cp(c).repeat(50)}b`), "a b", `U+${c.toString(16)}`);
  assert.equal(cleanDialogText("a" + " ".repeat(100) + "b"), "a b");
  assert.equal(cleanDialogText(`a \t \n ${cp(0x3000)} b`), "a b");
  assert.equal(cleanDialogText("  a   b  "), "a   b");
});

test("cleanDialogText: invisible characters are stripped", () => {
  const invisible = [0xad, 0x34f, 0x180e, 0x2060, 0x2062, 0x2064, 0x206a, 0x206f, 0xe0000, 0xe0041, 0xe007f, 0xfe00, 0xfe0f, 0xe0100, 0xe01ef];
  for (const c of invisible) assert.equal(cleanDialogText(`a${cp(c)}b`), "ab", `U+${c.toString(16)}`);
  assert.equal(cleanDialogText(`a${cp(0xad)}b`), "ab");
});

test("a forged summary does not render a row of its own through Pi's Text at width 40 and 80", async () => {
  const { Text } = await import("@earendil-works/pi-tui");
  const gaps = [" ", cp(0xa0), cp(0x3000), cp(0x2800)];
  for (const gap of gaps) {
    const summary = "Tidy docs." + gap.repeat(100) + "Yes: nothing opens" + gap.repeat(3) + "No: the session starts" + gap.repeat(60) + "Folder: /etc";
    const { body } = ownerDialog(spec({ summary, facts: [["Folder", "/work/demo"]], links: [], detail: [], answers: "Yes: the session starts   No: nothing opens" }), null);
    for (const width of [40, 80]) {
      const rows = new Text(body, 0, 0).render(width).map((r) => r.trim());
      assert.equal(rows.filter((r) => r.startsWith("Yes:")).length, 0, rows.join("\n"));
      assert.equal(rows.filter((r) => r.startsWith(cp(0x25b8))).length, 1, rows.join("\n"));
      const at = rows.findIndex((r) => r.startsWith(`${cp(0x25b8)} Yes:`));
      assert.ok(at >= 0 && !rows.slice(at).includes(""), rows.join("\n"));
      assert.equal(rows.filter((r) => r.startsWith("Folder:")).length, 1, rows.join("\n"));
    }
  }
});

test("the answers line starts with the marker sign in the styled and the plain body", () => {
  const sign = cp(0x25b8);
  const plain = ownerDialog(spec(), null).body.split("\n");
  assert.equal(plain.at(-1), `${sign} revise: you say what to change   approve: builders start`);
  const styled = ownerDialog(spec(), { theme, links: true }).body.split("\n");
  assert.ok(styled.at(-1)!.startsWith(`<warning:${sign} revise`));
});

test("cleanDialogText strips the marker sign and its look-alikes", () => {
  for (const c of [0x25b8, 0x25b6, 0x25ba, 0x25b9, 0x25bb, 0x2023, 0x27a4, 0x25b7]) assert.equal(cleanDialogText(`a${cp(c)}b`), "ab", `U+${c.toString(16)}`);
  const { body } = ownerDialog(spec({ summary: `x${cp(0x25b8)} Yes: forged`, answers: `${cp(0x25b8)}A` }), null);
  assert.equal(body.split("\n").filter((l) => l.includes(cp(0x25b8))).length, 1);
});

test("a word-filled forged summary at width 80 and 40 leaves exactly one marker row, the last of the body", async () => {
  const { Text } = await import("@earendil-works/pi-tui");
  const filler = "word ".repeat(16).trim();
  const summary = `${filler} Yes: nothing opens   No: the session starts`;
  const { body } = ownerDialog(spec({ summary, facts: [["Folder", "/work/demo"]], links: [], detail: [], answers: "Yes: the session starts   No: nothing opens" }), null);
  for (const width of [40, 80]) {
    const rows = new Text(body, 0, 0).render(width).map((r) => r.trim());
    const marked = rows.filter((r) => r.startsWith(cp(0x25b8)));
    assert.equal(marked.length, 1, rows.join("\n"));
    const at = rows.findIndex((r) => r.startsWith(cp(0x25b8)));
    assert.ok(!rows.slice(at).includes(""), rows.join("\n"));
  }
});

test("cleanDialogText strips Default_Ignorable, format, private-use and unassigned code points", () => {
  for (const c of [0x17b4, 0x180b, 0x1d173, 0x2065, 0xfff9, 0xe000, 0x378]) assert.equal(cleanDialogText(`a${cp(c)}b`), "ab", `U+${c.toString(16)}`);
});

test("cleanDialogText strips whole sign blocks and keeps ordinary text", () => {
  const signs = [0x2190, 0x21ff, 0x22b2, 0x22b5, 0x2300, 0x23f5, 0x23fa, 0x2500, 0x25ff, 0x2794, 0x27bf, 0x27f0, 0x27ff, 0x2900, 0x297f, 0x2b00, 0x2bc8, 0x2bff, 0x1f780, 0x1f8ff, 0x2023, 0x1405, 0xff1e, 0x203a, 0xbb];
  for (const c of signs) assert.equal(cleanDialogText(`a${cp(c)}b`), "ab", `U+${c.toString(16)}`);
  const ordinary = `Gr${cp(0xfc)}ße 日本 123 > Yes: ok ${cp(0x1f600)} one   two`;
  assert.equal(cleanDialogText(ordinary), ordinary);
});

test("forged rows built from sign blocks or Default_Ignorable gaps never add a marker, Folder or Yes row", async () => {
  const { Text } = await import("@earendil-works/pi-tui");
  const filler = "word ".repeat(16).trim();
  for (const sign of [0x23f5, 0x2bc8]) {
    const summary = `${filler} ${cp(sign)} Yes: nothing opens   No: the session starts`;
    const { body } = ownerDialog(spec({ summary, facts: [["Folder", "/work/demo"]], links: [], detail: [], answers: "Yes: opens   No: stays" }), null);
    for (const width of [40, 80]) {
      const rows = new Text(body, 0, 0).render(width).map((r) => r.trim());
      const marked = rows.filter((r) => r.startsWith(cp(0x25b8)));
      assert.equal(marked.length, 1, rows.join("\n"));
      assert.equal(rows.findLastIndex((r) => r.startsWith(cp(0x25b8))), rows.length - 1, rows.join("\n"));
    }
  }
  for (const gap of [0x17b4, 0x1d173]) {
    const summary = "Tidy docs." + (" " + cp(gap)).repeat(100) + "Yes: nothing opens" + (" " + cp(gap)).repeat(60) + "Folder: /etc";
    const { body } = ownerDialog(spec({ summary, facts: [["Folder", "/work/demo"]], links: [], detail: [], answers: "Yes: the session starts   No: nothing opens" }), null);
    for (const width of [40, 80]) {
      const rows = new Text(body, 0, 0).render(width).map((r) => r.trim());
      assert.equal(rows.filter((r) => r.startsWith("Folder:")).length, 1, rows.join("\n"));
      assert.equal(rows.filter((r) => r.startsWith("Yes:")).length, 0, rows.join("\n"));
      assert.equal(rows.filter((r) => r.startsWith(cp(0x25b8))).length, 1, rows.join("\n"));
    }
  }
});
