// Images in a pull request (prattach.ts, gitpack.ts): the file checks, the review test, pr_create attach and pr_attach (refusals, degrade to a non-GitHub host, several files).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { registerPrPack } from "../gitpack.ts";
import type { PrPackSession } from "../gitpack.ts";
import { PrWatches } from "../prwatch.ts";
import { attachRefusal, checkAttach, parseAttachEntries, parseAttachPaths, rehashAttach, stillImageProblem } from "../prattach.ts";
import type { ReviewRecord } from "../reviews.ts";
import type { Spawner } from "../spawn.ts";

type Tool = { name: string; execute: (...a: unknown[]) => Promise<{ content: { text: string }[] }> };
const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-attach-")));
const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-attach-out-")));
execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=n", "commit", "-q", "--allow-empty", "-m", "x"], { cwd: repo });
const HEAD = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
test.after(() => {
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

const chunk = (type: string, data: Buffer = Buffer.alloc(0)): Buffer => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  return Buffer.concat([len, Buffer.from(type, "latin1"), data, Buffer.alloc(4)]);
};
const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG = Buffer.concat([SIG, chunk("IHDR", Buffer.alloc(13)), chunk("IDAT", Buffer.from("x")), chunk("IEND")]);
const APNG = Buffer.concat([SIG, chunk("IHDR", Buffer.alloc(13)), chunk("acTL", Buffer.alloc(8)), chunk("IDAT", Buffer.from("x")), chunk("IEND")]);
const put = (rel: string, data: Buffer | string): string => {
  const f = path.join(repo, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, data);
  return f;
};
const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

test("entries: shape limits, # and line breaks refused", () => {
  assert.ok("entries" in parseAttachEntries([{ path: "a.png", caption: "c" }, "b.png"]));
  for (const bad of [[], "a.png", [{ path: "a#b.png" }], [{ path: "a.png", caption: "x#y" }], [{ path: "a\n.png" }], [{ path: "a.png", extra: 1 }], Array(11).fill("a.png")]) {
    assert.ok("reason" in parseAttachEntries(bad), JSON.stringify(bad));
  }
  assert.ok("reason" in parseAttachPaths([{ path: "a.png" }]));
});

test("files: several still images pass, with their sha256 and repo-relative paths", () => {
  put(".workflow/shots/a.png", PNG);
  put("b.jpeg", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1]));
  const r = checkAttach([{ path: ".workflow/shots/a.png", caption: "A" }, { path: path.join(repo, "b.jpeg") }], repo);
  assert.ok("files" in r);
  if ("files" in r) {
    assert.deepEqual(r.files.map((f) => f.path), [".workflow/shots/a.png", "b.jpeg"]);
    assert.equal(r.files[0].sha256, sha(PNG));
    assert.equal(r.files[0].caption, "A");
  }
});

test("files: outside the checkout (path, .., symlink), wrong type, animation, missing and duplicates are refused", () => {
  fs.writeFileSync(path.join(outside, "o.png"), PNG);
  put("link.png", "");
  fs.rmSync(path.join(repo, "link.png"));
  fs.symlinkSync(path.join(outside, "o.png"), path.join(repo, "link.png"));
  put("anim.png", APNG);
  put("clip.gif", "GIF89a");
  put("fake.png", "not a png");
  put("empty.png", Buffer.alloc(0));
  put("ok.png", PNG);
  const reason = (p: string) => {
    const r = checkAttach([{ path: p }], repo);
    return "reason" in r ? r.reason : "ok";
  };
  assert.equal(reason(path.join(outside, "o.png")), "attach_outside");
  assert.equal(reason("../" + path.basename(outside) + "/o.png"), "attach_outside");
  assert.equal(reason("link.png"), "attach_outside");
  assert.equal(reason("anim.png"), "attach_type");
  assert.equal(reason("clip.gif"), "attach_type");
  assert.equal(reason("fake.png"), "attach_type");
  assert.equal(reason("empty.png"), "attach_type");
  assert.equal(reason("nope.png"), "attach_missing");
  assert.equal(reason("ok.png"), "ok");
  assert.ok("reason" in checkAttach([{ path: "ok.png" }, { path: "./ok.png" }], repo));
  assert.match(stillImageProblem(Buffer.concat([Buffer.from("RIFF\0\0\0\0WEBP"), Buffer.from("ANIM"), Buffer.alloc(8)]), ".webp") ?? "", /animated/);
});

test("rehash: a changed file is dropped", () => {
  put("h.png", PNG);
  const ref = { path: "h.png", sha256: sha(PNG) };
  assert.deepEqual(rehashAttach([ref], repo).kept, [ref]);
  put("h.png", Buffer.concat([PNG, Buffer.from("z")]));
  assert.deepEqual(rehashAttach([ref], repo).dropped, ["h.png"]);
});

const rec = (extra: Partial<ReviewRecord> = {}): ReviewRecord => ({ role: "reviewer", verdict: "pass", head: HEAD, cwd: repo, kind: "code", occasion: "pre-pr", attach: [{ path: "ok.png", sha256: sha(PNG) }], ...extra });
const ref = [{ path: "ok.png", sha256: sha(PNG) }];

