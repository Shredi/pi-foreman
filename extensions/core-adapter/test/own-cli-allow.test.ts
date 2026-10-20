// R19 item 1: ForemanReview.authorize allows the session's own `<root>/bin/foreman` with a read-only or launch-only verb without the model.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";
import { readBaseline } from "../permoverlay.ts";
import { bashRules } from "../timeoutallow.ts";
import { ForemanReview } from "../review.ts";
import type { RegistryLike } from "../review.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const posix = process.platform !== "win32";
const w = fs.realpathSync(mkTestTmp("pf-owncli-"));
after(() => rmTestTmp(w));

const root = path.join(w, "root");
const foreign = path.join(w, "foreign");
const outside = path.join(w, "outside");
for (const d of [path.join(root, "bin"), path.join(foreign, "bin"), outside, path.join(w, "ws")]) fs.mkdirSync(d, { recursive: true });
for (const f of [path.join(root, "bin", "foreman"), path.join(foreign, "bin", "foreman"), path.join(outside, "foreman")]) fs.writeFileSync(f, "#!/bin/sh\n", { mode: 0o755 });
const linkRoot = path.join(w, "linkroot");
fs.mkdirSync(path.join(linkRoot, "bin"), { recursive: true });
fs.symlinkSync(path.join(outside, "foreman"), path.join(linkRoot, "bin", "foreman"));
const ownBin = path.join(root, "bin", "foreman");
const baseline = readBaseline(PKG)!;

const noModel: RegistryLike = { find: () => { throw new Error("model called"); }, complete: async () => ({}) };

async function run(value: string, opts: { child?: boolean; forwarding?: boolean; ask?: string[]; root?: string } = {}): Promise<{ kind: string; traces: Array<Record<string, unknown>> }> {
  const traces: Array<Record<string, unknown>> = [];
  const cfg = opts.ask ? { safety: { permissions: { ask: opts.ask } } } : {};
  const r = new ForemanReview();
  r.upsert("s", {
    isChild: opts.child === true, cwd: path.join(w, "ws"), provider: "a", config: () => cfg, registry: noModel, intent: "",
    trace: (t) => traces.push(t), bashRules: () => bashRules(baseline, cfg), foremanRoot: () => opts.root ?? root,
  });
  const v = await r.authorize("s", { requestId: "r", surface: "bash", agentName: "foreman", value, toolName: "bash", ...(opts.forwarding ? { forwarding: true } : {}) });
  return { kind: v.kind, traces };
}

test("own_cli_session_open_allowed_with_trace_and_no_model", { skip: !posix }, async () => {
  const { kind, traces } = await run(`${ownBin} session open r19 "do the thing" --plan-first`);
  assert.equal(kind, "allow");
  assert.ok(traces.some((t) => t.event === "overlay_allow" && t.rule === "own_cli"));
});

test("own_cli_other_read_verbs_allowed", { skip: !posix }, async () => {
  for (const v of ["findings list --json", "session list --json", "session brief x hello", "dialogs --json", "dialogs trace.jsonl"]) assert.equal((await run(`${ownBin} ${v}`)).kind, "allow", v);
});

test("own_cli_session_open_other_cwd_allowed_residual", { skip: !posix }, async () => {
  assert.equal((await run(`${ownBin} session open r19 brief --cwd ${outside}`)).kind, "allow");
});

test("own_cli_not_allowed_forms", { skip: !posix }, async () => {
  const bad = [
    `${foreign}/bin/foreman session open a b`,
    `${ownBin} session open a b && rm -rf x`,
    `${ownBin} session list; ls`,
    `${ownBin} session list | cat`,
    `${ownBin} session list > f`,
    `${ownBin} session list &`,
    `${ownBin} session open a "$(id)"`,
    `${ownBin} session open a $HOME`,
    `${ownBin} session open a *`,
    `FOO=1 ${ownBin} session list`,
    `${root}/bin/../bin/foreman session list`,
    `${ownBin} setup`,
    `${ownBin} config get x`,
    `${ownBin} findings dismiss x`,
    `${ownBin} findings record`,
    `${ownBin} findings export x`,
    `${ownBin} close`,
    `${ownBin} worktree add x`,
    `${ownBin} sync`,
    `${ownBin} retro`,
    `${ownBin} backlog`,
    `${ownBin} bench`,
    `${ownBin} radar`,
    `${ownBin} update-check`,
    `${ownBin} session`,
  ];
  for (const v of bad) {
    const r = await run(v).catch((e: Error) => ({ kind: `threw ${e.message}`, traces: [] }));
    assert.notEqual(r.kind, "allow", v);
  }
});

test("own_cli_symlink_out_of_root_not_allowed", { skip: !posix }, async () => {
  assert.notEqual((await run(`${path.join(linkRoot, "bin", "foreman")} session list`, { root: linkRoot })).kind, "allow");
});

test("own_cli_user_ask_rule_not_allowed", { skip: !posix }, async () => {
  assert.notEqual((await run(`${ownBin} session list`, { ask: [`${ownBin} *`] })).kind, "allow");
});

test("own_cli_forwarded_and_child_asks_not_allowed", { skip: !posix }, async () => {
  assert.notEqual((await run(`${ownBin} session list`, { forwarding: true })).kind, "allow");
  assert.notEqual((await run(`${ownBin} session list`, { child: true })).kind, "allow");
});
