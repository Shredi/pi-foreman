// r79 items 2, 3, 11, as PR C leaves them: there is no permissions mode. The floors (and self-modification) still deny; a call the judge-first list does not
// name runs with no classifier call and no dialog; a leftover `gate.mode` key (the retired "floors-only" or "full") changes nothing. Push floors read parsed
// `git push` segments only.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { r11Rig } from "./_r11rig.ts";
import { gateLogFile } from "../gatelog.ts";

const OWNER = JSON.stringify({ verdict: "owner", class: "data-loss", reason: "cannot tell" });
const INSTALL = "pip install requests";
const NOMATCH = "terraform plan";
const JUDGE_FIRST_LINE = "git branch -D old-branch";

/** `mode`: a leftover `gate.mode` key in the config (it must change nothing). */
async function rig(t: Parameters<typeof r11Rig>[0], mode: "full" | "floors-only", o: { child?: boolean; reply?: string } = {}) {
  const counts = { review: 0, selects: 0 };
  const notices: string[] = [];
  const registry = {
    find: () => ({ id: "m" }),
    getProviderAuthStatus: () => ({ configured: false }),
    complete: async () => {
      counts.review++;
      return { content: [{ type: "text", text: o.reply ?? OWNER }], stopReason: "stop", usage: { input: 1, output: 1 } };
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

for (const mode of ["floors-only", "full"] as const) {
  test(`${mode} (a leftover gate.mode key): the floors still deny`, async (t) => {
    const r = await rig(t, mode);
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

  test(`${mode}: a call off the judge-first list runs with no classifier call and no dialog`, async (t) => {
    const r = await rig(t, mode);
    for (const command of [INSTALL, NOMATCH]) assert.equal(await r.call("bash", { command }), undefined, command);
    assert.equal(r.counts.review, 0);
    assert.equal(r.counts.selects, 0);
  });

  test(`${mode}: a judge-first line goes to the judge and, owner and unanswered, is denied; the gate.mode key does not skip it`, async (t) => {
    const r = await rig(t, mode);
    const res = await r.call("bash", { command: JUDGE_FIRST_LINE });
    assert.equal(res?.block, true);
    assert.equal(r.counts.review, 1);
    assert.ok(r.counts.selects >= 1);
    assert.equal(await r.call("bash", { command: NOMATCH }), undefined, "an unmatched line runs");
  });
}

test("floors-only: a child's push is still a floor deny", async (t) => {
  const r = await rig(t, "floors-only", { child: true });
  const res = await r.call("bash", { command: "git push origin feature/x" });
  assert.equal(res?.block, true);
  assert.match(String(res?.reason), /denied by the permission floor/);
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

test("a leftover gate.mode key gives no notice at the gate", async (t) => {
  for (const mode of ["floors-only", "full"] as const) {
    const r = await rig(t, mode);
    assert.ok(!r.notices.some((n) => /floors-only|permissions mode/.test(n)), JSON.stringify(r.notices));
  }
});

test("a judge-first line whose judge answers unsure is refused: no dialog opens", async (t) => {
  for (const mode of ["floors-only", "full"] as const) {
    const r = await rig(t, mode, { reply: JSON.stringify({ verdict: "unsure", reason: "cannot tell" }) });
    const res = await r.call("bash", { command: JUDGE_FIRST_LINE });
    assert.equal(res?.block, true, mode);
    assert.match(String(res?.reason), /^pi-foreman: refused: /, mode);
    assert.equal(r.counts.review, 1, mode);
    assert.equal(r.counts.selects, 0, mode);
  }
});
