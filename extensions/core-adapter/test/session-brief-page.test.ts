// Brief pages in the TS session code: the open dialog (link to the rendered state page, heading, hidden-text line, refusal before the dialog,
// file link with the page server off, markdown unchanged, a pending open still spawns) and `session brief` (brief-<n>.md copy + brief-<n>.html).
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { runSessionCommand, sessionBrief } from "../session.ts";
import type { SessionDeps } from "../session.ts";
import { ownerDialog } from "../ownerdialog.ts";
import type { DialogSpec } from "../ownerdialog.ts";
import { pageLinks } from "../pagelinks.ts";
import { PLAN_MAX_BYTES } from "../checkpoint.ts";
import { trackedTmp } from "./_tmpbase.ts";
import { rig, sleep } from "./_session-open-rig.ts";

const root = fs.realpathSync.native(trackedTmp("pf-brief-page-"));
const agentDir = path.join(root, "agent");
const PAGE = "<html><body><h1>Brief: finish the part</h1><p>Do it.</p></body></html>";
fs.writeFileSync(path.join(root, "p.html"), PAGE);
fs.writeFileSync(path.join(root, "hid.html"), `<h1>Hidden one</h1><p style="display:none">x</p><p style="opacity:0">y</p>`);
fs.writeFileSync(path.join(root, "big.html"), `<p>${"x".repeat(PLAN_MAX_BYTES)}</p>`);
fs.writeFileSync(path.join(root, "m.md"), "# Markdown brief\nbody\n");
const was = pageLinks.url;
afterEach(() => void (pageLinks.url = was));

function deps(over: Partial<SessionDeps> = {}): SessionDeps & { spawned: string[][]; asked: number } {
  const spawned: string[][] = [];
  const d = {
    isChild: false, env: {}, agentDir, cwd: root, piSessionId: "sess-1", pkgRoot: "/pkg", python: "/usr/bin/python3",
    spawner: async (_c: string, args: string[]) => (spawned.push(args), { code: 0, stdout: "handoff: x", stderr: "", timedOut: false }),
    send: async () => "sent", confirm: async () => false, spawned, asked: 0, ...over,
  };
  return d as SessionDeps & { spawned: string[][]; asked: number };
}

async function specOf(brief: string): Promise<DialogSpec> {
  return new Promise((resolve) => {
    void runSessionCommand(deps({ confirmShaped: async (spec) => (resolve(spec), false) }), `open demo ${brief}`);
  });
}

const URL_ = "http://127.0.0.1:47317/BrIeF/brief.html";

test("dialog: the link is the rendered state page (kind page, served URL), the heading comes from the page title", async () => {
  const seen: string[] = [];
  pageLinks.url = async (p, kind) => (seen.push(`${kind}:${p}`), URL_);
  const spec = await specOf("p.html");
  const l = spec.links![0];
  assert.equal(l.kind, "page");
  assert.equal(l.url, URL_);
  assert.equal(seen.length, 1);
  assert.equal(seen[0], `file:${l.path}`);
  assert.match(l.path.split(path.sep).join("/"), /\/agent\/pi-foreman\/state\/brief-pages\/[0-9a-f]{16}\/brief\.html$/);
  assert.match(fs.readFileSync(l.path, "utf8"), /id="pi-foreman-banner"/);
  assert.equal(spec.summary, "Finish the part");
  assert.deepEqual(spec.detail, ["Brief heading: Finish the part"]);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(l.path).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(l.path)).mode & 0o777, 0o700);
  }
});

test("dialog: the hidden-text line shows only when the page has hidden spots", async () => {
  pageLinks.url = async () => null;
  assert.deepEqual((await specOf("hid.html")).detail, ["Brief heading: Hidden one", "Hidden text on the page: 2 spots (the session reads the text copy)"]);
  assert.ok(!(await specOf("p.html")).detail!.some((x) => x.startsWith("Hidden text")));
});

test("dialog: with the page server off the link is the page file (no url), drawn as a file link", async () => {
  pageLinks.url = async () => null;
  const spec = await specOf("p.html");
  const l = spec.links![0];
  assert.equal(l.url, undefined);
  assert.equal(l.kind, "page");
  assert.match(ownerDialog(spec, null).body, /brief\.html/);
});

test("dialog: a conversion error refuses the open before the dialog and spawns nothing", async () => {
  const d = deps({ confirm: async () => ((d.asked += 1), true) });
  const r = await runSessionCommand(d, "open demo big.html");
  assert.equal(r.ok, false);
  assert.match(r.text, /^session open refused \[brief_too_large\]: big\.html/);
  assert.equal(d.asked, 0);
  assert.equal(d.spawned.length, 0);
});

