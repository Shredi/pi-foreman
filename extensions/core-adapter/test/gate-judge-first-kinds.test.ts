// PR C: one representative line per kind of the judge-first list (defaults.ts JUDGE_FIRST). A hit goes to the judge; clear runs; unsure opens the owner dialog
// (foreman) or is refused/asked of the parent (child). Lines of the kinds PR C removed run with no judge call.
import { test } from "node:test";
import assert from "node:assert/strict";
import { r11Rig } from "./_r11rig.ts";

const V = (verdict: string): string => JSON.stringify({ verdict, reason: "because test" });
// presence off: an owner dialog awaits the presence probe's detached child, which keeps no event loop alive in a bare test process
const config = { providers: { fake: { roles: { review: { model: "m" } } } }, presence: { enabled: false } };

async function rig(t: Parameters<typeof r11Rig>[0], verdict: string, o: { child?: boolean; selects?: string[] } = {}) {
  const calls: string[] = [];
  const registry = {
    find: () => ({ id: "m" }),
    getProviderAuthStatus: () => ({ configured: false }),
    complete: async (_m: never, ctx: { messages: { content: string }[] }) => {
      calls.push(ctx.messages[0].content);
      return { content: [{ type: "text", text: V(verdict) }], stopReason: "stop", usage: { input: 1, output: 1 } };
    },
  };
  const asked: { title: string; options: string[] }[] = [];
  const answers = [...(o.selects ?? [])];
  const ui = {
    notify: () => undefined,
    confirm: async () => false,
    select: async (title: string, options: string[]) => (asked.push({ title, options }), answers.shift()),
    input: async () => "",
    editor: async () => undefined,
    setStatus: () => undefined,
    setWidget: () => undefined,
  };
  const r = await r11Rig(t, {}, { ctx: { modelRegistry: registry, ui, hasUI: true }, config, child: o.child });
  return { ...r, calls, asked };
}

// kind -> [representative line, runs for the foreman too]
const KINDS: [string, string, boolean][] = [
  ["danger-git", "git branch -D old-topic", true],
  ["danger-inject", "herdr pane send-keys 1-2 Enter", true],
  ["danger-delete-unknown-target", "rm -rf $BUILD_DIR", false], // the foreman's shell write is refused before the judge
  ["danger-write-outside", "echo x | tee $HOME/f", false], // a child-only kind here: the foreman's shell write is ruled elsewhere
];

for (const [kind, line, foreman] of KINDS) {
  for (const child of foreman ? [false, true] : [true]) {
    const who = child ? "child" : "foreman";
    test(`${kind} (${who}): a hit calls the judge; clear runs the line`, async (t) => {
      const r = await rig(t, "clear", { child });
      assert.equal(await r.call("bash", { command: line }), undefined);
      assert.equal(r.calls.length, 1);
      assert.equal(r.asked.length, 0);
    });

    test(`${kind} (${who}): unsure ${child ? "is refused or asked of the parent, never the owner dialog" : "opens the owner dialog"}`, async (t) => {
      const r = await rig(t, "unsure", { child, selects: ["deny with comment"] });
      const res = await r.call("bash", { command: line });
      assert.equal(r.calls.length, 1);
      assert.equal(res?.block, true);
      if (child) assert.equal(r.asked.length, 0);
      else {
        assert.equal(r.asked.length, 1);
        assert.match(r.asked[0].title, new RegExp(`cause: ${kind}`));
      }
    });
  }
}

test("kinds PR C removed run with no judge call: an install, a pull request merge, an opaque line", async (t) => {
  for (const child of [false, true]) {
    const r = await rig(t, "unsure", { child });
    for (const line of ["pip install x", "gh pr merge 1", "$(echo ls) -la"]) {
      await r.call("bash", { command: line });
      assert.equal(r.calls.length, 0, `${child ? "child" : "foreman"}: ${line}`);
      assert.equal(r.asked.length, 0, line);
    }
  }
});
