// gate.mode "floors-only" (r76, temporary): the floors still deny, every other gate outcome is an allow with no review call,
// no dialog and no ask.md; "full" is unchanged for the same line.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { r11Rig } from "./_r11rig.ts";
import { gateLogFile } from "../gatelog.ts";

const ASK = JSON.stringify({ verdict: "ask", entry: "inline-interpreter", reason: "because inline" });
const INLINE = `python3 -c "print(1)"`;
const NOMATCH = "terraform plan";

async function rig(t: Parameters<typeof r11Rig>[0], mode: "full" | "floors-only", o: { child?: boolean } = {}) {
  const counts = { review: 0, selects: 0 };
  const notices: string[] = [];
  const registry = {
    find: () => ({ id: "m" }),
    getProviderAuthStatus: () => ({ configured: false }),
    complete: async () => {
      counts.review++;
      return { content: [{ type: "text", text: ASK }], stopReason: "stop", usage: { input: 1, output: 1 } };
    },
  };
  const ui = { notify: (m: string) => void notices.push(m), confirm: async () => false, select: async () => (counts.selects++, undefined), input: async () => undefined, setStatus: () => undefined, setWidget: () => undefined };
  const r = await r11Rig(t, {}, { ctx: { modelRegistry: registry, ui }, config: { gate: { mode }, providers: { fake: { review: { model: "m" }, roles: {} } } }, child: o.child });
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

test("floors-only: a bare git push is denied as floors-only-push", async (t) => {
  const r = await rig(t, "floors-only");
  for (const command of ["git push", "git push --no-verify origin HEAD", "git -C /tmp/x push"]) {
    const res = await r.call("bash", { command });
    assert.equal(res?.block, true, command);
  }
  const d = r.log().filter((e) => e.rule === "floors-only-push");
  assert.ok(d.length >= 1, JSON.stringify(r.log()));
  assert.deepEqual([d[0].layer, d[0].verdict], ["floor", "deny"]);
  assert.equal(r.counts.review, 0);
});

test("floors-only: an inline interpreter and a no-matching-entry line are allowed with no review and no dialog", async (t) => {
  const r = await rig(t, "floors-only");
  for (const command of [INLINE, NOMATCH]) {
    const res = await r.call("bash", { command });
    assert.equal(res, undefined, command);
  }
  assert.equal(r.counts.review, 0);
  assert.equal(r.counts.selects, 0);
  const allows = r.log().filter((e) => e.rule === "floors-only");
  assert.equal(allows.length, 2, JSON.stringify(r.log()));
  for (const e of allows) assert.deepEqual([e.layer, e.verdict], ["default", "allow"]);
  assert.ok(r.events("guard").some((e) => e.guard === "gate" && e.decision === "allowed" && e.rule === "floors-only"));
});

test("floors-only: a child's ask is allowed too, without ask.md", async (t) => {
  const r = await rig(t, "floors-only", { child: true });
  const res = await r.call("bash", { command: NOMATCH });
  assert.equal(res, undefined);
  assert.equal(r.counts.review, 0);
});

test("floors-only: a deterministic default keeps its own rule", async (t) => {
  const r = await rig(t, "floors-only");
  assert.equal(await r.call("bash", { command: "git status" }), undefined);
  assert.ok(r.log().some((e) => e.rule === "default-git-read"), JSON.stringify(r.log()));
  assert.ok(!r.log().some((e) => e.rule === "floors-only"));
});

test("floors-only: the start notice is shown", async (t) => {
  const r = await rig(t, "floors-only");
  assert.ok(r.notices.some((n) => /floors-only mode \(gate\.mode\)/.test(n)), JSON.stringify(r.notices));
});

test("full: the same line still goes to review, and there is no notice", async (t) => {
  const r = await rig(t, "full");
  assert.ok(!r.notices.some((n) => /floors-only/.test(n)));
  const res = await r.call("bash", { command: INLINE });
  assert.equal(res?.block, true);
  assert.ok(r.counts.review >= 1 || r.counts.selects >= 1);
  assert.ok(!r.log().some((e) => e.rule === "floors-only"));
});
