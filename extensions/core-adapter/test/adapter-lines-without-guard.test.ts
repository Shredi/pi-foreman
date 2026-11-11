// The adapter's real tool_call handler (rig `_r11rig.ts`, a fake pi) after the git guard's removal: unreadable and false-alarm lines go to the mode
// step as dangerous class (the classifier stub is asked once, answers allow, no dialog opens, no guard text in the trace), `git commit` is not
// affected by `safety.git.commit.*`, and a child's heredoc write is floored outside its own worktree and runs inside it (drop of the child heredoc deny).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { r11Rig, RIG_PERMISSIONS } from "./_r11rig.ts";
import { BINDINGS_ENV, BINDING_NS } from "../usage.ts";

type T = Parameters<typeof r11Rig>[0];
const posix = process.platform !== "win32";
const ALLOW = JSON.stringify({ verdict: "allow", entry: "A1", reason: "stub" });
const ROLES = ["explorer", "builder", "reviewer"];
const GUARD = /git[ -]?guard/i;

/** A rig for the main session or a child (binding + FOREMAN_CHECKOUT), the classifier stub counting its calls, the owner dialogs counted. */
async function rig(t: T, kind: "main" | "child", extra: { config?: Record<string, unknown> } = {}) {
  const saved = { b: process.env[BINDINGS_ENV], c: process.env.FOREMAN_CHECKOUT };
  t.after(() => {
    if (saved.b === undefined) delete process.env[BINDINGS_ENV];
    else process.env[BINDINGS_ENV] = saved.b;
    if (saved.c === undefined) delete process.env.FOREMAN_CHECKOUT;
    else process.env.FOREMAN_CHECKOUT = saved.c;
  });
  if (kind === "child") {
    process.env[BINDINGS_ENV] = JSON.stringify({ [BINDING_NS]: { foremanSession: "parent-session", role: "builder", launchId: "l1", kind: "first", workspace: "", perms: { mode: "auto", childDeny: true } } });
    delete process.env.FOREMAN_CHECKOUT;
  } else {
    delete process.env[BINDINGS_ENV];
    delete process.env.FOREMAN_CHECKOUT;
  }
  let classifier = 0;
  let dialogs = 0;
  const modelRegistry = { find: () => ({ id: "m" }), getProviderAuthStatus: () => ({ configured: false }), complete: async () => { classifier++; return { content: [{ type: "text", text: ALLOW }], stopReason: "stop", usage: { input: 1, output: 1 } }; } };
  const ui = { notify: () => undefined, confirm: async () => { dialogs++; return false; }, select: async () => { dialogs++; return "approve"; }, setStatus: () => undefined, setWidget: () => undefined };
  const config = { presence: { enabled: false }, providers: { fake: { review: { model: "m" }, roles: Object.fromEntries(ROLES.map((r) => [r, { model: `fake/${r}` }])) } }, ...extra.config };
  const perms = { mode: "auto", allow: ["Write", "Edit"], classifier: { allow: ["Anything at all."] } };
  const c = await r11Rig(t, {}, { ctx: { modelRegistry, ui, [RIG_PERMISSIONS]: perms }, config, child: kind === "child" });
  /** The foreman's checkout as the launch binding names it (read at each call): a sibling dir of the rig's project. */
  const checkout = path.join(c.project, "..", "main");
  const setCheckout = (): string => (process.env.FOREMAN_CHECKOUT = checkout);
  return { c, checkout, setCheckout, classifier: () => classifier, dialogs: () => dialogs };
}

for (const kind of ["main", "child"] as const) {
  test(`${kind}: sh -c "$X" and python3 -c naming git are handed to the classifier as dangerous class; no dialog, no guard text anywhere`, { skip: !posix }, async (t: T) => {
    const r = await rig(t, kind);
    let asked = 0;
    for (const command of ['sh -c "$X"', "python3 -c \"import subprocess; subprocess.run(['git','status'])\""]) {
      const res = await r.c.call("bash", { command });
      assert.ok(!res?.block, `${command}: ${JSON.stringify(res)}`);
      asked++;
      assert.equal(r.classifier(), asked, `${command}: the mode step (classifier) decided`);
    }
    assert.equal(r.dialogs(), 0);
    assert.doesNotMatch(JSON.stringify(r.c.trace()), GUARD);
  });

  test(`${kind}: the false-alarm line echo "wall $(( $(date +%s) - start ))s"; ls runs with a classifier answering allow, and no dialog opens`, { skip: !posix }, async (t: T) => {
    const r = await rig(t, kind);
    const res = await r.c.call("bash", { command: 'echo "wall $(( $(date +%s) - start ))s"; ls' });
    assert.ok(!res?.block, JSON.stringify(res));
    assert.equal(r.classifier(), 1, "class opaque: the classifier decided");
    assert.equal(r.dialogs(), 0);
    assert.doesNotMatch(JSON.stringify(r.c.trace()), GUARD);
  });

  test(`${kind}: with safety.git.commit.messagePattern set to a pattern the message violates, git commit -m gets the decision it gets with the key unset`, { skip: !posix }, async (t: T) => {
    const commit = { command: 'git commit -m "anything"' };
    const plain = await rig(t, kind);
    const before = await plain.c.call("bash", commit);
    const set = await rig(t, kind, { config: { safety: { git: { commit: { messagePattern: "^feat: [a-z]+$", requiredTrailers: ["Signed-off-by"], forbiddenTrailers: ["Co-authored-by"], checkCommand: "false" } } } } });
    const after = await set.c.call("bash", commit);
    assert.ok(!before?.block, JSON.stringify(before));
    assert.deepEqual(after, before);
    assert.equal(set.dialogs(), plain.dialogs());
    assert.equal(set.classifier(), plain.classifier());
  });
}

const heredoc = (target: string) => `cat > ${target.replaceAll("\\", "/")} <<'EOF'\nbuilt\nEOF`;

test("child heredoc drop, both ways: a heredoc write inside the child's own worktree runs with no dialog and no block", { skip: !posix }, async (t: T) => {
  const r = await rig(t, "child");
  r.setCheckout();
  const res = await r.c.call("bash", { command: heredoc(path.join(r.c.project, "heredoc.txt")) });
  assert.ok(!res?.block, JSON.stringify(res));
  assert.equal(r.dialogs(), 0);
});

test("child heredoc drop, both ways: the same write into the main checkout is floored child-write-foreman-checkout", { skip: !posix }, async (t: T) => {
  const r = await rig(t, "child");
  r.setCheckout();
  const res = await r.c.call("bash", { command: heredoc(path.join(r.checkout, "heredoc.txt")) });
  assert.ok(res?.block, JSON.stringify(res));
  assert.match(String(res.reason), /child-write-foreman-checkout/);
  assert.equal(r.dialogs(), 0);
});

test("child heredoc drop, both ways: the same write to a path outside every checkout is floored child-write-outside", { skip: !posix }, async (t: T) => {
  const r = await rig(t, "child");
  r.setCheckout();
  const res = await r.c.call("bash", { command: heredoc(path.join(r.c.project, "..", "elsewhere", "heredoc.txt")) });
  assert.ok(res?.block, JSON.stringify(res));
  assert.match(String(res.reason), /child-write-outside/);
  assert.equal(r.dialogs(), 0);
});
