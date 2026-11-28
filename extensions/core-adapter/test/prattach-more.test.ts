// Images in a pull request (prattach.ts, gitpack.ts), the cases the first file leaves: body unchanged, more refused types, host kinds, the one-line notice,
// the gate with the ceremony off, a child and the pr_attach paths.
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
import { ATTACH_MAX, attachRefusal, checkAttach, githubUploadHost, parseAttachEntries, stillImageProblem } from "../prattach.ts";
import type { ReviewRecord } from "../reviews.ts";
import type { Spawner } from "../spawn.ts";

type Tool = { name: string; execute: (...a: unknown[]) => Promise<{ content: { text: string }[] }> };
const repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-attach2-")));
execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=n", "commit", "-q", "--allow-empty", "-m", "x"], { cwd: repo });
const HEAD = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
test.after(() => fs.rmSync(repo, { recursive: true, force: true }));

const chunk = (type: string, data: Buffer = Buffer.alloc(0)): Buffer => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  return Buffer.concat([len, Buffer.from(type, "latin1"), data, Buffer.alloc(4)]);
};
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", Buffer.alloc(13)), chunk("IDAT", Buffer.from("x")), chunk("IEND")]);
const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");
const put = (rel: string, data: Buffer | string): void => {
  const f = path.join(repo, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, data);
};
const rec = (extra: Partial<ReviewRecord> = {}): ReviewRecord => ({ role: "reviewer", verdict: "pass", head: HEAD, cwd: repo, kind: "code", occasion: "pre-pr", attach: [{ path: "ok.png", sha256: sha(PNG) }], ...extra });

type Call = { op: string; args: Record<string, unknown> };
interface Opts { host?: string | null; gateOn?: boolean; childSession?: boolean; childDeps?: boolean; degraded?: string }
function setup(records: ReviewRecord[], opts: Opts = {}) {
  const tools = new Map<string, Tool>();
  const calls: Call[] = [];
  const host = opts.host === undefined ? "github.com" : opts.host;
  const spawner: Spawner = async (_c, _a, opt) => {
    const req = JSON.parse(opt.input ?? "{}") as Call;
    calls.push(req);
    const degraded = opts.degraded ? { attach_degraded: opts.degraded } : {};
    const o = req.op === "pr_status" ? { ok: true, action: "pr_status", number: 12, headSha: HEAD } : req.op === "pr_attach" ? { ok: true, action: "pr_attach", number: 12, ...degraded } : { ok: true, action: "pr_create", number: 12, url: "https://github.com/acme/app/pull/12", head: "feat", base: "main", ...degraded };
    return { code: 0, stdout: JSON.stringify(o) + "\n", stderr: "", timedOut: false };
  };
  const watches = new PrWatches({ storeEntry: () => ({ kind: "waiting" }), githubHosts: () => ({ hosts: ["github.com"] }), send: () => {}, idle: () => true, trace: () => {}, intervalMs: () => 60_000, now: () => 0, timers: { set: () => 1, clear: () => {} } });
  const session: PrPackSession = {
    python: "/py", isChild: opts.childSession === true, packOn: true, config: { prHost: "auto" }, gateOn: opts.gateOn === true, reviewed: async () => [HEAD], records: async () => records, watches, trace: () => {},
    tracker: { hostAllowed: async () => true, repoFor: async () => (host === null ? null : { host, repo: "acme/app" }) },
    track: async () => "added", githubHosts: () => ({ hosts: ["github.com"] }),
  };
  registerPrPack({ registerTool: (t: unknown) => void tools.set((t as Tool).name, t as Tool) } as never, { isChild: opts.childDeps === true, session: async () => session, script: "/s.py", spawner, env: () => ({}), pushRefusal: async () => null });
  const run = (name: string, params: Record<string, unknown>) => tools.get(name)!.execute("id", params, undefined, undefined, { cwd: repo });
  return { run, calls, tools };
}
const sent = (calls: Call[], op: string) => calls.filter((c) => c.op === op);

test("pr_create: the body goes to the host as written (no image line added by TS), whether it names the path or not", async () => {
  put("ok.png", PNG);
  for (const body of ["see ok.png here", "no image named"]) {
    const x = setup([rec()]);
    await x.run("pr_create", { title: "T", body, attach: [{ path: "ok.png" }] });
    const sentBody = String(sent(x.calls, "pr_create")[0].args.body); // the harness adds its Reviews block; nothing about the images
    assert.ok(sentBody.startsWith(body), sentBody);
    assert.doesNotMatch(sentBody, /kept locally/);
  }
});

test("files: .mp4 and .gif are refused as attach_type; an animated WebP (VP8X flag) is refused; a still WebP passes", () => {
  put("clip.mp4", Buffer.from("....ftypmp42"));
  put("clip.gif", "GIF89a");
  const reason = (p: string) => {
    const r = checkAttach([{ path: p }], repo);
    return "reason" in r ? r.reason : "ok";
  };
  assert.equal(reason("clip.mp4"), "attach_type");
  assert.equal(reason("clip.gif"), "attach_type");
  const vp8x = (flags: number) => {
    const b = Buffer.alloc(18);
    b.write("VP8X", 0, "latin1");
    b.writeUInt32LE(10, 4);
    b[8] = flags;
    return Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), b]);
  };
  assert.match(stillImageProblem(vp8x(0x02), ".webp") ?? "", /animated/);
  assert.equal(stillImageProblem(vp8x(0x00), ".webp"), null);
});

