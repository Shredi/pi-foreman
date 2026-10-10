// Child scratch (retro-harvest item 5): create, record, remove at run end, keep, refused removals,
// and the guard allowances inside the dir (overlay cd, review link, timeoutallow).
import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ChildScratch, createScratch, expandScratchVar, finishScratch, insideScratch, launchScratch, removeScratch, scratchCommandAllowed, scratchRoot, storeBrief, sweepScratch } from "../childscratch.ts";
import type { ScratchHost } from "../childscratch.ts";
import { buildOverlayRules, checkToolCall, readBaseline } from "../permoverlay.ts";
import { deterministicAllow } from "../timeoutallow.ts";
import { readBinding } from "../usage.ts";
import type { LaunchBinding } from "../usage.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-scratch-")));
const tmp = path.join(base, "tmp");
const repo = path.join(base, "repo");
fs.mkdirSync(tmp);
fs.mkdirSync(repo);
const deps = { tmpdir: () => tmp };
const posix = process.platform !== "win32";
after(() => fs.rmSync(base, { recursive: true, force: true }));

function host(keep = false): ScratchHost & { events: Record<string, unknown>[] } {
  const events: Record<string, unknown>[] = [];
  return { id: "sess-1", cwd: repo, config: { config: { ceremony: { childScratch: { keep } } } }, trace: { emit: (r) => events.push(r) }, scratch: new ChildScratch(), events };
}

const binding = (launchId: string, role = "reviewer"): LaunchBinding => ({ foremanSession: "sess-1", workspace: repo, role, launchId, kind: "first", model: null });

test("create: per-launch dir under <tmp>/pi-foreman-scratch/<session>/<launch>, 0700, fresh", () => {
  const dir = createScratch("sess-1", "L-a", deps)!;
  assert.equal(dir, path.join(scratchRoot(deps)!, "sess-1", "L-a"));
  assert.ok(fs.statSync(dir).isDirectory());
  if (posix) assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(createScratch("sess-1", "L-a", deps), null, "an existing dir is not reused");
});

test("launch: the dir goes into the binding (env of the child), the task and the session record", () => {
  const h = host();
  const input: Record<string, unknown> = { agent: "reviewer", task: "check it" };
  const b = binding("L-b");
  launchScratch(h, input, b, deps);
  assert.ok(b.scratch && fs.statSync(b.scratch).isDirectory());
  assert.match(String(input.task), /^check it\n\n\[pi-foreman scratch\] Your scratch dir: .*FOREMAN_SCRATCH/s);
  assert.deepEqual(h.scratch.live("reviewer"), [b.scratch]);
  assert.deepEqual(h.scratch.live("builder"), []);
  const env = { PI_SUBAGENT_EXTENSION_BINDINGS: JSON.stringify({ "pi-foreman/1": b }) };
  assert.equal(readBinding(env)?.scratch, b.scratch);
});

test("run end removes the dir after the child_scratch trace; a run that ended before its tool result too", () => {
  const h = host();
  const b = binding("L-c");
  launchScratch(h, {}, b, deps);
  fs.writeFileSync(path.join(b.scratch!, "a.txt"), "12345");
  fs.mkdirSync(path.join(b.scratch!, "sub"));
  fs.writeFileSync(path.join(b.scratch!, "sub", "b.txt"), "678");
  assert.equal(h.scratch.onLaunched("L-c", "run-c"), null);
  finishScratch(h, h.scratch.onRunEnd("run-c"), deps);
  assert.equal(fs.existsSync(b.scratch!), false);
  assert.deepEqual(h.events.at(-1), { event: "child_scratch", role: "reviewer", bytes: 8, files: 2, action: "removed" });
  const b2 = binding("L-d");
  launchScratch(h, {}, b2, deps);
  assert.equal(h.scratch.onRunEnd("run-d"), null);
  finishScratch(h, h.scratch.onLaunched("L-d", "run-d"), deps);
  assert.equal(fs.existsSync(b2.scratch!), false);
});

test("keep: the dir stays at run end and at shutdown", () => {
  const h = host(true);
  const b = binding("L-e");
  launchScratch(h, {}, b, deps);
  finishScratch(h, h.scratch.onLaunched("L-e", null), deps);
  sweepScratch(h, deps);
  assert.ok(fs.existsSync(b.scratch!));
  assert.equal(h.events.at(-1)?.action, "kept");
  const h2 = host();
  sweepScratch(h2, deps);
  assert.equal(fs.existsSync(path.dirname(b.scratch!)), false, "the shutdown sweep removes the session root");
});

