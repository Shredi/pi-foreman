// Round 4 of pr attach: the files hashed again before the draft-less retry, and the partial-upload line.
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
const repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-attach4-")));
execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=n", "commit", "-q", "--allow-empty", "-m", "x"], { cwd: repo });
const HEAD = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
test.after(() => fs.rmSync(repo, { recursive: true, force: true }));

const chunk = (type: string, data: Buffer = Buffer.alloc(0)): Buffer => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  return Buffer.concat([len, Buffer.from(type, "latin1"), data, Buffer.alloc(4)]);
};
const png = (n: string): Buffer => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", Buffer.alloc(13)), chunk("IDAT", Buffer.from(n)), chunk("IEND")]);
const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");
const put = (rel: string, data: Buffer): void => fs.writeFileSync(path.join(repo, rel), data);

type Call = { op: string; args: Record<string, unknown> };
function setup(records: ReviewRecord[], o: { onOp?: (op: string) => void; highStakes?: PrPackSession["highStakes"]; partial?: string } = {}) {
  const tools = new Map<string, Tool>();
  const calls: Call[] = [];
  const spawner: Spawner = async (_c, _a, opt) => {
    const req = JSON.parse(opt.input ?? "{}") as Call;
    calls.push(req);
    o.onOp?.(req.op);
    if (req.op === "pr_create" && req.args.draft === true) return { code: 0, stdout: JSON.stringify({ ok: false, error: "pr_host_failed", message: "pr_host_failed: gh: draft pull requests are not supported in this repository" }) + "\n", stderr: "", timedOut: false };
    const partial = o.partial ? { attach_partial: o.partial, attach_requested: 2 } : {};
    const res = req.op === "pr_status" ? { ok: true, action: "pr_status", number: 12, headSha: HEAD } : req.op === "pr_attach" ? { ok: true, action: "pr_attach", number: 12, attached: 1, ...partial } : { ok: true, action: "pr_create", number: 12, url: "https://github.com/acme/app/pull/12", head: "x", base: "main", ...partial };
    return { code: 0, stdout: JSON.stringify(res) + "\n", stderr: "", timedOut: false };
  };
  const watches = new PrWatches({ storeEntry: () => ({ kind: "waiting" }), githubHosts: () => ({ hosts: ["github.com"] }), send: () => {}, idle: () => true, trace: () => {}, intervalMs: () => 60_000, now: () => 0, timers: { set: () => 1, clear: () => {} } });
  const session: PrPackSession = {
    python: "/py", isChild: false, packOn: true, config: { prHost: "auto" }, gateOn: true, reviewed: async () => [HEAD], records: async () => records, watches, trace: () => {},
    // no tracker repo: the host is read by the pr_repo op, which is where the test changes the file
    tracker: { hostAllowed: async () => true, repoFor: async () => null },
    track: async () => "added", githubHosts: () => ({ hosts: ["github.com"] }),
    ...(o.highStakes ? { highStakes: o.highStakes } : {}),
  };
  registerPrPack({ registerTool: (t: unknown) => void tools.set((t as Tool).name, t as Tool) } as never, { isChild: false, session: async () => session, script: "/s.py", spawner, env: () => ({}), pushRefusal: async () => null });
  const run = (name: string, params: Record<string, unknown>) => tools.get(name)!.execute("id", params, undefined, undefined, { cwd: repo });
  return { run, calls };
}
const rec = (b: Buffer): ReviewRecord => ({ role: "reviewer", verdict: "pass", head: HEAD, cwd: repo, kind: "code", occasion: "pre-pr", attach: [{ path: "r4.png", sha256: sha(b) }] });
const sent = (calls: Call[], op: string) => calls.filter((c) => c.op === op);

test("pr_create: a file changed before the draft-less retry is refused and the second create never goes out", async () => {
  const a = png("a");
  put("r4.png", a);
  const x = setup([rec(a)], { onOp: (op) => { if (op === "pr_create") put("r4.png", png("changed")); } });
  const r = await x.run("pr_create", { title: "T", body: "b", holdDraft: true, attach: [{ path: "r4.png" }] });
  assert.match(r.content[0].text, /attach_unreviewed/);
  assert.equal(sent(x.calls, "pr_create").length, 1);
  put("r4.png", a);
});

test("partial upload: the line says how many were requested and that some failed", async () => {
  const a = png("a");
  put("r4.png", a);
  const x = setup([rec(a)], { partial: "failed to upload b.png" });
  const t = (await x.run("pr_attach", { attach: [{ path: "r4.png" }] })).content.map((c) => c.text).join("\n");
  assert.match(t, /attach_partial: failed to upload b\.png \(2 requested, some failed; /);
});
