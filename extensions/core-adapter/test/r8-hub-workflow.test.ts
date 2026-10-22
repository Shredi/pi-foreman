// R8 item 14: paths.hubWorkflow makes the hub's `.workflow/` family readable (read only) for the foreman and its children.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildOverlayRules, checkToolCall, readBaseline } from "../permoverlay.ts";
import type { MatchCtx, OverlayRules } from "../permoverlay.ts";
import { ForemanReview } from "../review.ts";
import type { RegistryLike, ReviewSession } from "../review.ts";
import { bashRules } from "../timeoutallow.ts";
import { hubWorkflowDirs, hubWorkflowReadable } from "../roundsurface.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";
import { bashPath } from "./_bashpath.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const baseline = readBaseline(PKG)!;
const w = fs.realpathSync(mkTestTmp("pf-hubwf-"));
after(() => rmTestTmp(w));
const ws = path.join(w, "repo.worktrees", "r8");
const hub = path.join(w, "hub");
const sibling = path.join(w, "sibling");
const home = path.join(w, "home");
const ag = path.join(home, ".pi", "agent");
for (const d of [ws, path.join(hub, ".workflow"), path.join(sibling, ".workflow"), ag]) fs.mkdirSync(d, { recursive: true });
if (process.platform !== "win32") execFileSync("git", ["init", "-q", ws], { stdio: "ignore" });
const rules: OverlayRules = buildOverlayRules(baseline, {}, {}, ag, ws, undefined, false);
const ctx = (role: "main" | "child", cfg: unknown): MatchCtx => ({ cwd: ws, home, platform: process.platform, role, readable: hubWorkflowReadable(cfg) });
const kind = (role: "main" | "child", cfg: unknown, tool: string, input: Record<string, unknown>): string => checkToolCall(rules, tool, input, ctx(role, cfg))?.kind ?? "pass";

test("hubWorkflowDirs: string or list, relative, .. and root entries dropped, empty default", () => {
  assert.deepEqual(hubWorkflowDirs(undefined), []);
  assert.deepEqual(hubWorkflowDirs([]), []);
  // the expectation is the host's resolution of the input ("/h" is D:\h on a Windows runner), not a POSIX literal
  const wf = (p: string): string => path.join(path.resolve(p), ".workflow");
  assert.deepEqual(hubWorkflowDirs("/h"), [wf("/h")]);
  assert.deepEqual(hubWorkflowDirs(["/a", "rel", "/x/../y", "/", 5]), [wf("/a")]);
});

test("hubWorkflowDirs on an injected platform: the platform's own resolution, .. and root entries dropped", () => {
  for (const [platform, x] of [["linux", path.posix], ["win32", path.win32]] as const) {
    const wf = (p: string): string => x.join(x.resolve(p), ".workflow");
    assert.deepEqual(hubWorkflowDirs("/h", platform), [wf("/h")], platform);
    assert.deepEqual(hubWorkflowDirs(["/a", "rel", "/x/../y", "/", 5], platform), [wf("/a")], platform);
  }
  const drive = path.win32.join("D:", "h");
  assert.deepEqual(hubWorkflowDirs([drive, "D:rel", path.win32.parse(drive).root], "win32"), [path.win32.join(drive, ".workflow")]);
});

test("hub .workflow is readable by the read tool and read-only bash for main and child", () => {
  for (const role of ["main", "child"] as const) {
    assert.equal(kind(role, [hub], "read", { path: path.join(hub, ".workflow", "LEDGER.md") }), "pass", role);
    assert.equal(kind(role, [hub], "bash", { command: `cat ${bashPath(hub)}/.workflow/LEDGER.md` }), "pass", role);
    assert.equal(kind(role, hub, "bash", { command: `grep -n item ${bashPath(hub)}/.workflow/LEDGER.md | head` }), "pass", role);
  }
});