test("removal is refused outside the root, for the repo and for a symlink leading out", () => {
  const outside = path.join(base, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "keep.txt"), "x");
  assert.deepEqual(removeScratch(outside, [repo], deps), { removed: false, reason: "outside_root" });
  assert.deepEqual(removeScratch(scratchRoot(deps)!, [repo], deps), { removed: false, reason: "outside_root" });
  const inRepo = createScratch("sess-2", "L-r", deps)!;
  assert.deepEqual(removeScratch(inRepo, [path.dirname(inRepo)], deps), { removed: false, reason: "repo" });
  if (posix) {
    const link = path.join(path.dirname(inRepo), "L-link");
    fs.symlinkSync(outside, link);
    assert.deepEqual(removeScratch(link, [repo], deps), { removed: false, reason: "not_dir" });
    // a symlink inside a scratch dir is removed, its target is not touched
    fs.symlinkSync(outside, path.join(inRepo, "out"));
    assert.deepEqual(removeScratch(inRepo, [repo], deps), { removed: true });
  }
  assert.ok(fs.existsSync(path.join(outside, "keep.txt")));
});

test("guards: cd, cp, mkdir and rm inside a live scratch dir only", { skip: !posix }, () => {
  const dir = createScratch("sess-3", "L-g", deps)!;
  const other = path.join(base, "repo");
  const rules = { allow: ["ls *", "cd *"], ask: [], deny: ["sudo *"] };
  const effects = { cwd: other, root: other, scratch: [dir] };
  const ok = (cmd: string): string | null => deterministicAllow(rules, cmd, { scratchDirs: [dir], effects });
  assert.equal(ok(`cp -R ${other} ${dir}/copy`), "child-scratch");
  assert.equal(ok(`cp -R ${base} ${dir}/copy`), null, "a cp source outside the worktree");
  assert.equal(ok(`mkdir -p ${dir}/a/b && rm -rf ${dir}/a`), "child-scratch");
  assert.equal(ok(`cd $FOREMAN_SCRATCH && ls -la`), "child-scratch");
  assert.equal(ok(`rm -rf ${dir}`), null, "not the dir itself");
  assert.equal(ok(`rm -rf ${dir}/../L-other`), null);
  assert.notEqual(ok(`cp a ${other}/x`), "child-scratch");
  assert.equal(ok(`rm -rf ${dir}/x | sh`), null);
  assert.notEqual(ok(`rm -rf '$FOREMAN_SCRATCH'/x`), "child-scratch", "single quotes keep the name literal");
  fs.symlinkSync(other, path.join(dir, "esc"));
  assert.equal(insideScratch(path.join(dir, "esc", "f"), [dir]), false, "a symlink inside cannot lead out");
  assert.equal(insideScratch(path.join(dir, ".?", ".?", "f"), [dir]), false, "a glob that bash could expand to .. is refused");
  assert.equal(scratchCommandAllowed(`rm -r ${dir}/esc/f`, [dir], () => false), false);
  assert.equal(expandScratchVar(`echo "\${FOREMAN_SCRATCH}/x" '$FOREMAN_SCRATCH'`, "/s"), `echo "/s/x" '$FOREMAN_SCRATCH'`);
  // overlay: a child may cd into its own scratch dir, not elsewhere outside the workspace
  const r = buildOverlayRules(readBaseline(PKG)!, {}, {}, path.join(base, "agent"));
  const cd = (command: string, scratch?: string): string => checkToolCall(r, "bash", { command }, { cwd: repo, home: base, platform: process.platform, role: "child", scratch })?.kind ?? "pass";
  assert.equal(cd(`cd ${dir} && ls`, dir), "pass");
  assert.equal(cd("cd $FOREMAN_SCRATCH && ls", dir), "pass");
  assert.equal(cd(`cd ${dir} && ls`), "deny");
  assert.equal(cd(`cd ${path.dirname(dir)} && ls`, dir), "deny");
});

test("storeBrief: the full explorer report is a file in a scratch dir every role may read without an ask", () => {
  const h = host();
  const text = "x".repeat(9000);
  const file = storeBrief(h, "run-1", text, deps)!;
  assert.equal(path.basename(file), "explorer-brief.md");
  assert.equal(fs.readFileSync(file, "utf8"), text);
  for (const role of ["builder", "reviewer"]) assert.equal(insideScratch(file, h.scratch.live(role)), true, role);
  assert.equal(insideScratch(path.join(repo, "x.md"), h.scratch.live("builder")), false);
  finishScratch(h, "no-such-launch", deps);
  assert.ok(fs.existsSync(file));
});