test("dialog: a markdown brief is unchanged (kind text, the file itself, no page written for it)", async () => {
  pageLinks.url = async () => null;
  const before = fs.existsSync(path.join(agentDir, "pi-foreman", "state", "brief-pages")) ? fs.readdirSync(path.join(agentDir, "pi-foreman", "state", "brief-pages")).length : 0;
  const spec = await specOf("m.md");
  assert.deepEqual(spec.links![0], { label: "Brief", path: path.join(root, "m.md"), text: "open the brief", kind: "text" });
  assert.deepEqual(spec.detail, ["Brief heading: Markdown brief"]);
  const after = fs.existsSync(path.join(agentDir, "pi-foreman", "state", "brief-pages")) ? fs.readdirSync(path.join(agentDir, "pi-foreman", "state", "brief-pages")).length : 0;
  assert.equal(after, before);
});

test("dialog: rendered pages older than 7 days are swept at the next render, newer ones stay", async () => {
  pageLinks.url = async () => null;
  const base = path.join(agentDir, "pi-foreman", "state", "brief-pages");
  const old = path.join(base, "0".repeat(16));
  const fresh = path.join(base, "1".repeat(16));
  fs.mkdirSync(old, { recursive: true });
  fs.mkdirSync(fresh, { recursive: true });
  const eight = new Date(Date.now() - 8 * 24 * 3600 * 1000);
  fs.utimesSync(old, eight, eight);
  await specOf("p.html");
  assert.ok(!fs.existsSync(old));
  assert.ok(fs.existsSync(fresh));
});

test("pending open: after the dialog settles with Yes the open spawns with the original page path", async () => {
  const r = rig({ confirmWaitSeconds: 0.05 });
  try {
    fs.writeFileSync(path.join(r.root, "p.html"), PAGE);
    const first = await r.call({ brief: "p.html", summary: "Do the part." });
    assert.match(r.text(first), /waiting for the owner|pending/i);
    assert.equal(r.dialogs.length, 1);
    assert.equal(r.spawned.length, 0);
    r.dialogs[0].answer(true);
    await sleep(100);
    assert.equal(r.spawned.length, 1);
    assert.ok(r.spawned[0].includes(path.join(r.root, "p.html")), "Python gets the page, not the rendered copy");
    assert.equal(r.woke.length, 1);
  } finally {
    r.cleanup();
  }
});

// ---- session brief

function handoff(name: string): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "child"), "fm-demo-abc123\n");
  return dir;
}

test("session brief: an .html file becomes brief-1.md (copy) and brief-1.html (page), the message names the copy", async () => {
  const dir = handoff("h1");
  const sent: string[] = [];
  const r = await sessionBrief(deps({ send: async (_to, text) => (sent.push(text), "sent") }), dir, path.join(root, "p.html"));
  assert.equal(r.ok, true, r.text);
  assert.equal(fs.readFileSync(path.join(dir, "brief-1.md"), "utf8"), "<!-- generated from the brief page p.html; the page is the source -->\n# Brief: finish the part\n\nDo it.\n");
  assert.match(fs.readFileSync(path.join(dir, "brief-1.html"), "utf8"), /Do it\./);
  assert.match(sent[0], /read .*brief-1\.md and act on it$/);
  assert.equal(await sessionBrief(deps(), dir, path.join(root, "m.md")).then((x) => x.ok), true);
  assert.ok(fs.existsSync(path.join(dir, "brief-2.md")));
  assert.ok(!fs.existsSync(path.join(dir, "brief-2.html")), "a markdown brief writes no page");
  assert.equal(await sessionBrief(deps(), dir, path.join(root, "hid.html")).then((x) => x.ok), true);
  assert.ok(fs.existsSync(path.join(dir, "brief-3.html")), "the page takes the same n as its copy");
});

test("session brief: --rework still writes the marker for an .html brief; a conversion error writes nothing", async () => {
  const dir = handoff("h2");
  const r = await sessionBrief(deps(), dir, path.join(root, "p.html"), true);
  assert.equal(r.ok, true, r.text);
  assert.ok(fs.existsSync(path.join(dir, "rework-1")));
  const dir2 = handoff("h3");
  const bad = await sessionBrief(deps(), dir2, path.join(root, "big.html"));
  assert.equal(bad.ok, false);
  assert.match(bad.text, /\[brief_too_large\]/);
  assert.deepEqual(fs.readdirSync(dir2), ["child"]);
});