test("review test: only the newest [pre-pr] PASS on the head with the same hash releases a file", () => {
  assert.equal(attachRefusal("pr_create", [rec()], repo, HEAD, ref), null);
  for (const records of [[], [rec({ attach: undefined })], [rec({ verdict: "fail" })], [rec({ occasion: "item" })], [rec({ head: "f".repeat(40) })], [rec(), rec({ attach: undefined, run: "2" })], [rec({ attach: [{ path: "ok.png", sha256: "0".repeat(64) }] })]]) {
    assert.equal(attachRefusal("pr_create", records, repo, HEAD, ref)?.reason, "attach_unreviewed");
  }
});

type Call = { op: string; args: Record<string, unknown> };
function setup(records: ReviewRecord[], opts: { host?: string; headSha?: string } = {}) {
  const tools = new Map<string, Tool>();
  const calls: Call[] = [];
  const host = opts.host ?? "github.com";
  const spawner: Spawner = async (_c, _a, opt) => {
    const req = JSON.parse(opt.input ?? "{}") as Call;
    calls.push(req);
    const o = req.op === "pr_status" ? { ok: true, action: "pr_status", number: 12, headSha: opts.headSha ?? HEAD } : req.op === "pr_attach" ? { ok: true, action: "pr_attach", number: 12, attached: 1 } : { ok: true, action: "pr_create", number: 12, url: `https://${host}/acme/app/pull/12`, head: "feat", base: "main" };
    return { code: 0, stdout: JSON.stringify(o) + "\n", stderr: "", timedOut: false };
  };
  const watches = new PrWatches({ storeEntry: () => ({ kind: "waiting" }), githubHosts: () => ({ hosts: [host] }), send: () => {}, idle: () => true, trace: () => {}, intervalMs: () => 60_000, now: () => 0, timers: { set: () => 1, clear: () => {} } });
  const session: PrPackSession = {
    python: "/py", isChild: false, packOn: true, config: { prHost: "auto" }, gateOn: false, reviewed: async () => [], records: async () => records, watches, trace: () => {},
    tracker: { hostAllowed: async () => true, repoFor: async () => ({ host, repo: "acme/app" }) },
    track: async () => "added", githubHosts: () => ({ hosts: [host] }),
  };
  registerPrPack({ registerTool: (t: unknown) => void tools.set((t as Tool).name, t as Tool) } as never, { isChild: false, session: async () => session, script: "/s.py", spawner, env: () => ({}), pushRefusal: async () => null });
  const run = (name: string, params: Record<string, unknown>) => tools.get(name)!.execute("id", params, undefined, undefined, { cwd: repo });
  return { run, calls };
}

test("pr_create with attach: reviewed files go to the host op as path#caption, several files", async () => {
  put("ok.png", PNG);
  put("two.png", PNG);
  const both = [{ path: "ok.png", sha256: sha(PNG) }, { path: "two.png", sha256: sha(PNG) }];
  const x = setup([rec({ attach: both })]);
  await x.run("pr_create", { title: "T", body: "b", attach: [{ path: "ok.png", caption: "One" }, { path: "two.png" }] });
  const create = x.calls.find((c) => c.op === "pr_create")!;
  assert.deepEqual(create.args.attach, ["ok.png#One", "two.png"]);
  assert.equal(create.args.attach_degrade, undefined);
});

test("pr_create with attach: not covered by the review, outside the checkout or an old review: refused before the host", async () => {
  put("ok.png", PNG);
  fs.writeFileSync(path.join(outside, "o.png"), PNG);
  for (const [records, attach, text] of [[[], [{ path: "ok.png" }], /attach_unreviewed/], [[rec()], [{ path: path.join(outside, "o.png") }], /attach_outside/], [[rec({ occasion: "item" })], [{ path: "ok.png" }], /attach_unreviewed/]] as const) {
    const x = setup([...records]);
    const r = await x.run("pr_create", { title: "T", body: "b", attach });
    assert.match(r.content[0].text, text);
    assert.equal(x.calls.length, 0);
  }
});

test("pr_create with attach on a non-GitHub.com host: the op gets the degrade reason", async () => {
  put("ok.png", PNG);
  const x = setup([rec()], { host: "git.example.test" });
  await x.run("pr_create", { title: "T", body: "b", attach: [{ path: "ok.png" }] });
  const create = x.calls.find((c) => c.op === "pr_create")!;
  assert.match(String(create.args.attach_degrade), /git\.example\.test/);
});

test("pr_attach: reviewed files are posted; an unreviewed later addition and a moved head are refused", async () => {
  put("ok.png", PNG);
  put("later.png", PNG);
  const ok = setup([rec()]);
  await ok.run("pr_attach", { attach: [{ path: "ok.png" }] });
  assert.deepEqual(ok.calls.find((c) => c.op === "pr_attach")!.args.attach, ["ok.png"]);

  const later = setup([rec()]);
  const r = await later.run("pr_attach", { attach: [{ path: "later.png" }] });
  assert.match(r.content[0].text, /attach_unreviewed/);
  assert.equal(later.calls.some((c) => c.op === "pr_attach"), false);

  const moved = setup([rec()], { headSha: "e".repeat(40) });
  const m = await moved.run("pr_attach", { attach: [{ path: "ok.png" }] });
  assert.match(m.content[0].text, /attach_head_moved/);
  assert.equal(moved.calls.some((c) => c.op === "pr_attach"), false);
});
