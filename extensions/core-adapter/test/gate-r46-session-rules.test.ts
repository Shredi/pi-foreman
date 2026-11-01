// R46 session rules under the R41 gate (the old overlay no longer decides): a write to a Pi session file is a floor; moving the
// session dir or an ancestor up to {agentDir}/sessions is a self-modification ask (a child is denied, no model call, no dialog);
// the handoff identity file live.json is protected state; a child's `npm ci` is never a default allow.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { r11Rig, reviewAllowOpts } from "./_r11rig.ts";
import { shPath } from "./_shpath.ts";

type Rig = Awaited<ReturnType<typeof r11Rig>>;

/** A rig with a recording owner dialog (always a plain deny) and a session file under the agent sessions dir; `review` "allow" / "ask" is a reachable review model with that verdict. */
async function rig(t: Parameters<typeof r11Rig>[0], o: { child?: boolean; reviewAllows?: boolean; reviewAsks?: boolean } = {}) {
  const titles: string[] = [];
  const ui = { notify: () => undefined, confirm: async () => false, select: async (title: string) => (titles.push(title), "deny with reason"), input: async () => "not now", setStatus: () => undefined, setWidget: () => undefined };
  // r79 item 11: the review is the classifier now; an escalating one stands for the "asking review"
  const base: { ctx: Record<string, unknown>; config: Record<string, unknown> } = o.reviewAsks
    ? {
        ctx: { modelRegistry: { find: () => ({ id: "m" }), getProviderAuthStatus: () => ({ configured: false }), complete: async () => ({ content: [{ type: "text", text: JSON.stringify({ verdict: "escalate", entry: null, reason: "stub" }) }], stopReason: "stop", usage: { input: 1, output: 1 } }) } },
        config: { providers: { fake: { roles: { review: { model: "m" } } } } },
      }
    : reviewAllowOpts();
  const r = await r11Rig(t, {}, { ctx: { ...base.ctx, ui }, config: base.config, child: o.child });
  const sessions = path.join(r.agentDir, "sessions");
  const outer = path.join(sessions, "--proj--");
  const sessionDir = path.join(outer, "sub");
  fs.mkdirSync(path.join(sessionDir, "subagent-artifacts"), { recursive: true });
  const file = path.join(sessionDir, "2026-01-01T00-00-00_abc.jsonl");
  fs.writeFileSync(file, "{}\n");
  (r.ctx.sessionManager as { getSessionFile: () => string }).getSessionFile = () => file;
  return { ...r, titles, sessions, outer, sessionDir, file };
}

const blockedCall = async (r: Rig, tool: string, input: Record<string, unknown>): Promise<string | null> => {
  const res = await r.call(tool, input);
  return res && res.block ? (res.reason ?? "blocked") : null;
};

