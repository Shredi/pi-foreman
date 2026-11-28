// pr_attach attaches with no PR tracker: the upload-host check reads the checkout's git remote (the pr_repo op).
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
import type { ReviewRecord } from "../reviews.ts";
import type { Spawner } from "../spawn.ts";

type Tool = { name: string; execute: (...a: unknown[]) => Promise<{ content: { text: string }[] }> };
const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-attach3-")));
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
    const o = req.op === "pr_repo" ? (host === null ? { ok: false } : { ok: true, action: "pr_repo", host, repo: "acme/app" }) : req.op === "pr_status" ? { ok: true, action: "pr_status", number: 12, headSha: HEAD } : req.op === "pr_attach" ? { ok: true, action: "pr_attach", number: 12, ...degraded } : { ok: true, action: "pr_create", number: 12, url: "https://github.com/acme/app/pull/12", head: "feat", base: "main", ...degraded };
    return { code: 0, stdout: JSON.stringify(o) + "\n", stderr: "", timedOut: false };
  };
  const watches = new PrWatches({ storeEntry: () => ({ kind: "waiting" }), githubHosts: () => ({ hosts: ["github.com"] }), send: () => {}, idle: () => true, trace: () => {}, intervalMs: () => 60_000, now: () => 0, timers: { set: () => 1, clear: () => {} } });
  const session: PrPackSession = {
    python: "/py", isChild: opts.childSession === true, packOn: true, config: { prHost: "auto" }, gateOn: opts.gateOn === true, reviewed: async () => [HEAD], records: async () => records, watches, trace: () => {},
    track: async () => "added", githubHosts: () => ({ hosts: ["github.com"] }),
  };
  registerPrPack({ registerTool: (t: unknown) => void tools.set((t as Tool).name, t as Tool) } as never, { isChild: opts.childDeps === true, session: async () => session, script: "/s.py", spawner, env: () => ({}), pushRefusal: async () => null });
  const run = (name: string, params: Record<string, unknown>) => tools.get(name)!.execute("id", params, undefined, undefined, { cwd: repo });
  return { run, calls, tools };
}
const sent = (calls: Call[], op: string) => calls.filter((c) => c.op === op);

test("pr_attach with no tracker and a github.com remote: no degrade", async () => {
  put("ok.png", PNG);
  const x = setup([rec()]);
  await x.run("pr_attach", { attach: [{ path: "ok.png" }] });
  const a = sent(x.calls, "pr_attach");
  assert.equal(a.length, 1);
  assert.equal(a[0].args.attach_degrade, undefined);
});

test("pr_attach with no tracker and a GHE Server remote degrades; an unreadable remote degrades", async () => {
  put("ok.png", PNG);
  const ghes = setup([rec()], { host: "ghe.example.test" });
  await ghes.run("pr_attach", { attach: [{ path: "ok.png" }] });
  assert.match(String(sent(ghes.calls, "pr_attach")[0].args.attach_degrade), /not github\.com/);
  const none = setup([rec()], { host: null });
  await none.run("pr_attach", { attach: [{ path: "ok.png" }] });
  assert.match(String(sent(none.calls, "pr_attach")[0].args.attach_degrade), /could not be read/);
});

test("pr_attach with an empty attach list is refused by the tool (the schema has no minItems)", async () => {
  const x = setup([rec()]);
  const r = await x.run("pr_attach", { attach: [] });
  assert.match(r.content[0].text, /attach_invalid|1 to/);
  assert.equal(sent(x.calls, "pr_attach").length, 0);
});
