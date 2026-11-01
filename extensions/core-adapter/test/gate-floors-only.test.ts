// r79 items 2, 3, 11: the r76 key gate.mode "floors-only" is retired and now means permissions mode `allow`: the floors (and self-modification,
// deny and ask rules) still apply, everything else runs with no classifier call and no dialog. "full" is mode auto. Push floors read parsed
// `git push` segments only; an unparsed line is danger-opaque, which mode allow runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { r11Rig } from "./_r11rig.ts";
import { gateLogFile } from "../gatelog.ts";

const ESCALATE = JSON.stringify({ verdict: "escalate", entry: null, reason: "unsure" });
const INSTALL = "pip install requests";
const NOMATCH = "terraform plan";

async function rig(t: Parameters<typeof r11Rig>[0], mode: "full" | "floors-only", o: { child?: boolean } = {}) {
  const counts = { review: 0, selects: 0 };
  const notices: string[] = [];
  const registry = {
    find: () => ({ id: "m" }),
    getProviderAuthStatus: () => ({ configured: false }),
    complete: async () => {
      counts.review++;
      return { content: [{ type: "text", text: ESCALATE }], stopReason: "stop", usage: { input: 1, output: 1 } };
    },
  };
  const ui = { notify: (m: string) => void notices.push(m), confirm: async () => false, select: async () => (counts.selects++, undefined), input: async () => undefined, setStatus: () => undefined, setWidget: () => undefined };
  const r = await r11Rig(t, {}, { ctx: { modelRegistry: registry, ui }, config: { presence: { enabled: false }, gate: { mode }, providers: { fake: { review: { model: "m" }, roles: {} } } }, child: o.child });
  const log = (): Record<string, unknown>[] => {
    const f = gateLogFile(r.agentDir);
    return fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : [];
  };
  return { ...r, counts, notices, log };
}

test("floors-only: the floors still deny", async (t) => {
  const r = await rig(t, "floors-only");
  for (const command of ["cat ~/.ssh/id_rsa", "git push origin main"]) {
    const res = await r.call("bash", { command });
    assert.equal(res?.block, true, command);
    assert.match(String(res?.reason), /denied by the permission floor/, command);
  }
  const w = await r.call("write", { path: `${r.project}/.git/config`, content: "x" });
  assert.equal(w?.block, true);
  assert.match(String(w?.reason), /denied by the permission floor/);
  assert.equal(r.counts.review, 0);
  assert.equal(r.counts.selects, 0);
});

test("floors-only: a child's push is still a floor deny", async (t) => {
  const r = await rig(t, "floors-only", { child: true });
  const res = await r.call("bash", { command: "git push origin feature/x" });
  assert.equal(res?.block, true);
  assert.match(String(res?.reason), /denied by the permission floor/);
});

test("floors-only: a dangerous line and a no-rule line both run, with no classifier call and no dialog", async (t) => {
  const r = await rig(t, "floors-only");
  for (const command of [INSTALL, NOMATCH]) assert.equal(await r.call("bash", { command }), undefined, command);
  assert.equal(r.counts.review, 0);
  assert.equal(r.counts.selects, 0);
  const modes = r.log().filter((e) => e.layer === "mode");
  assert.equal(modes.length, 2, JSON.stringify(r.log()));
  for (const e of modes) assert.equal(e.verdict, "allow");
});

// item 3: only parsed `git push` segments count; text that merely mentions a push is no push
test("floors-only: a push that only appears inside text is not a push floor", async (t) => {
  const r = await rig(t, "floors-only");
  for (const command of [`echo "git push origin main"`, `grep -n 'git push' README.md`]) {
    assert.equal(await r.call("bash", { command }), undefined, command);
  }
});

test("floors-only: a child's ordinary line runs too", async (t) => {
  const r = await rig(t, "floors-only", { child: true });
  assert.equal(await r.call("bash", { command: NOMATCH }), undefined);
  assert.equal(r.counts.review, 0);
});

test("floors-only: a deterministic default keeps its own rule", async (t) => {
  const r = await rig(t, "floors-only");
  assert.equal(await r.call("bash", { command: "git status" }), undefined);
  assert.ok(r.log().some((e) => e.rule === "default-git-read"), JSON.stringify(r.log()));
});

test("floors-only: the retired-key notice is shown", async (t) => {
  const r = await rig(t, "floors-only");
  assert.ok(r.notices.some((n) => /"floors-only" is retired and now means permissions mode allow/.test(n)), JSON.stringify(r.notices));
});

test("full: a dangerous line still goes to the classifier path (an unanswered dialog denies), and there is no notice", async (t) => {
  const r = await rig(t, "full");
  assert.ok(!r.notices.some((n) => /floors-only/.test(n)));
  const res = await r.call("bash", { command: INSTALL });
  assert.equal(res?.block, true);
  assert.ok(r.counts.selects >= 1);
  assert.equal(await r.call("bash", { command: NOMATCH }), undefined, "an unmatched, non-dangerous line runs under auto");
});