for (const child of [false, true]) {
  const who = child ? "child" : "foreman";

  test(`${who}: a write to a session .jsonl is denied by a floor, in every form`, async (t) => {
    const r = await rig(t, { child, reviewAllows: true });
    const other = path.join(r.outer, "other-session", "2026-02-02T00-00-00_def.jsonl");
    // a child that meets the same refusal twice is stopped, and the refusal clips the path at 120 characters: every form
    // names a file under its own short dir, the session's own files get one write each
    let n = 0;
    const forms: ((f: string) => [string, Record<string, unknown>])[] = [
      (f) => ["write", { path: f, content: "x" }],
      (f) => ["edit", { path: f, edits: [{ oldText: "{}", newText: "[]" }] }],
      (f) => ["bash", { command: `echo x > ${shPath(f)}` }],
      (f) => ["bash", { command: `echo x >> ${shPath(f)}` }],
      (f) => ["bash", { command: `cp ${shPath(r.project)}/a.jsonl ${shPath(f)}` }],
      (f) => ["bash", { command: `mv ${shPath(r.project)}/a.jsonl ${shPath(f)}` }],
      (f) => ["bash", { command: `tee ${shPath(f)}` }],
      (f) => ["foreman_move", { src: path.join(r.project, "a.jsonl"), dst: f }],
      (f) => ["foreman_copy", { src: path.join(r.project, "a.jsonl"), dst: f }],
    ];
    const files = [...forms.map((form) => form(path.join(r.sessions, `--e${++n}--`, "x.jsonl"))), forms[0](r.file), forms[0](other), forms[2](r.file), forms[2](other)];
    for (const [tool, input] of files) {
      const why = await blockedCall(r, tool, input);
      assert.match(why ?? "", /permission floor/, `${who}: ${tool} ${JSON.stringify(input)}`);
    }
    assert.deepEqual(r.titles, [], "a floor never opens a dialog");
  });

  test(`${who}: reading a session file and writing other files below the session dir are not the floor`, async (t) => {
    const r = await rig(t, { child, reviewAllows: true });
    for (const [tool, input] of [
      ["bash", { command: `cat ${shPath(r.file)}` }],
      ["bash", { command: `cp ${shPath(r.file)} ${shPath(r.project)}/copy.jsonl` }],
      ["write", { path: path.join(r.sessionDir, "subagent-artifacts", "run1_output.md"), content: "x" }],
    ] as [string, Record<string, unknown>][]) {
      const res = await r.call(tool, input);
      assert.doesNotMatch(String(res?.reason ?? ""), /permission floor \(policy-file\)/, `${who}: ${tool} ${JSON.stringify(input)}`);
    }
  });

  test(`${who}: moving the session dir or an ancestor up to sessions is a self-modification ask, never a model call`, async (t) => {
    const r = await rig(t, { child, reviewAllows: true });
    let moves = 0;
    for (const dir of [r.sessionDir, r.outer, r.sessions]) {
      const calls: [string, Record<string, unknown>][] = [
        ["bash", { command: `mv ${shPath(dir)} ${shPath(dir)}.old` }],
        ["bash", { command: `mv ${shPath(dir)} ${shPath(path.join(r.project, "elsewhere"))}` }],
        ["foreman_move", { src: dir, dst: `${dir}.old` }],
        ["foreman_move", { src: dir, dst: path.join(r.project, "elsewhere") }],
      ];
      for (const [tool, input] of calls) {
        const dialogs = r.titles.length;
        const why = await blockedCall(r, tool, input);
        assert.ok(why, `${who}: ${tool} ${JSON.stringify(input)} was allowed`);
        // ruling-10: the foreman's bash mv into the project is a shell write its edit mode refuses, so it gets the refusal before any dialog; a mv
        // that stays outside the workspace and foreman_move are not refused and still ask
        if (!child && tool === "bash" && String(input.command).includes(shPath(r.project))) {
          assert.match(why, /shell write into project files refused/, `${who}: ${tool} ${JSON.stringify(input)}`);
          continue;
        }
        moves++;
        if (child) assert.match(why, /selfmod-session-dir/, `${who}: ${tool} ${JSON.stringify(input)}`);
        else {
          assert.equal(r.titles.length, dialogs + 1, `${who}: ${tool} ${JSON.stringify(input)} opened one dialog`);
          assert.match(r.titles.at(-1) ?? "", /selfmod-session-dir/, `${who}: ${tool} ${JSON.stringify(input)}`);
        }
      }
    }
    assert.equal(r.titles.length, child ? 0 : moves, child ? "a child never gets a dialog" : "the owner pane dialog opened once per move");
  });

  test(`${who}: a write below the session dir, or to a sibling session dir, is not the session-dir ask`, async (t) => {
    const r = await rig(t, { child });
    for (const [tool, input] of [
      ["foreman_move", { src: path.join(r.sessionDir, "x.md"), dst: path.join(r.sessionDir, "y.md") }],
      ["foreman_move", { src: path.join(r.outer, "other-session"), dst: path.join(r.outer, "other-session.old") }],
    ] as [string, Record<string, unknown>][]) {
      const why = await blockedCall(r, tool, input);
      assert.doesNotMatch(why ?? "", /selfmod-session-dir/, `${who}: ${tool} ${JSON.stringify(input)}`);
    }
  });

  test(`${who}: writing the handoff identity file live.json asks the foreman and is denied for a child`, async (t) => {
    const r = await rig(t, { child, reviewAllows: true });
    const live = path.join(r.agentDir, "pi-foreman", "handoffs", "h1", "live.json");
    fs.mkdirSync(path.dirname(live), { recursive: true });
    const before = r.titles.length;
    for (const [tool, input] of [
      ["write", { path: live, content: "{}" }],
      ["bash", { command: `echo {} > ${shPath(live)}` }],
    ] as [string, Record<string, unknown>][]) {
      const why = await blockedCall(r, tool, input);
      assert.ok(why, `${who}: ${tool} ${JSON.stringify(input)} was allowed`);
    }
    assert.equal(r.titles.length - before, child ? 0 : 2);
  });
}

test("a child's npm ci is not a default allow: an unreachable or escalating classifier denies it", async (t) => {
  for (const o of [{}, { reviewAsks: true }]) {
    const r = await rig(t, { child: true, ...o });
    const res = await r.call("bash", { command: "npm ci" });
    const guard = r.events("guard").filter((g) => g.guard === "gate");
    const last = guard[guard.length - 1];
    assert.ok(!(last && last.decision === "allowed" && String(last.rule).startsWith("default-")), `a default allowed it: ${JSON.stringify(last)}`);
    assert.ok(res && res.block, `an unreachable or asking review denies a child's npm ci ${JSON.stringify(o)}`);
    assert.deepEqual(r.titles, []);
  }
});