test("files: a path inside .workflow/ is accepted; a symlink inside the checkout that points outside is refused", () => {
  put(".workflow/screenshots/s.png", PNG);
  assert.ok("files" in checkAttach([{ path: ".workflow/screenshots/s.png" }], repo));
  const outside = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-attach2-out-")));
  try {
    fs.writeFileSync(path.join(outside, "o.png"), PNG);
    fs.rmSync(path.join(repo, "lnk.png"), { force: true });
    fs.symlinkSync(path.join(outside, "o.png"), path.join(repo, "lnk.png"));
    const r = checkAttach([{ path: "lnk.png" }], repo);
    assert.equal("reason" in r ? r.reason : "ok", "attach_outside");
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("entries: # in a path or a caption, a line break, 11 entries and a long caption are refused; 10 entries pass", () => {
  const bad = (x: unknown) => "reason" in parseAttachEntries(x);
  assert.equal(bad([{ path: "a#b.png" }]), true);
  assert.equal(bad([{ path: "a.png", caption: "c#d" }]), true);
  assert.equal(bad([{ path: "a.png", caption: "c\nd" }]), true);
  assert.equal(bad([{ path: "a.png", caption: "x".repeat(201) }]), true);
  assert.equal(bad(Array.from({ length: ATTACH_MAX + 1 }, (_, i) => `${i}.png`)), true);
  assert.equal(bad(Array.from({ length: ATTACH_MAX }, (_, i) => `${i}.png`)), false);
});

test("host kinds: github.com and a *.ghe.com host take uploads, a self-hosted name does not", () => {
  assert.equal(githubUploadHost("github.com"), true);
  assert.equal(githubUploadHost("acme.ghe.com"), true);
  assert.equal(githubUploadHost("GitHub.com"), true);
  assert.equal(githubUploadHost("ghe.example.test"), false);
  assert.equal(githubUploadHost("notgithub.com"), false);
});

test("pr_create: a *.ghe.com remote passes no degrade, an unreadable remote passes one (the op still gets the files)", async () => {
  put("ok.png", PNG);
  const ghe = setup([rec()], { host: "x.ghe.com" });
  await ghe.run("pr_create", { title: "T", body: "b", attach: [{ path: "ok.png" }] });
  assert.equal(sent(ghe.calls, "pr_create")[0].args.attach_degrade, undefined);
  const none = setup([rec()], { host: null });
  await none.run("pr_create", { title: "T", body: "b", attach: [{ path: "ok.png" }] });
  const args = sent(none.calls, "pr_create")[0].args;
  assert.match(String(args.attach_degrade), /could not be read/);
  assert.deepEqual(args.attach, ["ok.png"]);
});

test("pr_create: an op answer with attach_degraded gives the one-line notice; pr_attach degraded is a normal answer", async () => {
  put("ok.png", PNG);
  const c = setup([rec()], { degraded: "gh 2.98.0 is older than 2.99.0" });
  const r = await c.run("pr_create", { title: "T", body: "b", attach: [{ path: "ok.png" }] });
  const text = r.content.map((x) => x.text).join("\n");
  assert.match(text, /attachments not uploaded: gh 2\.98\.0 is older than 2\.99\.0 \(needs gh 2\.99\.0\+ on github\.com or GHE Cloud\); the body names the files/);
  const a = setup([rec()], { degraded: "not GitHub" });
  const ra = await a.run("pr_attach", { attach: [{ path: "ok.png" }] });
  const at = ra.content.map((x) => x.text).join("\n");
  assert.match(at, /attachments not uploaded: not GitHub .*nothing was posted/);
  assert.doesNotMatch(at, /refused|error/i);
});

test("gate: with ceremony.reviewBeforePr off or on, an unreviewed image is refused before the host; an item PASS newest does not release it", async () => {
  put("ok.png", PNG);
  for (const gateOn of [false, true]) {
    for (const records of [[], [rec(), rec({ occasion: "item", attach: undefined })]]) {
      const x = setup(records, { gateOn });
      const r = await x.run("pr_create", { title: "T", body: "b", attach: [{ path: "ok.png" }] });
      assert.match(r.content[0].text, /attach_unreviewed/, `gateOn ${gateOn}`);
      assert.equal(sent(x.calls, "pr_create").length, 0);
    }
  }
});

test("gate: a file changed after the review is refused (sha mismatch) for pr_create and pr_attach", async () => {
  put("ok.png", PNG);
  const stale = rec({ attach: [{ path: "ok.png", sha256: "0".repeat(64) }] });
  const x = setup([stale]);
  assert.match((await x.run("pr_create", { title: "T", body: "b", attach: [{ path: "ok.png" }] })).content[0].text, /attach_unreviewed/);
  assert.match((await x.run("pr_attach", { attach: [{ path: "ok.png" }] })).content[0].text, /attach_unreviewed/);
  assert.equal(x.calls.some((c) => c.op === "pr_create" || c.op === "pr_attach"), false);
  assert.equal(attachRefusal("pr_attach", [stale], repo, HEAD, [{ path: "ok.png", sha256: sha(PNG) }])?.reason, "attach_unreviewed");
});

test("a child is refused pr_attach and pr_create with attach (session flag), and the child pack does not register pr_attach", async () => {
  put("ok.png", PNG);
  const x = setup([rec()], { childSession: true });
  for (const [name, p] of [["pr_attach", { attach: [{ path: "ok.png" }] }], ["pr_create", { title: "T", body: "b", attach: [{ path: "ok.png" }] }]] as const) {
    assert.match((await x.run(name, p)).content[0].text, /pr_refused:child/);
  }
  assert.equal(x.calls.length, 0);
  assert.equal(setup([rec()], { childDeps: true }).tools.has("pr_attach"), false);
});