const posix = process.platform !== "win32";
const DEFER = '{"verdict":"defer","reason":"outside the workspace"}';
const registry = { find: () => ({}), complete: async () => ({ content: [{ type: "text", text: DEFER }], stopReason: "stop" }) } as never as RegistryLike;
const reviewSession = (hubCfg: unknown): ReviewSession => ({ isChild: false, cwd: ws, provider: "a", config: () => ({ providers: { a: { review: { model: "a/small", timeoutMs: 500 } } }, paths: { hubWorkflow: hubCfg } }), registry, intent: "", bashRules: () => bashRules(baseline, {}), ownedRoots: () => [path.join(w, "scratch")], readOnlyRoots: () => [], roundDirs: () => [ws], childDefer: () => "owner" });
const ask = (command: string, n: number) => ({ requestId: `h${n}`, surface: "bash", command, forwarding: true, agentName: "reviewer" });

test("review: a forwarded child's bash read of the configured hub ledger is allowed, a write and an unconfigured sibling defer", { skip: !posix }, async () => {
  const on = new ForemanReview();
  on.upsert("s", reviewSession([hub]));
  assert.deepEqual(await on.authorize("s", ask(`cat ${hub}/.workflow/LEDGER.md`, 1)), { kind: "allow" });
  assert.deepEqual(await on.authorize("s", ask(`touch ${hub}/.workflow/LEDGER.md`, 2)), { kind: "defer" });
  assert.deepEqual(await on.authorize("s", ask(`cat ${sibling}/.workflow/LEDGER.md`, 3)), { kind: "defer" });
  const off = new ForemanReview();
  off.upsert("s", reviewSession([]));
  assert.deepEqual(await off.authorize("s", ask(`cat ${hub}/.workflow/LEDGER.md`, 4)), { kind: "defer" });
});

test("hub .workflow stays read-only: a write or a redirect into it is not allowed", () => {
  for (const role of ["main", "child"] as const) {
    // the overlay's verdict on a write is the same with and without the key: the key adds read patterns only
    for (const [tool, input] of [["bash", { command: `cp x ${hub}/.workflow/LEDGER.md` }], ["bash", { command: `echo x > ${hub}/.workflow/LEDGER.md` }], ["bash", { command: `tee ${hub}/.workflow/LEDGER.md` }], ["write", { path: path.join(hub, ".workflow", "LEDGER.md") }]] as const)
      assert.equal(kind(role, [hub], tool, input), kind(role, [], tool, input), `${role} ${tool} ${JSON.stringify(input)}`);
  }
});

test("non-tmp hub: .workflow is readable for main and child, a write or redirect into it is not allowed", () => {
  // mkTestTmp guarantees w is not below /tmp (it falls back to ~/.cache/pi-foreman-tests); assert it, on POSIX
  if (posix) assert.ok(w !== "/tmp" && !w.startsWith("/tmp/"), `fixture under /tmp: ${w}`);
  const nonTmpHub = path.join(w, "nontmp", "hub2");
  fs.mkdirSync(path.join(nonTmpHub, ".workflow"), { recursive: true });
  const led = path.join(nonTmpHub, ".workflow", "LEDGER.md");
  for (const role of ["main", "child"] as const) {
    assert.equal(kind(role, [nonTmpHub], "read", { path: led }), "pass", role);
    assert.equal(kind(role, [nonTmpHub], "bash", { command: `cat ${bashPath(led)}` }), "pass", role);
    for (const [tool, input] of [["bash", { command: `cp x ${bashPath(led)}` }], ["bash", { command: `echo x > ${bashPath(led)}` }], ["write", { path: led }]] as const) {
      // "pass" is the overlay having no opinion (the permission layer then asks); the key must add no write allowance
      assert.equal(kind(role, [nonTmpHub], tool, input), kind(role, [], tool, input), `${role} ${tool}`);
    }
  }
});

test("an unconfigured sibling .workflow and an empty default behave as without the key", () => {
  for (const role of ["main", "child"] as const) {
    const without = (cmd: string) => kind(role, [], "bash", { command: cmd });
    const withHub = (cmd: string) => kind(role, [hub], "bash", { command: cmd });
    const sib = `cat ${sibling}/.workflow/LEDGER.md`;
    assert.equal(withHub(sib), without(sib), role);
    assert.equal(kind(role, [hub], "read", { path: path.join(sibling, ".workflow", "L.md") }), kind(role, [], "read", { path: path.join(sibling, ".workflow", "L.md") }), role);
    const own = `cat ${hub}/.workflow/LEDGER.md`;
    assert.equal(without(own), kind(role, undefined, "bash", { command: own }), role);
  }
});
